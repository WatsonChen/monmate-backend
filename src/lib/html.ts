import sanitizeHtml from "sanitize-html";

// 把純文字放進 HTML（Email 範本、屬性值）前一律跳脫，避免使用者輸入的標籤被當成 HTML。
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

// 活動說明是主辦方用編輯器寫的 HTML，會顯示在公開頁面上，所以必須用白名單淨化：
// 只保留編輯器實際會產生的格式標籤，移除 script、事件屬性（onerror 等）、javascript: 連結與其他危險內容。
const EVENT_CONTENT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "div", "span", "b", "strong", "i", "em", "u",
    "ul", "ol", "li", "h1", "h2", "h3", "h4", "blockquote", "hr", "a", "img"
  ],
  allowedAttributes: {
    a: ["href", "target", "rel"],
    img: ["src", "alt", "style"],
    span: ["style"]
  },
  // 連結只允許 http(s)、mailto、tel；圖片只允許 http(s)（不收 data: 與 javascript:）
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https"] },
  allowProtocolRelative: false,
  allowedStyles: {
    img: {
      "max-width": [/^\d+(\.\d+)?(px|%|em|rem)$/],
      "border-radius": [/^\d+(\.\d+)?(px|%|em|rem)$/],
      margin: [/^[\d.\s]+(px|%|em|rem)?(\s+[\d.]+(px|%|em|rem)?){0,3}$/]
    },
    span: {
      "font-weight": [/^(bold|normal|[1-9]00)$/],
      "font-style": [/^(italic|normal)$/],
      "text-decoration": [/^(underline|none)$/]
    }
  },
  transformTags: {
    // 外部連結一律新分頁開啟，並切斷 opener
    a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer nofollow" })
  },
  // script/style 等的「內容」也一併丟棄，而不是只拿掉標籤
  disallowedTagsMode: "discard"
};

export function sanitizeEventContent(html: string): string;
export function sanitizeEventContent(html: string | null | undefined): string | null;
export function sanitizeEventContent(html: string | null | undefined): string | null {
  if (html == null) return null;
  return sanitizeHtml(html, EVENT_CONTENT_OPTIONS);
}
