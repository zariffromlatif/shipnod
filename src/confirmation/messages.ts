import { toBanglaDigits } from '../domain/phone.js';

/**
 * SMS copy for customer-facing messages.
 *
 * Cost matters: Bangla script forces UCS-2 encoding (70 chars per SMS, 67 per part when split),
 * while English/Banglish fits GSM-7 (160 / 153). A Bangla confirmation is usually 2 parts.
 * `smsSegments` lets the UI show the seller what each message costs before they pick a language.
 */
export type SmsLanguage = 'bn' | 'banglish' | 'en';

export interface SmsText {
  text: string;
  encoding: 'GSM-7' | 'UCS-2';
  segments: number;
}

const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\\[~]|€\f';

export function smsSegments(text: string): Omit<SmsText, 'text'> {
  let septets = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) septets += 1;
    else if (GSM_EXTENDED.includes(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return { encoding: 'GSM-7', segments: septets <= 160 ? 1 : Math.ceil(septets / 153) };
  const units = text.length; // UTF-16 code units
  return { encoding: 'UCS-2', segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}

function shortShopName(name: string): string {
  const clean = name.replace(/\s+/g, ' ').trim();
  return clean.length > 20 ? clean.slice(0, 20).trimEnd() : clean;
}

function finish(text: string): SmsText {
  return { text, ...smsSegments(text) };
}

export function confirmationSms(args: { shopName: string; amount: number; link: string; lang: SmsLanguage }): SmsText {
  const shop = shortShopName(args.shopName);
  const amt = Math.round(args.amount);
  switch (args.lang) {
    case 'bn':
      return finish(`${shop}: ৳${toBanglaDigits(amt)} এর অর্ডারটি নিশ্চিত করুন: ${args.link}`);
    case 'banglish':
      return finish(`${shop}: Apnar Tk ${amt} er order ti confirm korun: ${args.link}`);
    case 'en':
      return finish(`${shop}: Please confirm your Tk ${amt} cash-on-delivery order: ${args.link}`);
  }
}

export function advancePaymentSms(args: { shopName: string; fee: number; link: string; lang: SmsLanguage }): SmsText {
  const shop = shortShopName(args.shopName);
  const fee = Math.round(args.fee);
  switch (args.lang) {
    case 'bn':
      return finish(`${shop}: অর্ডার নিশ্চিত করতে ডেলিভারি চার্জ ৳${toBanglaDigits(fee)} অগ্রিম দিন: ${args.link}`);
    case 'banglish':
      return finish(`${shop}: Order confirm korte delivery charge Tk ${fee} advance din: ${args.link}`);
    case 'en':
      return finish(`${shop}: To confirm your order, please pay the Tk ${fee} delivery charge in advance: ${args.link}`);
  }
}

/** Sent when a seller is signed up: the login link, to be opened with the same number. */
export function welcomeSms(args: { shopName: string; link: string; lang: SmsLanguage }): SmsText {
  const shop = shortShopName(args.shopName);
  switch (args.lang) {
    case 'bn':
      return finish(`${shop}-এর জন্য Shipnod চালু হয়েছে! এই নম্বর দিয়ে লগইন করুন: ${args.link}`);
    case 'banglish':
      return finish(`${shop} er jonno Shipnod chalu hoyeche! Ei number diye login korun: ${args.link}`);
    case 'en':
      return finish(`Shipnod is ready for ${shop}! Log in with this number: ${args.link}`);
  }
}
