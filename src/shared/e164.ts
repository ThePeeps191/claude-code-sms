/**
 * Minimal E.164 normalization. We deliberately avoid a full libphonenumber:
 * - "+<digits>" is kept as-is (validated for length).
 * - 10 digits with no country code are assumed to be NANP (+1), the most common case.
 * - "1" + 10 digits is NANP.
 * - "00<digits>" (international prefix) becomes "+<digits>".
 * Anything else must be entered with a leading "+".
 */
export function normalizeE164(input: string, defaultCountryCode = "1"): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const hasPlus = trimmed.startsWith("+");
  let digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return null;
  if (hasPlus) return validLength(digits) ? `+${digits}` : null;
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
    return validLength(digits) ? `+${digits}` : null;
  }
  if (defaultCountryCode === "1") {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return null;
  }
  return validLength(defaultCountryCode + digits) ? `+${defaultCountryCode}${digits}` : null;
}

function validLength(d: string): boolean {
  return d.length >= 8 && d.length <= 15 && !d.startsWith("0");
}

export function isE164(s: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(s);
}

/** "+12125550123" -> "...0123" for logs/UI. Never log full numbers at info level. */
export function maskNumber(n: string): string {
  return n.length > 4 ? `...${n.slice(-4)}` : n;
}
