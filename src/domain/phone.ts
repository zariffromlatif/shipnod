/**
 * Bangladeshi mobile number handling.
 *
 * Customers type numbers in every format imaginable: "+880 1712-345678", "8801712345678",
 * "01712345678", "1712345678", and very often with Bangla digits ("০১৭১২৩৪৫৬৭৮").
 * Everything downstream (risk lookups, network hashing, courier APIs) uses the canonical
 * 11-digit local form "01XXXXXXXXX" — RedX in particular rejects +880-prefixed numbers.
 */

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

/** Valid mobile prefixes: 013–019 (GP 013/017, Banglalink 014/019, Teletalk 015, Airtel 016, Robi 018). */
const LOCAL_MOBILE = /^01[3-9]\d{8}$/;

export type Operator = 'Grameenphone' | 'Banglalink' | 'Teletalk' | 'Airtel' | 'Robi';

const OPERATOR_BY_PREFIX: Record<string, Operator> = {
  '013': 'Grameenphone',
  '017': 'Grameenphone',
  '014': 'Banglalink',
  '019': 'Banglalink',
  '015': 'Teletalk',
  '016': 'Airtel',
  '018': 'Robi',
};

export function toAsciiDigits(input: string): string {
  return input.replace(/[০-৯]/g, (d) => String(BANGLA_DIGITS.indexOf(d)));
}

export function toBanglaDigits(input: string | number): string {
  return String(input).replace(/\d/g, (d) => BANGLA_DIGITS[Number(d)]!);
}

/** Returns the canonical "01XXXXXXXXX" form, or null if the input is not a valid BD mobile number. */
export function normalizeBdPhone(input: string): string | null {
  let digits = toAsciiDigits(input).replace(/\D/g, '');
  if (digits.startsWith('00880')) digits = digits.slice(5);
  else if (digits.startsWith('880')) digits = digits.slice(3);
  if (digits.length === 10 && digits.startsWith('1')) digits = `0${digits}`;
  return LOCAL_MOBILE.test(digits) ? digits : null;
}

export function isValidBdPhone(input: string): boolean {
  return normalizeBdPhone(input) !== null;
}

/** E.164 form ("+8801XXXXXXXXX"), used by SMS gateways and WhatsApp. */
export function toE164(normalized: string): string {
  return `+88${normalized}`;
}

export function operatorOf(normalized: string): Operator | null {
  return OPERATOR_BY_PREFIX[normalized.slice(0, 3)] ?? null;
}

/** "01712345678" -> "017****5678" for logs and UI where the full number isn't needed. */
export function maskPhone(normalized: string): string {
  return normalized.length === 11 ? `${normalized.slice(0, 3)}****${normalized.slice(7)}` : '***';
}
