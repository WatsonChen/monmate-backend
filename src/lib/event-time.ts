const DAY_MS = 24 * 60 * 60 * 1000;
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 活動是否已經結束：
 * - 有設定結束時間：超過結束時間就算結束
 * - 沒設定結束時間：開始當天（台灣時間）過完就算結束
 */
export function isEventEnded(event: { startAt: Date; endAt: Date | null }, now: Date = new Date()): boolean {
  if (event.endAt) return now.getTime() > event.endAt.getTime();
  const startOfStartDay = Math.floor((event.startAt.getTime() + TAIPEI_OFFSET_MS) / DAY_MS) * DAY_MS - TAIPEI_OFFSET_MS;
  return now.getTime() >= startOfStartDay + DAY_MS;
}
