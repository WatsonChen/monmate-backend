export function getPhoneLastThree(phone) {
  const digits = phone.replace(/\D/g, "");
  return digits.slice(-3).padStart(Math.min(3, digits.length), "*");
}

export function toCsvCell(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function createSlug(input) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}
