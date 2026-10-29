import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { attendeeService } from "../src/services/attendee.service.js";
import { importService, parseImportFile } from "../src/services/import.service.js";
import {
  HEADER, balanceOf, createEvent, createOwner, people, previewOf, resetDb, runImport, xlsxBuffer
} from "./helpers.js";
import { requireEventOwner } from "../src/middlewares/event-access.js";

beforeEach(resetDb);
afterAll(async () => {
  await prisma.$disconnect();
});

const count = (eventId: string) => prisma.attendee.count({ where: { eventId } });
const ledger = (userId: string) => prisma.creditTransaction.count({ where: { userId } });

describe("預覽與錢包邊界", () => {
  it("餘額 2 匯入 4 位新參加者：預覽顯示 -2，確認後 -2", async () => {
    const owner = await createOwner(2);
    const event = await createEvent(owner.id);
    const { preview, outcome } = await runImport(event.id, owner.id, [HEADER, ...people(4)]);
    expect(preview.wallet).toMatchObject({ balance: 2, balanceAfter: -2, needsTopUp: false });
    expect(outcome.status).toBe("CONFIRMED");
    expect(await balanceOf(owner.id)).toBe(-2);
  });

  it("餘額 0 匯入 3 位：剛好 -3 允許", async () => {
    const owner = await createOwner(0);
    const event = await createEvent(owner.id);
    await runImport(event.id, owner.id, [HEADER, ...people(3)]);
    expect(await balanceOf(owner.id)).toBe(-3);
  });

  it("餘額 0 匯入 100 位：預覽要求儲值並給出缺口；儲值後用同一份預覽接續，不必重新上傳", async () => {
    const owner = await createOwner(0);
    const event = await createEvent(owner.id);
    const preview = await previewOf(event.id, owner.id, [HEADER, ...people(100)]);
    expect(preview.wallet).toMatchObject({ balanceAfter: -100, needsTopUp: true, minTopUp: 97 });

    await expect(
      importService.confirm(event.id, owner.id, preview.sessionId, { expectedCost: 100 })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ATTENDEE_CREDITS", details: { required: 100, floor: -3 } });
    expect(await count(event.id)).toBe(0);
    expect(await ledger(owner.id)).toBe(0);
    // 失敗後作業仍可繼續
    const again = await importService.getPreview(event.id, owner.id, preview.sessionId);
    expect(again.status).toBe("PREVIEW");

    await prisma.user.update({ where: { id: owner.id }, data: { attendeeCredits: { increment: 199 } } });
    const done = await importService.confirm(event.id, owner.id, preview.sessionId, { expectedCost: 100 });
    expect(done.status).toBe("CONFIRMED");
    expect(await count(event.id)).toBe(100);
    expect(await balanceOf(owner.id)).toBe(99);
    expect(await ledger(owner.id)).toBe(1);
  });

  it("餘額 -3 重傳全部重複的名單：不扣點、不要求儲值", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    await runImport(event.id, owner.id, [HEADER, ...people(10)]);
    await prisma.user.update({ where: { id: owner.id }, data: { attendeeCredits: -3 } });

    const { preview, outcome } = await runImport(event.id, owner.id, [HEADER, ...people(10)]);
    expect(preview.billableHeadcount).toBe(0);
    expect(preview.wallet.needsTopUp).toBe(false);
    expect(preview.counts.unchanged).toBe(10);
    expect(outcome.status).toBe("CONFIRMED");
    expect(await balanceOf(owner.id)).toBe(-3);
    expect(await count(event.id)).toBe(10);
  });
});

