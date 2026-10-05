/**
 * Normalizes a phone number to the digits-only international format the Cloud API expects.
 * Accepts "+55 (21) 99999-8888", "5521999998888", etc.
 */
export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    throw new Error(
      `Invalid phone number "${input}". Use international format with country code, e.g. 5521999998888.`,
    );
  }
  return digits;
}

/**
 * Brazilian mobile numbers exist in two spellings: with the 9th digit (5521999998888) and
 * without it (552199998888). WhatsApp's wa_id may use either one, so lookups try both.
 */
export function phoneVariants(digits: string): string[] {
  const variants = [digits];
  if (digits.startsWith("55")) {
    if (digits.length === 13 && digits[4] === "9") {
      variants.push(digits.slice(0, 4) + digits.slice(5));
    } else if (digits.length === 12) {
      variants.push(`${digits.slice(0, 4)}9${digits.slice(4)}`);
    }
  }
  return variants;
}
