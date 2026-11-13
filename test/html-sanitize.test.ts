import { describe, expect, it } from "vitest";
import { escapeHtml, sanitizeEventContent } from "../src/lib/html.js";

describe("sanitizeEventContent：活動說明 HTML 淨化", () => {
  it("移除 script 標籤與其內容", () => {
    const out = sanitizeEventContent("<p>hi</p><script>alert(1)</script>");
    expect(out).toBe("<p>hi</p>");
  });

  it("移除事件屬性（onerror、onclick 等）", () => {
    const out = sanitizeEventContent('<img src="https://x.test/a.png" onerror="alert(1)"><a href="https://x.test" onclick="alert(1)">x</a>')!;
    expect(out).not.toMatch(/onerror|onclick|alert/i);
    expect(out).toContain('src="https://x.test/a.png"');
  });

  it("拒絕 javascript: 與 data: 網址", () => {
    const out = sanitizeEventContent(
      '<a href="javascript:alert(1)">a</a><a href=" JaVaScRiPt:alert(1)">b</a><img src="javascript:alert(1)"><img src="data:image/svg+xml;base64,PHN2Zz4=">'
    )!;
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/data:/i);
  });

  it("移除 iframe、object、embed、form、style、svg", () => {
    const out = sanitizeEventContent(
      '<iframe src="https://evil.test"></iframe><object data="x"></object><embed src="x"><form action="https://evil.test"><input></form><style>body{display:none}</style><svg onload="alert(1)"></svg>ok'
    )!;
    expect(out).toBe("ok");
  });

  it("移除危險的 style 內容，只保留圖片的安全樣式", () => {
    const out = sanitizeEventContent(
      '<img src="https://x.test/a.png" style="max-width:100%;border-radius:8px;margin:8px 0;background:url(javascript:alert(1));position:fixed">'
    )!;
    expect(out).toContain("max-width:100%");
    expect(out).toContain("border-radius:8px");
    expect(out).not.toMatch(/position|background|javascript/i);
  });

  it("外部連結加上 noopener 並以新分頁開啟", () => {
    const out = sanitizeEventContent('<a href="https://example.com">x</a>')!;
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('target="_blank"');
  });

  it("保留編輯器產生的一般格式", () => {
    const html =
      '<div>第一行<br></div><div><b>粗</b><i>斜</i><u>底線</u></div><ul><li>a</li></ul><a href="mailto:a@b.test">信</a>';
    const out = sanitizeEventContent(html)!;
    expect(out).toContain("<b>粗</b>");
    expect(out).toContain("<i>斜</i>");
    expect(out).toContain("<u>底線</u>");
    expect(out).toContain("<ul><li>a</li></ul>");
    expect(out).toContain('href="mailto:a@b.test"');
  });

  it("null 與空字串", () => {
    expect(sanitizeEventContent(null)).toBeNull();
    expect(sanitizeEventContent(undefined)).toBeNull();
    expect(sanitizeEventContent("")).toBe("");
  });

  it("多次淨化結果不變（冪等）", () => {
    const once = sanitizeEventContent('<div><b>x</b><img src="https://x.test/a.png" style="max-width:100%"></div><script>1</script>')!;
    expect(sanitizeEventContent(once)).toBe(once);
  });
});

describe("escapeHtml：Email 範本的使用者輸入跳脫", () => {
  it("跳脫標籤與引號", () => {
    expect(escapeHtml('<img src=x onerror="a">\'&')).toBe("&lt;img src=x onerror=&quot;a&quot;&gt;&#39;&amp;");
  });
  it("null 與數字", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(100)).toBe("100");
  });
});