describe("去重與計費", () => {
  it("相同內容、不同檔名：不新增、不扣點，並提示先前已匯入", async () => {
    const owner = await createOwner(500);
    const event = await createEvent(owner.id);
    await runImport(event.id, owner.id, [HEADER, ...people(11)], "11.xlsx");
    const before = await balanceOf(owner.id);
    const { preview } = await runImport(event.id, owner.id, [HEADER, ...people(11)], "11-2.xlsx");
    expect(preview.previouslyImported).toBe(true);
    expect(preview.counts.toCreate).toBe(0);
    expect(await count(event.id)).toBe(11);
    expect(await balanceOf(owner.id)).toBe(before);
  });

  it("同一批人只改排列順序：不新增、不扣點", async () => {
    const owner = await createOwner(500);
    const event = await createEvent(owner.id);
    const list = people(20);
    await runImport(event.id, owner.id, [HEADER, ...list]);
    const before = await balanceOf(owner.id);
    const { preview } = await runImport(event.id, owner.id, [HEADER, ...[...list].reverse()]);
    expect(preview.billableHeadcount).toBe(0);
    expect(await count(event.id)).toBe(20);
    expect(await balanceOf(owner.id)).toBe(before);
  });

  it("原 100 人加 5 位新參加者：只新增並計費這 5 人", async () => {
    const owner = await createOwner(1000);
    const event = await createEvent(owner.id);
    await runImport(event.id, owner.id, [HEADER, ...people(100)]);
    const before = await balanceOf(owner.id);
    const { preview } = await runImport(event.id, owner.id, [HEADER, ...people(105)]);
    expect(preview.counts).toMatchObject({ toCreate: 5, unchanged: 100 });
    expect(preview.billableHeadcount).toBe(5);
    expect(await count(event.id)).toBe(105);
    expect(await balanceOf(owner.id)).toBe(before - 5);
  });

  it("以報名編號配對、只改姓名／備註：視為更新不收費，且不動報到狀態", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    await runImport(event.id, owner.id, [HEADER, ...people(3)]);
    const target = await prisma.attendee.findFirstOrThrow({ where: { eventId: event.id }, orderBy: { name: "asc" } });
    await prisma.attendee.update({
      where: { id: target.id },
      data: { checkInStatus: "CHECKED_IN", checkInCount: 1, checkedInAt: new Date("2026-01-01T00:00:00Z") }
    });
    const before = await balanceOf(owner.id);

    const { preview } = await runImport(event.id, owner.id, [
      ["報名編號", "姓名", "電話", "備註"],
      [target.id, "改過的名字", target.phone, "VIP"]
    ]);
    expect(preview.counts.toUpdate).toBe(1);
    expect(preview.billableHeadcount).toBe(0);
    const after = await prisma.attendee.findUniqueOrThrow({ where: { id: target.id } });
    expect(after).toMatchObject({ name: "改過的名字", note: "VIP", checkInStatus: "CHECKED_IN", checkInCount: 1 });
    expect(after.checkedInAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(await balanceOf(owner.id)).toBe(before);
    expect(await count(event.id)).toBe(3);
  });

  it("攜伴增加：依增量計費；調低不改也不退", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    await runImport(event.id, owner.id, [["姓名", "電話", "報名人數"], ["小明", "0911000001", 1]]);
    const before = await balanceOf(owner.id);

    const up = await runImport(event.id, owner.id, [["姓名", "電話", "報名人數"], ["小明", "0911000001", 3]]);
    expect(up.preview.billableHeadcount).toBe(2);
    expect(await balanceOf(owner.id)).toBe(before - 2);
    expect((await prisma.attendee.findFirstOrThrow({ where: { eventId: event.id } })).checkInCapacity).toBe(3);

    const down = await runImport(event.id, owner.id, [["姓名", "電話", "報名人數"], ["小明", "0911000001", 1]]);
    expect(down.preview.billableHeadcount).toBe(0);
    expect((await prisma.attendee.findFirstOrThrow({ where: { eventId: event.id } })).checkInCapacity).toBe(3);
    expect(await balanceOf(owner.id)).toBe(before - 2);
  });

  it("攜伴人數欄：n 位攜伴 = n+1 人", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    const { preview } = await runImport(event.id, owner.id, [["姓名", "電話", "攜伴人數"], ["A", "0911000001", 2]]);
    expect(preview.billableHeadcount).toBe(3);
  });

  it("同檔案內的重複列只算一次", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    const { preview } = await runImport(event.id, owner.id, [
      HEADER, ["王小明", "0912-345-678"], ["王小明", "0912345678"], ["李大華", "0922000000"]
    ]);
    expect(preview.counts).toMatchObject({ toCreate: 2, duplicateInFile: 1 });
    expect(await count(event.id)).toBe(2);
    expect(await balanceOf(owner.id)).toBe(98);
  });

  it("相同電話但不同姓名：標為疑似重複，不自動合併、不自動計費", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    await runImport(event.id, owner.id, [HEADER, ["家長", "0933000000"]]);
    const before = await balanceOf(owner.id);

    const preview = await previewOf(event.id, owner.id, [HEADER, ["孩子", "0933000000"]]);
    expect(preview.counts.suspectPending).toBe(1);
    expect(preview.costIsFinal).toBe(false);
    expect(preview.suspects[0].candidates).toHaveLength(1);
    await expect(
      importService.confirm(event.id, owner.id, preview.sessionId, { expectedCost: 1 })
    ).rejects.toMatchObject({ code: "NEEDS_DECISIONS" });
    expect(await count(event.id)).toBe(1);
    expect(await balanceOf(owner.id)).toBe(before);

    // 使用者選「視為不同人」才新增並計費
    const decided = await importService.setDecisions(event.id, owner.id, preview.sessionId, { bulk: "ALL_NEW" });
    expect(decided.costIsFinal).toBe(true);
    expect(decided.suspects[0].decision).toEqual({ action: "NEW" }); // 做完決定後仍列在清單，可回頭改選
    expect(decided.billableHeadcount).toBe(1);
    await importService.confirm(event.id, owner.id, preview.sessionId, { expectedCost: 1 });
    expect(await count(event.id)).toBe(2);
    expect(await balanceOf(owner.id)).toBe(before - 1);
  });

  it("疑似重複選「更新既有」只更新該筆、選「略過」不動", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    await runImport(event.id, owner.id, [HEADER, ["家長", "0933000000"]]);
    const existing = await prisma.attendee.findFirstOrThrow({ where: { eventId: event.id } });

    const p1 = await previewOf(event.id, owner.id, [HEADER, ["家長（改）", "0933000000"]]);
    await importService.setDecisions(event.id, owner.id, p1.sessionId, {
      decisions: { "2": { action: "UPDATE", targetId: existing.id } }
    });
    await importService.confirm(event.id, owner.id, p1.sessionId, { expectedCost: 0 });
    expect((await prisma.attendee.findUniqueOrThrow({ where: { id: existing.id } })).name).toBe("家長（改）");

    const p2 = await previewOf(event.id, owner.id, [HEADER, ["另一個人", "0933000000"]]);
    await importService.setDecisions(event.id, owner.id, p2.sessionId, { bulk: "ALL_SKIP" });
    await importService.confirm(event.id, owner.id, p2.sessionId, { expectedCost: 0 });
    expect(await count(event.id)).toBe(1);
  });

  it("只有 Email 相同不會被視為同一人", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    await runImport(event.id, owner.id, [["姓名", "電話", "Email"], ["甲", "0911", "same@x.com"]]);
    const { preview } = await runImport(event.id, owner.id, [["姓名", "電話", "Email"], ["乙", "0922", "same@x.com"]]);
    expect(preview.counts.toCreate).toBe(1);
    expect(await count(event.id)).toBe(2);
  });

  it("新版檔案少了部分既有名單：不自動刪除", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    await runImport(event.id, owner.id, [HEADER, ...people(10)]);
    await runImport(event.id, owner.id, [HEADER, ...people(3)]);
    expect(await count(event.id)).toBe(10);
  });

  it("同名單匯入另一場活動：依該活動實際新增人數計費，他活動的報名編號被忽略並提示", async () => {
    const owner = await createOwner(100);
    const e1 = await createEvent(owner.id);
    const e2 = await createEvent(owner.id);
    await runImport(e1.id, owner.id, [HEADER, ...people(5)]);
    const exported = await attendeeService.exportXlsx(e1.id);
    const before = await balanceOf(owner.id);

    const preview = await importService.createPreview(e2.id, owner.id, "from-e1.xlsx", exported);
    expect(preview.counts.toCreate).toBe(5);
    expect(preview.billableHeadcount).toBe(5);
    expect(preview.warnings.join()).toContain("不屬於本活動");
    await importService.confirm(e2.id, owner.id, preview.sessionId, { expectedCost: 5 });
    expect(await count(e2.id)).toBe(5);
    expect(await balanceOf(owner.id)).toBe(before - 5);
    // 沒有任何一筆指到活動 1 的紀錄
    expect(await count(e1.id)).toBe(5);
  });

  it("匯出檔原樣重新匯入：全部視為完全重複，不產生自訂欄位", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    await runImport(event.id, owner.id, [HEADER, ...people(6)]);
    const exported = await attendeeService.exportXlsx(event.id);
    const before = await balanceOf(owner.id);
    const preview = await importService.createPreview(event.id, owner.id, "export.xlsx", exported);
    expect(preview.counts).toMatchObject({ unchanged: 6, toUpdate: 0, toCreate: 0 });
    await importService.confirm(event.id, owner.id, preview.sessionId, { expectedCost: 0 });
    expect(await balanceOf(owner.id)).toBe(before);
    const any = await prisma.attendee.findFirstOrThrow({ where: { eventId: event.id } });
    expect(any.customFields).toBeNull();
  });
});

