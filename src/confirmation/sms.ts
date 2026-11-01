import { toE164 } from '../domain/phone.js';
import { smsSegments } from './messages.js';

export interface SmsMessage {
  /** Canonical local form "01XXXXXXXXX". */
  to: string;
  text: string;
}

export interface SmsResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface SmsProvider {
  readonly name: string;
  send(message: SmsMessage): Promise<SmsResult>;
}

/** Development provider: prints messages and keeps them in memory (tests read `sent`). */
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';
  readonly sent: SmsMessage[] = [];

  constructor(private readonly silent = false) {}

  async send(message: SmsMessage): Promise<SmsResult> {
    this.sent.push(message);
    if (!this.silent) console.log(`[sms] -> ${message.to}: ${message.text}`);
    return { ok: true, providerMessageId: `console-${this.sent.length}` };
  }
}

export interface HttpTemplateSmsOptions {
  /**
   * GET URL with placeholders: {apiKey} {senderId} {to} (8801XXXXXXXXX) {toLocal} (01XXXXXXXXX) {text},
   * plus {type} ("text" or "unicode") and {unicode} ("0" or "1") for gateways that must be told a
   * message contains Bangla.
   * Nearly every Bangladeshi SMS gateway (BulkSMSBD, Alpha SMS, SSL Wireless, ...) exposes this shape.
   */
  urlTemplate: string;
  apiKey: string;
  senderId: string;
  /** Optional regex the response body must match to count as success (gateways often return 200 on errors). */
  successPattern?: string;
  fetch?: typeof fetch;
}

export class HttpTemplateSmsProvider implements SmsProvider {
  readonly name = 'http';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HttpTemplateSmsOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  buildUrl(message: SmsMessage): string {
    const values: Record<string, string> = {
      apiKey: this.opts.apiKey,
      senderId: this.opts.senderId,
      to: toE164(message.to).slice(1),
      toLocal: message.to,
      text: message.text,
      type: smsSegments(message.text).encoding === 'UCS-2' ? 'unicode' : 'text',
      unicode: smsSegments(message.text).encoding === 'UCS-2' ? '1' : '0',
    };
    return this.opts.urlTemplate.replace(/\{(apiKey|senderId|to|toLocal|text|type|unicode)\}/g, (_, key: string) =>
      encodeURIComponent(values[key] ?? ''),
    );
  }

  async send(message: SmsMessage): Promise<SmsResult> {
    try {
      const res = await this.fetchImpl(this.buildUrl(message), { method: 'GET' });
      const body = await res.text();
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      if (this.opts.successPattern && !new RegExp(this.opts.successPattern).test(body)) {
        return { ok: false, error: `Gateway rejected: ${body.slice(0, 200)}` };
      }
      return { ok: true, providerMessageId: body.slice(0, 100) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
