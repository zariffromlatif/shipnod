import { html, raw } from 'hono/html';
import { planOf } from '../../billing/plans.js';
import { subscriptionState, type SubscriptionState } from '../../billing/subscription.js';
import type { Seller } from '../../db/store.js';
import type { OrderStatus, RiskAssessment, RiskLevel } from '../../domain/types.js';

/**
 * Shared building blocks for the seller dashboard. Every page is server-rendered with
 * `hono/html`, which escapes interpolated values, so customer-supplied text (names,
 * addresses, notes) can never inject markup. `raw()` is used only for constant strings.
 */
export type Html = ReturnType<typeof html>;

// ------------------------------------------------------------------ formatting

const NUM = new Intl.NumberFormat('bn-BD');
const PCT = new Intl.NumberFormat('bn-BD', { style: 'percent', maximumFractionDigits: 1 });
const DATE_TIME = new Intl.DateTimeFormat('bn-BD', {
  timeZone: 'Asia/Dhaka',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
const RELATIVE = new Intl.RelativeTimeFormat('bn', { numeric: 'auto' });

export const num = (n: number) => NUM.format(Math.round(n));
export const taka = (n: number) => `৳${NUM.format(Math.round(n))}`;
export const pct = (r: number) => PCT.format(r);
export const dateTime = (iso: string) => DATE_TIME.format(new Date(iso));

export function ago(iso: string, now: Date = new Date()): string {
  const seconds = (new Date(iso).getTime() - now.getTime()) / 1000;
  const abs = Math.abs(seconds);
  if (abs < 60) return RELATIVE.format(Math.round(seconds), 'second');
  if (abs < 3600) return RELATIVE.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return RELATIVE.format(Math.round(seconds / 3600), 'hour');
  if (abs < 30 * 86400) return RELATIVE.format(Math.round(seconds / 86400), 'day');
  return dateTime(iso);
}

// ---------------------------------------------------------------------- labels

export const STATUS_LABEL: Record<OrderStatus, string> = {
  new: 'নতুন',
  awaiting_confirmation: 'কনফার্মেশনের অপেক্ষায়',
  awaiting_advance: 'অগ্রিমের অপেক্ষায়',
  on_hold: 'হোল্ডে — রিভিউ করুন',
  confirmed: 'কনফার্মড — বুকিং বাকি',
  cancelled: 'বাতিল',
  booked: 'কুরিয়ারে বুকড',
  in_transit: 'পথে আছে',
  delivered: 'ডেলিভারড',
  returned: 'ফেরত এসেছে',
};

const STATUS_GLYPH: Partial<Record<OrderStatus, string>> = {
  delivered: '✓',
  returned: '↩',
  cancelled: '✕',
  on_hold: '⏸',
};

/** Status palette is fixed and reserved for risk severity; each level also has its own glyph + label. */
const RISK_UI: Record<RiskLevel, { label: string; glyph: string; tone: 'good' | 'warning' | 'serious' | 'critical' }> = {
  low: { label: 'কম ঝুঁকি', glyph: '✓', tone: 'good' },
  medium: { label: 'মাঝারি ঝুঁকি', glyph: '?', tone: 'warning' },
  high: { label: 'বেশি ঝুঁকি', glyph: '!', tone: 'serious' },
  critical: { label: 'খুব বেশি ঝুঁকি', glyph: '✕', tone: 'critical' },
};

export const RISK_LEVEL_LABEL: Record<RiskLevel, string> = {
  low: RISK_UI.low.label,
  medium: RISK_UI.medium.label,
  high: RISK_UI.high.label,
  critical: RISK_UI.critical.label,
};

export const SOURCE_LABEL: Record<string, string> = {
  manual: 'ম্যানুয়াল',
  api: 'API',
  csv: 'CSV',
  woocommerce: 'WooCommerce',
  shopify: 'Shopify',
};

export function actorLabel(actor: string): string {
  if (actor === 'risk_engine') return 'Shipnod (ঝুঁকি যাচাই)';
  if (actor === 'customer') return 'কাস্টমার';
  if (actor === 'seller') return 'আপনি';
  if (actor === 'sms') return 'SMS';
  if (actor === 'auto_book') return 'অটো-বুকিং';
  if (actor.startsWith('courier:')) return `কুরিয়ার (${actor.slice(8)})`;
  if (actor.startsWith('import:')) return `ইমপোর্ট (${SOURCE_LABEL[actor.slice(7)] ?? actor.slice(7)})`;
  return actor;
}

/** Event details are written by the service in English; show the common ones in Bangla. */
export function eventDetail(detail: string | null): string | null {
  if (!detail) return null;
  const risk = detail.match(/^risk (\d+) \((low|medium|high|critical)\)$/);
  if (risk) return `ঝুঁকি স্কোর ${num(Number(risk[1]))} — ${RISK_UI[risk[2] as RiskLevel].label}`;
  const fixed: Record<string, string> = {
    'low risk: auto-approved': 'কম ঝুঁকি — নিজে থেকেই অনুমোদিত',
    'critical risk': 'খুব বেশি ঝুঁকি — রিভিউ দরকার',
    'invalid phone number': 'ফোন নম্বর সঠিক নয়',
    'confirmed via link': 'কাস্টমার SMS লিংকে কনফার্ম করেছেন',
    'cancelled via confirmation link': 'কাস্টমার SMS লিংকে বাতিল করেছেন',
    'advance payment received': 'অগ্রিম পেমেন্ট পাওয়া গেছে',
    'customer refused': 'কাস্টমার অর্ডারটি নিতে চাননি',
  };
  if (fixed[detail]) return fixed[detail]!;
  if (detail.startsWith('SMS failed:')) return `SMS যায়নি: ${detail.slice(11).trim()}`;
  if (detail.startsWith('failed:')) return `অটো-বুকিং হয়নি: ${detail.slice(7).trim()}`;
  return detail; // courier status codes and consignment numbers stay as-is
}

// ------------------------------------------------------------------ components

export function riskBadge(risk: RiskAssessment | null): Html {
  if (!risk) return html`<span class="chip">ঝুঁকি অজানা</span>`;
  const ui = RISK_UI[risk.level];
  return html`<span class="badge" title="ঝুঁকি স্কোর ${risk.score}/100"
    ><span class="glyph tone-${ui.tone}" aria-hidden="true">${ui.glyph}</span>${ui.label} · ${num(risk.score)}</span
  >`;
}

export function statusChip(status: OrderStatus): Html {
  const glyph = STATUS_GLYPH[status];
  return html`<span class="chip">${glyph ? html`<span aria-hidden="true">${glyph} </span>` : ''}${STATUS_LABEL[status]}</span>`;
}

/** Usage meter: fill carries severity (accent → warning → critical); the track is a lighter step of the fill. */
export function meter(label: string, used: number, limit: number): Html {
  if (limit <= 0) return html`<p class="muted">${label}: এই প্ল্যানে নেই</p>`;
  const ratio = used / limit;
  const tone = ratio > 1 ? 'critical' : ratio >= 0.8 ? 'warning' : 'accent';
  const width = Math.min(100, Math.round(ratio * 100));
  return html`<div class="meter-row">
    <div class="meter-head"><span>${label}</span><span>${num(used)} / ${num(limit)}</span></div>
    <div class="meter tone-${tone}" role="meter" aria-label="${label}" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${used}">
      <span style="width:${width}%"></span>
    </div>
    ${ratio > 1 ? html`<p class="muted small">সীমার বেশি ${num(used - limit)}টি অর্ডার — অতিরিক্ত চার্জ প্রযোজ্য</p>` : ''}
  </div>`;
}

export function statTile(label: string, value: string, note?: string): Html {
  return html`<div class="tile"><p class="tile-label">${label}</p><p class="tile-value">${value}</p>${note ? html`<p class="muted small">${note}</p>` : ''}</div>`;
}

export const csrfField = (token: string) => html`<input type="hidden" name="_csrf" value="${token}">`;

export function flash(kind: 'ok' | 'error', message: string | undefined | null): Html | string {
  if (!message) return '';
  return html`<div class="flash flash-${kind}" role="${kind === 'error' ? 'alert' : 'status'}"
    ><span aria-hidden="true">${kind === 'ok' ? '✓ ' : '! '}</span>${message}</div
  >`;
}

// ---------------------------------------------------------------------- layout

const CSS = raw(`
:root{color-scheme:light;--bg:#f4f4f1;--surface:#fcfcfb;--ink:#14171c;--ink-2:#454b55;--muted:#6a707a;--line:#e1e0d9;--line-strong:#c3c2b7;
--accent:#0b5cad;--accent-ink:#fff;--good:#0ca30c;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b;--good-text:#006300;--critical-text:#b42318}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#121211;--surface:#1a1a19;--ink:#ecebe6;--ink-2:#c4c3bc;--muted:#97968f;--line:#2c2c2a;--line-strong:#383835;
--accent:#6cb2ff;--accent-ink:#0b0b0b;--good-text:#0ca30c;--critical-text:#f97066}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI","Noto Sans Bengali","Hind Siliguri",sans-serif}
a{color:var(--accent)}
.top{background:var(--surface);border-bottom:1px solid var(--line)}
.top-in{max-width:1100px;margin:0 auto;padding:10px 16px;display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center}
.brand{font-weight:700;font-size:1.05rem;color:var(--ink);text-decoration:none;margin-right:auto}
.brand small{font-weight:400;color:var(--muted);margin-left:6px}
.top button{margin:0;padding:6px 10px;border:0;background:transparent;color:var(--ink-2);font-weight:400}
.top button:hover{color:var(--ink)}
nav{display:flex;flex-wrap:wrap;gap:4px}
nav a{color:var(--ink-2);text-decoration:none;padding:6px 10px;border-radius:8px}
nav a[aria-current=page]{background:var(--bg);color:var(--ink);font-weight:600}
main{max-width:1100px;margin:0 auto;padding:20px 16px 56px}
h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.05rem;margin:0 0 10px}
.muted{color:var(--muted)}.small{font-size:.85rem}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:14px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))}
.cols{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));align-items:start}
.hero{font-size:3rem;font-weight:650;line-height:1.1;margin:4px 0}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px}
.tile-label{margin:0;color:var(--ink-2);font-size:.9rem}.tile-value{margin:4px 0 0;font-size:1.6rem;font-weight:600}
.badge,.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:2px 10px 2px 4px;font-size:.85rem;white-space:nowrap;background:var(--surface);color:var(--ink)}
.chip{padding:2px 10px}
.glyph{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;font-size:11px;font-weight:700;color:#fff}
.tone-good.glyph{background:var(--good)}.tone-warning.glyph{background:var(--warning);color:#0b0b0b}.tone-serious.glyph{background:var(--serious)}.tone-critical.glyph{background:var(--critical)}
.meter-row{margin-top:10px}.meter-head{display:flex;justify-content:space-between;font-size:.9rem;color:var(--ink-2)}
.meter{--fill:var(--accent);height:8px;border-radius:999px;background:color-mix(in srgb,var(--fill) 20%,transparent);overflow:hidden;margin-top:4px}
.meter span{display:block;height:100%;border-radius:999px;background:var(--fill)}
.meter.tone-warning{--fill:var(--warning)}.meter.tone-critical{--fill:var(--critical)}
.flash{border-radius:10px;padding:10px 12px;margin-top:14px;border:1px solid var(--line);background:var(--surface)}
.flash-ok{border-left:4px solid var(--good)}.flash-warn{border-left:4px solid var(--warning)}.flash-error{border-left:4px solid var(--critical);color:var(--critical-text)}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 0}
.tabs a{padding:6px 12px;border-radius:999px;border:1px solid var(--line);text-decoration:none;color:var(--ink-2);background:var(--surface);font-size:.9rem}
.tabs a[aria-current=page]{border-color:var(--ink);color:var(--ink);font-weight:600}
.list{list-style:none;margin:0;padding:0}
.list li{border-top:1px solid var(--line)}.list li:first-child{border-top:0}
.row{display:grid;grid-template-columns:1fr auto;gap:4px 12px;padding:12px 4px;color:inherit;text-decoration:none}
.row:hover{background:var(--bg)}
.row .amt{font-weight:600;text-align:right}.row .meta{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;color:var(--muted);font-size:.85rem}
.todo{display:block;text-decoration:none;color:inherit}.todo .tile-value{font-size:1.4rem}
form.inline{display:inline}
label{display:block;font-size:.88rem;color:var(--ink-2);margin:10px 0 4px}
input,select,textarea{width:100%;font:inherit;padding:9px 10px;border:1px solid var(--line-strong);border-radius:8px;background:var(--surface);color:var(--ink)}
input[type=checkbox],input[type=radio]{width:auto;margin-right:6px}
.check{display:flex;align-items:center;color:var(--ink);font-size:.95rem}
.fields{display:grid;gap:0 12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr))}
button,.btn{display:inline-block;font:inherit;font-weight:600;padding:9px 14px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface);color:var(--ink);cursor:pointer;text-decoration:none;margin-top:10px}
button.primary,.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
button.danger{color:var(--critical-text)}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}
.reasons{list-style:none;padding:0;margin:0}.reasons li{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-top:1px solid var(--line)}
.reasons li:first-child{border-top:0}.pts{font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--ink-2)}
.timeline{list-style:none;margin:0;padding:0}.timeline li{padding:8px 0 8px 14px;border-left:2px solid var(--line);margin-left:4px}
dl.kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:0}dl.kv dt{color:var(--muted)}dl.kv dd{margin:0;overflow-wrap:anywhere}
code{font-size:.85rem;background:var(--bg);border:1px solid var(--line);padding:1px 5px;border-radius:5px;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px 4px;border-top:1px solid var(--line);font-size:.9rem;vertical-align:top}
.empty{color:var(--muted);text-align:center;padding:28px 8px}
.scroll-x{overflow-x:auto}
.auth{max-width:400px;margin:8vh auto 0}
.status{font-weight:600}
thead th{color:var(--muted);font-weight:500;border-top:0}
`);

const NAV: Array<{ href: string; label: string; key: string }> = [
  { href: '/app', label: 'ওভারভিউ', key: 'home' },
  { href: '/app/orders', label: 'অর্ডার', key: 'orders' },
  { href: '/app/orders/new', label: '+ নতুন অর্ডার', key: 'new' },
  { href: '/app/check', label: 'কাস্টমার চেক', key: 'check' },
  { href: '/app/billing', label: 'বিলিং', key: 'billing' },
  { href: '/app/settings', label: 'সেটিংস', key: 'settings' },
];

const LONG_DATE = new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'long', year: 'numeric' });