describe("防重、並行與失敗", () => {
  it("雙擊／逾時重送同一確認：只新增一次、只扣一次，兩次都回成功", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    const preview = await previewOf(event.id, owner.id, [HEADER, ...people(10)]);
    const [a, b] = await Promise.all([
      importService.confirm(event.id, owner.id, preview.sessionId, { expectedCost: 10 }),
      importService.confirm(event.id, owner.id, preview.sessionId, { expectedCost: 10 })
    ]);
    expect([a.status, b.status]).toEqual(["CONFIRMED", "CONFIRMED"]);
    expect([a, b].filter((r) => "alreadyConfirmed" in r && r.alreadyConfirmed)).toHaveLength(1);
    expect(await count(event.id)).toBe(10);
    expect(await balanceOf(owner.id)).toBe(90);
    expect(await ledger(owner.id)).toBe(1);
    // 事後再重送也一樣
    const c = await importService.confirm(event.id, owner.id, preview.sessionId, { expectedCost: 10 });
    expect("alreadyConfirmed" in c && c.alreadyConfirmed).toBe(true);
    expect(await balanceOf(owner.id)).toBe(90);
  });

  it("兩個不同匯入作業含相同名單並行確認：不會重複新增或重複扣點", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    const rows = [HEADER, ...people(8)];
    const p1 = await previewOf(event.id, owner.id, rows, "a.xlsx");
    const p2 = await previewOf(event.id, owner.id, rows, "b.xlsx");
    const results = await Promise.allSettled([
      importService.confirm(event.id, owner.id, p1.sessionId, { expectedCost: 8 }),
      importService.confirm(event.id, owner.id, p2.sessionId, { expectedCost: 8 })
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await count(event.id)).toBe(8);
    expect(await balanceOf(owner.id)).toBe(92);
  });

  it("兩個並行匯入各需 3 點：同一錢包不會突破 -3，只有一個成功", async () => {
    const owner = await createOwner(0);
    const e1 = await createEvent(owner.id);
    const e2 = await createEvent(owner.id);
    const p1 = await previewOf(e1.id, owner.id, [HEADER, ...people(3, "A")]);
    const p2 = await previewOf(e2.id, owner.id, [HEADER, ...people(3, "B")]);
    const results = await Promise.allSettled([
      importService.confirm(e1.id, owner.id, p1.sessionId, { expectedCost: 3 }),
      importService.confirm(e2.id, owner.id, p2.sessionId, { expectedCost: 3 })
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await balanceOf(owner.id)).toBe(-3);
    expect((await count(e1.id)) + (await count(e2.id))).toBe(3);
  });

  it("預覽後名單改變使費用增加：不自動執行，回傳新預覽，不寫入", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    await runImport(event.id, owner.id, [HEADER, ...people(3)]);
    const preview = await previewOf(event.id, owner.id, [HEADER, ...people(3)]);
    expect(preview.billableHeadcount).toBe(0);
    await prisma.attendee.deleteMany({ where: { eventId: event.id, name: "P0" } }); // 模擬預覽後名單變動
    const before = await balanceOf(owner.id);

    const out = await importService.confirm(event.id, owner.id, preview.sessionId, { expectedCost: 0 });
    expect(out.status).toBe("CHANGED");
    if (out.status === "CHANGED") expect(out.preview.billableHeadcount).toBe(1);
    expect(await count(event.id)).toBe(2);
    expect(await balanceOf(owner.id)).toBe(before);

    // 使用者看過新費用後再確認才執行
    const done = await importService.confirm(event.id, owner.id, preview.sessionId, { expectedCost: 1 });
    expect(done.status).toBe("CONFIRMED");
    expect(await balanceOf(owner.id)).toBe(before - 1);
  });

  it("預覽後餘額被用掉：確認時重新驗證餘額，失敗不留半套資料", async () => {
    const owner = await createOwner(5);
    const event = await createEvent(owner.id);
    const preview = await previewOf(event.id, owner.id, [HEADER, ...people(5)]);
    await prisma.user.update({ where: { id: owner.id }, data: { attendeeCredits: -3 } });
    await expect(
      importService.confirm(event.id, owner.id, preview.sessionId, { expectedCost: 5 })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ATTENDEE_CREDITS" });
    expect(await count(event.id)).toBe(0);
    expect(await ledger(owner.id)).toBe(0);
    expect(await balanceOf(owner.id)).toBe(-3);
    const s = await prisma.importSession.findUniqueOrThrow({ where: { id: preview.sessionId } });
    expect(s.status).toBe("PREVIEW");
  });

  it("新增成功後、更新步驟失敗：整批回滾，沒有半套名單、沒有錯誤扣點", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    await runImport(event.id, owner.id, [HEADER, ["既有", "0911000000"]]);
    const before = await balanceOf(owner.id);
    // 新增 2 人（createMany 會先成功），再更新既有那筆的年齡；年齡超出 INT4 讓更新在資料庫端失敗
    const preview = await previewOf(event.id, owner.id, [
      ["姓名", "電話", "年齡"], ["新1", "0922000001", 20], ["新2", "0922000002", 21], ["既有", "0911000000", 99999999999]
    ]);
    expect(preview.counts).toMatchObject({ toCreate: 2, toUpdate: 1 });
    await expect(
      importService.confirm(event.id, owner.id, preview.sessionId, { expectedCost: 2 })
    ).rejects.toThrow(/INT4|integer/i);
    expect(await count(event.id)).toBe(1);
    expect(await balanceOf(owner.id)).toBe(before);
    expect(await ledger(owner.id)).toBe(1); // 只有第一次匯入的那一筆
    const s = await prisma.importSession.findUniqueOrThrow({ where: { id: preview.sessionId } });
    expect(s.status).toBe("PREVIEW");
  });
});

