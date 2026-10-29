// 姓名／電話比對用的正規化；全專案共用，避免各處規則不一致
export const normalizeName = (v: string) => v.normalize("NFKC").trim().replace(/\s+/g, " ");
export const normalizePhone = (v: string) => v.normalize("NFKC").replace(/[\s\-()（）]/g, "");

// 對公開端只顯示遮罩後的姓名，例如「王小明」→「王○明」
export function maskName(name: string) {
  const chars = Array.from(name.trim());
  if (chars.length <= 1) return name;
  if (chars.length === 2) return `${chars[0]}○`;
  return `${chars[0]}${"○".repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}
