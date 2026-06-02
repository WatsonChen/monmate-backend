export function getPhoneLastThree(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.slice(-3).padStart(Math.min(3, digits.length), "*");
}

export function toCsvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function createSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}