describe("解析與錯誤列", () => {
  it("CSV 的電話保留開頭的 0", () => {
    const csv = Buffer.from("\uFEFF姓名,電話,報名人數\n王小明,0912345678,2\n", "utf8");
    const { rows } = parseImportFile(csv);
    expect(rows[0]).toMatchObject({ name: "王小明", phone: "0912345678", capacity: 2 });
  });

  it("錯誤列標示列號、欄位與原因，其他列不受影響", () => {
    const { rows, errors, totalRows } = parseImportFile(
      xlsxBuffer([["姓名", "電話", "報名人數"], ["A", "0911", 1], ["", "0922", 1], ["C", "", 1], ["D", "0944", "abc"]])
    );
    expect(totalRows).toBe(4);
    expect(rows).toHaveLength(1);
    expect(errors).toEqual([
      { rowNumber: 3, field: "姓名", reason: "姓名不能空白" },
      { rowNumber: 4, field: "電話", reason: "電話不能空白" },
      { rowNumber: 5, field: "報名人數", reason: "人數需為 1 以上的整數" }
    ]);
  });

  it("缺少必要欄位時拒絕", () => {
    expect(() => parseImportFile(xlsxBuffer([["姓名"], ["A"]]))).toThrowError(/姓名.*電話/);
  });
});

