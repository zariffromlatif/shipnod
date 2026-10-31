import type { Seller, StoredOrder } from '../db/store.js';
import { toBanglaDigits } from '../domain/phone.js';

/**
 * Server-rendered pages. The confirmation page is what a customer opens from an SMS on a cheap
 * Android phone over a slow connection: no JS, no external assets, Bangla first, < 5 KB.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BASE_CSS = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#14181f;--muted:#5b6472;--line:#e3e6eb;--ok:#0f7b4b;--ok-ink:#fff;--no:#b42318;--accent:#0b5cad}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--card:#171b21;--ink:#e8ebef;--muted:#9aa3ae;--line:#2a3038;--ok:#22a06b;--no:#f97066;--accent:#5aa9ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Noto Sans Bengali","Hind Siliguri",sans-serif}
main{max-width:480px;margin:0 auto;padding:20px 16px 40px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-top:14px}
h1{font-size:1.25rem;margin:0 0 4px}.muted{color:var(--muted);font-size:.92rem}
table{width:100%;border-collapse:collapse;margin:10px 0}td{padding:6px 0;border-bottom:1px solid var(--line);vertical-align:top}td:last-child{text-align:right;white-space:nowrap}
.total td{font-weight:700;border-bottom:0}
button{width:100%;font:inherit;font-weight:600;padding:14px;border-radius:10px;border:0;margin-top:10px;cursor:pointer}
.yes{background:var(--ok);color:var(--ok-ink)}.no{background:transparent;color:var(--no);border:1px solid var(--line)}
.status{font-size:1.1rem;font-weight:600}.brand{font-size:.8rem;color:var(--muted);text-align:center;margin-top:24px}
`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${BASE_CSS}</style></head>
<body><main>${body}<p class="brand">Shipnod</p></main></body></html>`;
}

const taka = (n: number) => `৳${toBanglaDigits(Math.round(n))}`;

function orderSummary(order: StoredOrder): string {
  const rows = order.items
    .map((i) => `<tr><td>${escapeHtml(i.name)} × ${toBanglaDigits(i.quantity)}</td><td>${taka(i.unitPrice * i.quantity)}</td></tr>`)
    .join('');
  return `<table>${rows}<tr class="total"><td>ডেলিভারির সময় পরিশোধ</td><td>${taka(order.codAmount)}</td></tr></table>
<p class="muted">${escapeHtml(order.customerName)} · ${escapeHtml(order.address)}</p>`;
}

export function confirmationPage(args: { order: StoredOrder; seller: Seller; expired: boolean; code: string; error?: string }): string {
  const { order, seller, expired, code } = args;
  const head = `<h1>${escapeHtml(seller.shopName)}</h1><p class="muted">অর্ডার নং ${escapeHtml(order.id.slice(-6))}</p>`;
  const errorBlock = args.error ? `<p class="status" style="color:var(--no)">${escapeHtml(args.error)}</p>` : '';

  if (order.status === 'cancelled') {
    return layout('অর্ডার বাতিল', `${head}<div class="card"><p class="status">অর্ডারটি বাতিল করা হয়েছে।</p><p class="muted">ভুল হলে সরাসরি ${escapeHtml(seller.shopName)}-এর সাথে যোগাযোগ করুন।</p></div>`);
  }
  if (!['awaiting_confirmation', 'awaiting_advance'].includes(order.status)) {
    return layout('অর্ডার নিশ্চিত', `${head}<div class="card"><p class="status" style="color:var(--ok)">আপনার অর্ডার নিশ্চিত হয়েছে। ধন্যবাদ!</p>${orderSummary(order)}</div>`);
  }
  if (expired) {
    return layout('লিংকের মেয়াদ শেষ', `${head}<div class="card"><p class="status">এই লিংকের মেয়াদ শেষ হয়ে গেছে।</p><p class="muted">অর্ডার করতে চাইলে ${escapeHtml(seller.shopName)}-এর সাথে যোগাযোগ করুন।</p></div>`);
  }

  const action = `/c/${encodeURIComponent(code)}`;
  const cancelForm = `<form method="post" action="${action}"><input type="hidden" name="decision" value="cancel"><button class="no" type="submit">না, অর্ডার বাতিল করুন</button></form>`;

  if (order.status === 'awaiting_advance') {
    const pay = seller.bkashNumber
      ? `<p>bKash-এ <strong>${taka(seller.advanceFeeBdt)}</strong> Send Money করুন: <strong>${escapeHtml(seller.bkashNumber)}</strong><br>রেফারেন্স: <strong>${escapeHtml(code)}</strong></p>`
      : `<p>ডেলিভারি চার্জ <strong>${taka(seller.advanceFeeBdt)}</strong> অগ্রিম পরিশোধের জন্য ${escapeHtml(seller.shopName)} আপনার সাথে যোগাযোগ করবে।</p>`;
    return layout(
      'অগ্রিম ডেলিভারি চার্জ',
      `${head}<div class="card">${errorBlock}<p class="status">অর্ডার নিশ্চিত করতে ডেলিভারি চার্জ অগ্রিম দিন</p>${pay}
<p class="muted">পেমেন্ট পাওয়ার পর বিক্রেতা আপনার অর্ডার পাঠিয়ে দেবেন। বাকি টাকা ডেলিভারির সময় দেবেন।</p>${orderSummary(order)}${cancelForm}</div>`,
    );
  }

  return layout(
    'অর্ডার নিশ্চিত করুন',
    `${head}<div class="card">${errorBlock}<p class="status">আপনি কি এই অর্ডারটি করেছেন?</p>${orderSummary(order)}
<form method="post" action="${action}"><input type="hidden" name="decision" value="confirm"><button class="yes" type="submit">হ্যাঁ, অর্ডার নিশ্চিত করছি</button></form>
${cancelForm}</div>`,
  );
}

export function notFoundPage(): string {
  return layout('লিংক পাওয়া যায়নি', `<div class="card"><p class="status">লিংকটি সঠিক নয়।</p><p class="muted">SMS-এর লিংকটি আবার চেক করুন।</p></div>`);
}