/** Shown above every dashboard page when the plan needs attention. */
export function subscriptionBanner(state: SubscriptionState): Html | string {
  const renew = html`<a href="/app/billing">রিনিউ করুন</a>`;
  if (state.status === 'grace' && state.graceEndsAt) {
    return html`<div class="flash flash-error" role="alert"><span aria-hidden="true">! </span>আপনার ${planOf(state.purchasedPlan).name} প্ল্যানের মেয়াদ শেষ। ${LONG_DATE.format(state.graceEndsAt)} এর মধ্যে রিনিউ না করলে অর্ডার অটোমেশন বন্ধ হয়ে যাবে। ${renew}</div>`;
  }
  if (state.status === 'expired') {
    return html`<div class="flash flash-error" role="alert"><span aria-hidden="true">! </span>আপনার প্ল্যানের মেয়াদ শেষ — এখন Free প্ল্যান চলছে, নতুন অর্ডার অটোমেট হচ্ছে না। ${renew}</div>`;
  }
  if (state.status === 'active' && state.daysLeft !== null && state.daysLeft <= 5) {
    return html`<div class="flash flash-warn" role="status"><span aria-hidden="true">⏰ </span>${num(Math.max(state.daysLeft, 0))} দিনের মধ্যে আপনার প্ল্যানের মেয়াদ শেষ হবে। ${renew}</div>`;
  }
  return '';
}

export function shell(title: string, body: Html): Html {
  return html`<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · Shipnod</title>
<style>${CSS}</style>
</head>
<body>${body}</body>
</html>`;
}

export function page(args: { title: string; active: string; seller: Seller; csrf: string; body: Html; now?: Date }): Html {
  const { title, active, seller, csrf, body } = args;
  return shell(
    title,
    html`<header class="top"><div class="top-in">
      <a class="brand" href="/app">Shipnod<small>${seller.shopName}</small></a>
      <nav aria-label="প্রধান মেনু">
        ${NAV.map((n) => html`<a href="${n.href}" ${n.key === active ? raw('aria-current="page"') : ''}>${n.label}</a>`)}
      </nav>
      <form class="inline" method="post" action="/app/logout">${csrfField(csrf)}<button type="submit">লগআউট</button></form>
    </div></header>
    <main>${active === 'billing' ? '' : subscriptionBanner(subscriptionState(seller, args.now ?? new Date()))}${body}</main>`,
  );
}

export function authPage(title: string, body: Html): Html {
  return shell(title, html`<main class="auth"><p class="brand" style="font-size:1.3rem">Shipnod</p>${body}</main>`);
}