describe("權限", () => {
  it("非活動擁有者不能預覽、確認或查看他人活動的匯入，也不會動到他人錢包", async () => {
    const owner = await createOwner(50);
    const other = await createOwner(50);
    const event = await createEvent(owner.id);

    await expect(previewOf(event.id, other.id, [HEADER, ...people(2)])).rejects.toMatchObject({ statusCode: 404 });

    const preview = await previewOf(event.id, owner.id, [HEADER, ...people(2)]);
    await expect(importService.getPreview(event.id, other.id, preview.sessionId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      importService.confirm(event.id, other.id, preview.sessionId, { expectedCost: 2 })
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(importService.listHistory(event.id, other.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await balanceOf(owner.id)).toBe(50);
    expect(await balanceOf(other.id)).toBe(50);
    expect(await count(event.id)).toBe(0);
  });

  it("requireEventOwner 中介層：他人回 404，擁有者放行", async () => {
    const owner = await createOwner(0);
    const other = await createOwner(0);
    const event = await createEvent(owner.id);
    const run = (userId: string) =>
      new Promise<unknown>((resolve) => {
        const req = { user: { id: userId, role: "ADMIN" }, params: { eventId: event.id } } as never;
        requireEventOwner(req, {} as never, (err?: unknown) => resolve(err));
      });
    expect(await run(owner.id)).toBeUndefined();
    expect(await run(other.id)).toMatchObject({ statusCode: 404, code: "EVENT_NOT_FOUND" });
  });
});

describe("暫存清理與歷史", () => {
  it("確認後清空暫存名單、保留結果摘要；過期的預覽會被清除", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    const { preview } = await runImport(event.id, owner.id, [HEADER, ...people(2)]);
    const done = await prisma.importSession.findUniqueOrThrow({ where: { id: preview.sessionId } });
    expect(done.rows).toEqual([]);
    expect(done.result).toMatchObject({ created: 2, billedHeadcount: 2 });
    const history = await importService.listHistory(event.id, owner.id);
    expect(history).toHaveLength(1);

    const stale = await previewOf(event.id, owner.id, [HEADER, ...people(1, "Z")]);
    await prisma.importSession.update({ where: { id: stale.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await previewOf(event.id, owner.id, [HEADER, ...people(1, "Y")]); // 建立新作業時順便清除過期
    expect(await prisma.importSession.count({ where: { id: stale.sessionId } })).toBe(0);
  });
});

describe("取消預覽：立即刪除暫存資料", () => {
  it("取消後暫存名單整筆刪除，不新增名單、不扣點；再次取消不報錯；之後讀取與確認都找不到", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    const preview = await previewOf(event.id, owner.id, [HEADER, ...people(3)]);

    expect(await importService.discard(event.id, owner.id, preview.sessionId)).toEqual({ discarded: true });
    expect(await prisma.importSession.count({ where: { id: preview.sessionId } })).toBe(0);
    expect(await count(event.id)).toBe(0);
    expect(await balanceOf(owner.id)).toBe(100);
    expect(await ledger(owner.id)).toBe(0);

    expect(await importService.discard(event.id, owner.id, preview.sessionId)).toEqual({ discarded: false });
    await expect(importService.getPreview(event.id, owner.id, preview.sessionId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      importService.confirm(event.id, owner.id, preview.sessionId, { expectedCost: 3 })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("已確認的匯入不會被刪除，歷史摘要保留", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    const { preview } = await runImport(event.id, owner.id, [HEADER, ...people(2)]);
    expect(await importService.discard(event.id, owner.id, preview.sessionId)).toEqual({ discarded: false });
    expect(await importService.listHistory(event.id, owner.id)).toHaveLength(1);
  });

  it("他人不能取消你的預覽，預覽仍然存在", async () => {
    const owner = await createOwner(100);
    const other = await createOwner(100);
    const event = await createEvent(owner.id);
    const preview = await previewOf(event.id, owner.id, [HEADER, ...people(2)]);
    await expect(importService.discard(event.id, other.id, preview.sessionId)).rejects.toBeTruthy();
    expect(await prisma.importSession.count({ where: { id: preview.sessionId } })).toBe(1);
  });

  it("取消與確認同時發生：結果一致，不會出現已匯入卻被刪掉紀錄，或兩者都成功", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    const preview = await previewOf(event.id, owner.id, [HEADER, ...people(3)]);
    const [d, c] = await Promise.allSettled([
      importService.discard(event.id, owner.id, preview.sessionId),
      importService.confirm(event.id, owner.id, preview.sessionId, { expectedCost: 3 })
    ]);
    const discarded = d.status === "fulfilled" && d.value.discarded;
    const confirmed = c.status === "fulfilled";
    expect(discarded && confirmed).toBe(false);
    if (confirmed) {
      expect(await count(event.id)).toBe(3);
      expect(await balanceOf(owner.id)).toBe(97);
      expect(await prisma.importSession.count({ where: { id: preview.sessionId, status: "CONFIRMED" } })).toBe(1);
    } else {
      expect(await count(event.id)).toBe(0);
      expect(await balanceOf(owner.id)).toBe(100);
      expect(await prisma.importSession.count({ where: { id: preview.sessionId } })).toBe(0);
    }
  });
});
