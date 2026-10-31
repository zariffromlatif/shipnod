import { html, raw } from 'hono/html';
import type { Plan } from '../../billing/plans.js';
import { confirmationSms, type SmsLanguage } from '../../confirmation/messages.js';
import type { Seller, StoredOrder, UsageRow } from '../../db/store.js';
import { COURIER_IDS, type CourierId, type OrderStatus, type RiskAssessment, type RiskLevel } from '../../domain/types.js';
import {
  actorLabel,
  ago,
  authPage,
  csrfField,
  dateTime,
  eventDetail,
  flash,
  meter,
  num,
  page,
  pct,
  riskBadge,
  RISK_LEVEL_LABEL,
  SOURCE_LABEL,
  statTile,
  statusChip,
  STATUS_LABEL,
  taka,
  type Html,
} from './ui.js';

// ------------------------------------------------------------------- order tabs

export const ORDER_TABS = {
  action: { label: 'কাজ বাকি', statuses: ['on_hold', 'awaiting_advance', 'confirmed'] },
  waiting: { label: 'কাস্টমারের অপেক্ষায়', statuses: ['new', 'awaiting_confirmation'] },
  shipping: { label: 'শিপিংয়ে', statuses: ['booked', 'in_transit'] },
  done: { label: 'সম্পন্ন', statuses: ['delivered', 'returned', 'cancelled'] },
  all: { label: 'সব', statuses: [] },
} as const satisfies Record<string, { label: string; statuses: readonly OrderStatus[] }>;
export type OrderTab = keyof typeof ORDER_TABS;

type Counts = Partial<Record<OrderStatus, number>>;
const sumOf = (counts: Counts, statuses: readonly OrderStatus[]) => statuses.reduce((n, s) => n + (counts[s] ?? 0), 0);
const totalOf = (counts: Counts) => Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);

export const SUCCESS_MESSAGES: Record<string, string> = {
  created: 'অর্ডার যোগ হয়েছে।',
  confirm: 'অর্ডার কনফার্ম করা হয়েছে।',
  advance_received: 'অগ্রিম পাওয়া গেছে — অর্ডার কনফার্মড।',
  hold: 'অর্ডার হোল্ডে রাখা হয়েছে।',
  cancel: 'অর্ডার বাতিল করা হয়েছে।',
  resend: 'নতুন লিংকসহ SMS আবার পাঠানো হয়েছে।',
  book: 'কুরিয়ারে বুক করা হয়েছে।',
  delivered: 'ডেলিভারড হিসেবে লেখা হয়েছে।',
  returned: 'ফেরত হিসেবে লেখা হয়েছে।',
  profile: 'সেটিংস সেভ হয়েছে।',
  risk: 'ঝুঁকির নিয়ম সেভ হয়েছে।',
  courier: 'কুরিয়ার যুক্ত হয়েছে।',
  block: 'নম্বরটি ব্লক করা হয়েছে।',
  unblock: 'নম্বরটি আনব্লক করা হয়েছে।',
};

/** What just happened to a freshly created order, in words. */
function createdNote(order: StoredOrder): string {
  switch (order.status) {
    case 'awaiting_confirmation':
      return 'কাস্টমারকে কনফার্মেশন SMS পাঠানো হয়েছে।';
    case 'awaiting_advance':
      return 'ঝুঁকি বেশি — কাস্টমারকে অগ্রিম ডেলিভারি চার্জের SMS পাঠানো হয়েছে।';
    case 'on_hold':
      return order.phoneValid ? 'ঝুঁকি খুব বেশি — অর্ডারটি হোল্ডে রাখা হয়েছে। নিচের কারণগুলো দেখুন।' : 'ফোন নম্বর সঠিক নয় — অর্ডারটি হোল্ডে রাখা হয়েছে।';
    case 'confirmed':
      return 'কম ঝুঁকি — সরাসরি পাঠাতে পারেন।';
    case 'booked':
      return 'কম ঝুঁকি — কুরিয়ারে অটো-বুক হয়েছে।';
    default:
      return '';
  }
}

// ------------------------------------------------------------------------ auth

export function loginPage(args: { error?: string; phone?: string }): Html {
  return authPage(
    'লগইন',
    html`<div class="card">
        <h1>লগইন</h1>
        <p class="muted">আপনার দোকানের রেজিস্টার্ড মোবাইল নম্বর দিন। আমরা একটি ৬ সংখ্যার কোড SMS করব।</p>
        ${flash('error', args.error)}
        <form method="post" action="/app/login">
          <label for="phone">মোবাইল নম্বর</label>
          <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="01XXXXXXXXX" value="${args.phone ?? ''}">
          <button class="primary" type="submit">কোড পাঠান</button>
        </form>
      </div>
      <details class="card">
        <summary>API key দিয়ে লগইন</summary>
        <form method="post" action="/app/login/key">
          <label for="apiKey">API key</label>
          <input id="apiKey" name="apiKey" type="password" autocomplete="off" required placeholder="nsk_...">
          <button type="submit">লগইন</button>
        </form>
      </details>`,
  );
}

export function verifyPage(args: { phone: string; error?: string; notice?: string }): Html {
  return authPage(
    'কোড দিন',
    html`<div class="card">
      <h1>কোড দিন</h1>
      <p class="muted">${args.phone} নম্বরটি রেজিস্টার্ড হলে সেখানে একটি ৬ সংখ্যার কোড পাঠানো হয়েছে। কোডটি ১০ মিনিট কাজ করবে।</p>
      ${flash('ok', args.notice)} ${flash('error', args.error)}
      <form method="post" action="/app/login/verify">
        <input type="hidden" name="phone" value="${args.phone}">
        <label for="code">কোড</label>
        <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9০-৯]{6}" maxlength="6" required autofocus>
        <button class="primary" type="submit">লগইন</button>
      </form>
      <p class="small"><a href="/app/login">অন্য নম্বর / আবার কোড পাঠান</a></p>
    </div>`,
  );
}

// -------------------------------------------------------------------- overview

export interface OverviewData {
  seller: Seller;
  csrf: string;
  stats: {
    days: number;
    totalOrders: number;
    rtoRate: number | null;
    stoppedBeforeShipping: number;
    estimatedSavedBdt: number;
    costPerFailedOrderBdt: number;
    byStatus: Record<string, number>;
  };
  counts: Counts;
  usage: { period: string; plan: Plan; usage: UsageRow; overageBdt: number };
  recent: StoredOrder[];
  now: Date;
}

export function overviewPage(d: OverviewData): Html {
  const { stats, counts, usage } = d;
  const todo: Array<{ label: string; n: number; href: string; hint: string }> = [
    { label: 'হোল্ডে — রিভিউ করুন', n: counts.on_hold ?? 0, href: '/app/orders?tab=action', hint: 'খুব বেশি ঝুঁকি বা ভুল নম্বর' },
    { label: 'বুকিং বাকি', n: counts.confirmed ?? 0, href: '/app/orders?tab=action', hint: 'কনফার্মড, কুরিয়ারে পাঠানো হয়নি' },
    { label: 'অগ্রিমের অপেক্ষায়', n: counts.awaiting_advance ?? 0, href: '/app/orders?tab=action', hint: 'bKash পেলে কনফার্ম করুন' },
    { label: 'কাস্টমারের উত্তরের অপেক্ষায়', n: sumOf(counts, ORDER_TABS.waiting.statuses), href: '/app/orders?tab=waiting', hint: 'SMS লিংকে কনফার্ম করবে' },
  ];
  const delivered = stats.byStatus.delivered ?? 0;
  return page({
    title: 'ওভারভিউ',
    active: 'home',
    seller: d.seller,
    csrf: d.csrf,
    now: d.now,
    body: html`
      <h1>${d.seller.shopName}</h1>
      <p class="muted">গত ${num(stats.days)} দিনের হিসাব · প্ল্যান: ${usage.plan.name}</p>

      <div class="card">
        <p class="tile-label">আনুমানিক সাশ্রয়</p>
        <p class="hero">${taka(stats.estimatedSavedBdt)}</p>
        <p class="muted small">শিপিংয়ের আগে থামানো ${num(stats.stoppedBeforeShipping)}টি অর্ডার × প্রতি ফেরতে ${taka(stats.costPerFailedOrderBdt)} (আপনার দেওয়া হিসাব, <a href="/app/settings">বদলান</a>)</p>
      </div>

      <div class="grid" style="margin-top:14px">
        ${statTile('মোট অর্ডার', num(stats.totalOrders))}
        ${statTile('ফেরতের হার (RTO)', stats.rtoRate === null ? '—' : pct(stats.rtoRate), stats.rtoRate === null ? 'ডেলিভারির ফলাফল এলে দেখা যাবে' : 'ফেরত ÷ (ডেলিভারড + ফেরত)')}
        ${statTile('শিপিংয়ের আগে থামানো', num(stats.stoppedBeforeShipping), 'কাস্টমার বাতিল বা রিফিউজ করেছে')}
        ${statTile('ডেলিভারড', num(delivered))}
      </div>

      <h2 style="margin-top:22px">কাজ বাকি</h2>
      <div class="grid">
        ${todo.map(
          (t) => html`<a class="tile todo" href="${t.href}"><p class="tile-label">${t.label}</p><p class="tile-value">${num(t.n)}</p><p class="muted small">${t.hint}</p></a>`,
        )}
      </div>

      <div class="cols" style="margin-top:8px">
        <div class="card">
          <h2>এই মাসের ব্যবহার</h2>
          ${meter('অর্ডার', usage.usage.orders, usage.plan.monthlyOrders)}
          ${meter('কাস্টমার চেক', usage.usage.riskChecks, usage.plan.monthlyRiskChecks)}
          <p class="muted small" style="margin-top:10px">SMS: ${num(usage.usage.smsSent)}টি (${num(usage.usage.smsSegments)} পার্ট)${usage.overageBdt > 0 ? html` · অতিরিক্ত চার্জ ${taka(usage.overageBdt)}` : ''}</p>
        </div>
        <div class="card">
          <h2>কাস্টমার চেক</h2>
          <p class="muted small">অর্ডার নেওয়ার আগে নম্বরটি যাচাই করুন।</p>
          <form method="post" action="/app/check">
            ${csrfField(d.csrf)}
            <label for="q-phone">মোবাইল নম্বর</label>
            <input id="q-phone" name="phone" type="tel" inputmode="tel" required placeholder="01XXXXXXXXX">
            <button class="primary" type="submit">চেক করুন</button>
          </form>
        </div>
      </div>

      <div class="card">
        <h2>সাম্প্রতিক অর্ডার</h2>
        ${orderList(d.recent, d.now, 'এখনো কোনো অর্ডার নেই। <a href="/app/orders/new">প্রথম অর্ডার যোগ করুন</a>।')}
      </div>`,
  });
}

function orderList(orders: StoredOrder[], now: Date, emptyHtml: string): Html {
  if (orders.length === 0) return html`<p class="empty">${raw(emptyHtml)}</p>`;
  return html`<ul class="list">
    ${orders.map((o) => {
      const top = o.risk?.reasons.filter((r) => r.points > 0 && r.code !== 'BASE').sort((a, b) => b.points - a.points)[0];
      return html`<li><a class="row" href="/app/orders/${o.id}">
        <span><strong>${o.customerName}</strong> <span class="muted">· ${o.phone}</span></span>
        <span class="amt">${taka(o.codAmount)}</span>
        <span class="meta">${riskBadge(o.risk)} ${statusChip(o.status)} <span>${ago(o.createdAt, now)}</span>${top ? html`<span>${top.messageBn}</span>` : ''}</span>
      </a></li>`;
    })}
  </ul>`;
}

// ---------------------------------------------------------------------- orders

export function ordersPage(d: {
  seller: Seller;
  csrf: string;
  orders: StoredOrder[];
  tab: OrderTab;
  level: RiskLevel | null;
  search: string;
  counts: Counts;
  page: number;
  hasNext: boolean;
  now: Date;
}): Html {
  const qs = (extra: Record<string, string | number | null>) => {
    const p = new URLSearchParams();
    const merged = { tab: d.tab, level: d.level, q: d.search || null, ...extra };
    for (const [k, v] of Object.entries(merged)) if (v !== null && v !== '' && v !== undefined) p.set(k, String(v));
    return `/app/orders?${p.toString()}`;
  };
  return page({
    title: 'অর্ডার',
    active: 'orders',
    seller: d.seller,
    csrf: d.csrf,
    now: d.now,
    body: html`
      <div class="actions" style="justify-content:space-between"><h1>অর্ডার</h1><a class="btn primary" href="/app/orders/new">+ নতুন অর্ডার</a></div>
      <nav class="tabs" aria-label="অর্ডারের অবস্থা">
        ${(Object.keys(ORDER_TABS) as OrderTab[]).map((key) => {
          const tab = ORDER_TABS[key];
          const n = key === 'all' ? totalOf(d.counts) : sumOf(d.counts, tab.statuses);
          return html`<a href="${qs({ tab: key, page: null })}" ${key === d.tab ? raw('aria-current="page"') : ''}>${tab.label} (${num(n)})</a>`;
        })}
      </nav>
      <form class="card fields" method="get" action="/app/orders" style="align-items:end">
        <input type="hidden" name="tab" value="${d.tab}">
        <div><label for="q">খুঁজুন</label><input id="q" name="q" value="${d.search}" placeholder="নাম, নম্বর বা অর্ডার আইডি"></div>
        <div><label for="level">ঝুঁকি</label>
          <select id="level" name="level">
            <option value="">সব</option>
            ${(Object.keys(RISK_LEVEL_LABEL) as RiskLevel[]).map(
              (l) => html`<option value="${l}" ${l === d.level ? raw('selected') : ''}>${RISK_LEVEL_LABEL[l]}</option>`,
            )}
          </select></div>
        <div><button type="submit">ফিল্টার</button></div>
      </form>
      <div class="card">${orderList(d.orders, d.now, 'এই ফিল্টারে কোনো অর্ডার নেই।')}</div>
      <div class="actions">
        ${d.page > 1 ? html`<a class="btn" href="${qs({ page: d.page - 1 })}">← আগের পাতা</a>` : ''}
        ${d.hasNext ? html`<a class="btn" href="${qs({ page: d.page + 1 })}">পরের পাতা →</a>` : ''}
      </div>`,
  });
}

// ---------------------------------------------------------------- order detail

function riskCard(risk: RiskAssessment | null): Html {
  if (!risk) return html`<div class="card"><h2>ঝুঁকি</h2><p class="muted">ঝুঁকি যাচাই করা হয়নি।</p></div>`;
  return html`<div class="card">
    <div class="actions" style="justify-content:space-between;align-items:center"><h2 style="margin:0">ঝুঁকি যাচাই</h2>${riskBadge(risk)}</div>
    <p class="muted small">${risk.ordersSeen > 0 && risk.deliverySuccessRate !== null
      ? `নেটওয়ার্কে এই নম্বরের ${num(risk.ordersSeen)}টি অর্ডারের ফলাফল আছে · ডেলিভারি সফলতা ${pct(risk.deliverySuccessRate)}`
      : 'নেটওয়ার্কে এই নম্বরের কোনো ডেলিভারি রেকর্ড নেই'}</p>
    <ul class="reasons">
      ${risk.reasons.map(
        (r) => html`<li><span>${r.messageBn}<br><span class="muted small">${r.message}</span></span><span class="pts">${r.points > 0 ? '+' : ''}${num(r.points)}</span></li>`,
      )}
    </ul>
  </div>`;
}

const PRE_SHIPPING: readonly OrderStatus[] = ['new', 'awaiting_confirmation', 'awaiting_advance', 'on_hold', 'confirmed'];
const CONFIRMABLE: readonly OrderStatus[] = ['new', 'awaiting_confirmation', 'awaiting_advance', 'on_hold'];
const OUTCOME_READY: readonly OrderStatus[] = ['confirmed', 'booked', 'in_transit'];

function actionButton(csrf: string, orderId: string, op: string, label: string, cls = ''): Html {
  return html`<form class="inline" method="post" action="/app/orders/${orderId}">${csrfField(csrf)}<input type="hidden" name="op" value="${op}"><button class="${cls}" type="submit">${label}</button></form>`;
}

function actionsCard(order: StoredOrder, couriers: CourierId[], csrf: string): Html {
  const s = order.status;
  const id = order.id;
  const blocks: Html[] = [];

  const quick: Html[] = [];
  if (s === 'awaiting_advance') quick.push(actionButton(csrf, id, 'advance_received', 'অগ্রিম পেয়েছি — কনফার্ম', 'primary'));
  if (CONFIRMABLE.includes(s)) quick.push(actionButton(csrf, id, 'confirm', s === 'awaiting_advance' ? 'অগ্রিম ছাড়াই কনফার্ম' : 'কনফার্ম করুন', s === 'awaiting_advance' ? '' : 'primary'));
  if (s === 'awaiting_confirmation' || s === 'awaiting_advance') quick.push(actionButton(csrf, id, 'resend', 'SMS আবার পাঠান'));
  if (PRE_SHIPPING.includes(s) && s !== 'on_hold') quick.push(actionButton(csrf, id, 'hold', 'হোল্ডে রাখুন'));
  if (quick.length) blocks.push(html`<div class="actions">${quick}</div>`);

  if (s === 'confirmed') {
    blocks.push(
      couriers.length === 0
        ? html`<p class="muted small" style="margin-top:14px">কুরিয়ারে বুক করতে আগে <a href="/app/settings#couriers">সেটিংসে কুরিয়ার যুক্ত করুন</a>।</p>`
        : html`<form method="post" action="/app/orders/${id}" style="margin-top:14px">
            ${csrfField(csrf)}<input type="hidden" name="op" value="book">
            <h2>কুরিয়ারে বুক করুন</h2>
            <div class="fields">
              <div><label for="courier">কুরিয়ার</label><select id="courier" name="courier">${couriers.map((c) => html`<option value="${c}">${c}</option>`)}</select></div>
              <div><label for="weightKg">ওজন (কেজি)</label><input id="weightKg" name="weightKg" inputmode="decimal" value="0.5"></div>
            </div>
            <details><summary class="small">Pathao / RedX এরিয়া (দরকার হলে)</summary>
              <div class="fields">
                <div><label for="cityId">City ID (Pathao)</label><input id="cityId" name="cityId" inputmode="numeric"></div>
                <div><label for="zoneId">Zone ID (Pathao)</label><input id="zoneId" name="zoneId" inputmode="numeric"></div>
                <div><label for="areaId">Area ID (Pathao/RedX)</label><input id="areaId" name="areaId" inputmode="numeric"></div>
                <div><label for="areaName">Area নাম (RedX)</label><input id="areaName" name="areaName"></div>
              </div>
            </details>
            <button class="primary" type="submit">বুক করুন</button>
          </form>`,
    );
  }

  if (OUTCOME_READY.includes(s)) {
    blocks.push(html`<div style="margin-top:14px"><h2>ফলাফল লিখুন</h2>
      <p class="muted small">${s === 'confirmed' ? 'Shipnod ছাড়া অন্যভাবে পাঠালে ফলাফল এখানে লিখুন — নেটওয়ার্ক এভাবেই শেখে।' : 'কুরিয়ার স্ট্যাটাস নিজে থেকেই আপডেট হয়; চাইলে এখানে লিখতে পারেন।'}</p>
      <div class="actions">${actionButton(csrf, id, 'delivered', '✓ ডেলিভারড')}${actionButton(csrf, id, 'returned', '↩ ফেরত এসেছে')}</div></div>`);
  }

  if (PRE_SHIPPING.includes(s)) {
    blocks.push(html`<form method="post" action="/app/orders/${id}" style="margin-top:14px">
      ${csrfField(csrf)}<input type="hidden" name="op" value="cancel">
      <label class="check"><input type="checkbox" name="customerRefused" value="1">কাস্টমার অর্ডারটি নিতে চায়নি (নেটওয়ার্কে রেকর্ড হবে)</label>
      <button class="danger" type="submit">অর্ডার বাতিল করুন</button>
    </form>`);
  }

  if (blocks.length === 0) return html`<div class="card"><h2>অ্যাকশন</h2><p class="muted">এই অর্ডারে আর কিছু করার নেই।</p></div>`;
  return html`<div class="card"><h2>অ্যাকশন</h2>${blocks}</div>`;
}

export function orderDetailPage(d: {
  seller: Seller;
  now?: Date;
  csrf: string;
  order: StoredOrder;
  events: Array<{ from: string | null; to: string; actor: string; detail: string | null; at: string }>;
  couriers: CourierId[];
  message?: string;
  error?: string;
  justCreated?: boolean;
}): Html {
  const o = d.order;
  return page({
    title: o.customerName,
    active: 'orders',
    seller: d.seller,
    csrf: d.csrf,
    now: d.now,
    body: html`
      <p class="small"><a href="/app/orders">← সব অর্ডার</a></p>
      <div class="actions" style="justify-content:space-between;align-items:center">
        <h1>${o.customerName} · ${taka(o.codAmount)}</h1>${statusChip(o.status)}
      </div>
      ${flash('ok', d.message ? `${d.message}${d.justCreated ? ` ${createdNote(o)}` : ''}` : undefined)}
      ${flash('error', d.error)}
      <div class="cols">
        <div>
          <div class="card">
            <h2>অর্ডার</h2>
            <dl class="kv">
              <dt>ফোন</dt><dd>${o.phoneValid ? html`<a href="tel:${o.phone}">${o.phone}</a>` : html`${o.phone} <span class="muted">(সঠিক নয়)</span>`}</dd>
              <dt>ঠিকানা</dt><dd>${o.address}${o.district ? html`, ${o.district}` : ''}</dd>
              <dt>COD</dt><dd>${o.codAmount > 0 ? taka(o.codAmount) : 'অগ্রিম পরিশোধিত'}</dd>
              <dt>সোর্স</dt><dd>${SOURCE_LABEL[o.source] ?? o.source}${o.externalId ? html` · #${o.externalId}` : ''}</dd>
              <dt>তৈরি</dt><dd>${dateTime(o.createdAt)}</dd>
              <dt>অর্ডার আইডি</dt><dd><code>${o.id}</code></dd>
              ${o.courier ? html`<dt>কুরিয়ার</dt><dd>${o.courier} · ${o.consignmentId}${o.trackingCode && o.trackingCode !== o.consignmentId ? html` · ${o.trackingCode}` : ''}</dd>` : ''}
              ${o.note ? html`<dt>নোট</dt><dd>${o.note}</dd>` : ''}
            </dl>
            ${o.items.length > 0
              ? html`<table style="margin-top:12px"><tbody>${o.items.map((i) => html`<tr><td>${i.name} × ${num(i.quantity)}</td><td style="text-align:right">${taka(i.unitPrice * i.quantity)}</td></tr>`)}</tbody></table>`
              : ''}
          </div>
          ${riskCard(o.risk)}
        </div>
        <div>
          ${actionsCard(o, d.couriers, d.csrf)}
          <div class="card">
            <h2>টাইমলাইন</h2>
            <ol class="timeline">
              ${d.events.map(
                (e) => html`<li><strong>${STATUS_LABEL[e.to as OrderStatus] ?? e.to}</strong> <span class="muted small">· ${actorLabel(e.actor)} · ${dateTime(e.at)}</span>${e.detail ? html`<br><span class="small">${eventDetail(e.detail)}</span>` : ''}</li>`,
              )}
            </ol>
          </div>
        </div>
      </div>`,
  });
}

// ------------------------------------------------------------------- new order

export interface NewOrderValues {
  customerName?: string;
  phone?: string;
  address?: string;
  district?: string;
  codAmount?: string;
  note?: string;
  items?: Array<{ name?: string; quantity?: string; unitPrice?: string }>;
}

export function newOrderPage(d: { seller: Seller; csrf: string; now?: Date; values?: NewOrderValues; error?: string }): Html {
  const v = d.values ?? {};
  const items = [0, 1, 2].map((i) => v.items?.[i] ?? {});
  return page({
    title: 'নতুন অর্ডার',
    active: 'new',
    seller: d.seller,
    csrf: d.csrf,
    now: d.now,
    body: html`
      <h1>নতুন অর্ডার</h1>
      <p class="muted">ফেসবুক পেজ বা ফোনে পাওয়া অর্ডার এখানে লিখুন। সেভ করলেই ঝুঁকি যাচাই হবে আর দরকার হলে কাস্টমারকে SMS যাবে।</p>
      ${flash('error', d.error)}
      <form class="card" method="post" action="/app/orders/new">
        ${csrfField(d.csrf)}
        <div class="fields">
          <div><label for="customerName">কাস্টমারের নাম</label><input id="customerName" name="customerName" required maxlength="120" value="${v.customerName ?? ''}"></div>
          <div><label for="phone">মোবাইল নম্বর</label><input id="phone" name="phone" type="tel" inputmode="tel" required value="${v.phone ?? ''}" placeholder="01XXXXXXXXX"></div>
        </div>
        <label for="address">পূর্ণ ঠিকানা</label>
        <textarea id="address" name="address" rows="2" required maxlength="500" placeholder="বাড়ি, রোড, এলাকা, থানা">${v.address ?? ''}</textarea>
        <div class="fields">
          <div><label for="district">জেলা</label><input id="district" name="district" maxlength="80" value="${v.district ?? ''}"></div>
          <div><label for="codAmount">ডেলিভারিতে নেবেন (৳)</label><input id="codAmount" name="codAmount" inputmode="decimal" required value="${v.codAmount ?? ''}" placeholder="অগ্রিম পেলে 0"></div>
        </div>
        <h2 style="margin-top:16px">পণ্য</h2>
        ${items.map(
          (it, i) => html`<div class="fields">
            <div><label for="item${i}name">পণ্যের নাম</label><input id="item${i}name" name="item${i}name" maxlength="200" value="${it.name ?? ''}"></div>
            <div><label for="item${i}qty">পরিমাণ</label><input id="item${i}qty" name="item${i}qty" inputmode="numeric" value="${it.quantity ?? (i === 0 ? '1' : '')}"></div>
            <div><label for="item${i}price">একক দাম (৳)</label><input id="item${i}price" name="item${i}price" inputmode="decimal" value="${it.unitPrice ?? ''}"></div>
          </div>`,
        )}
        <label for="note">নোট (কুরিয়ারের জন্য)</label>
        <input id="note" name="note" maxlength="500" value="${v.note ?? ''}">
        <button class="primary" type="submit">অর্ডার সেভ করুন</button>
      </form>`,
  });
}

// ----------------------------------------------------------------- customer check

export function checkPage(d: {
  seller: Seller;
  now?: Date;
  csrf: string;
  phone?: string;
  error?: string;
  result?: { phone: string | null; valid: boolean; risk: RiskAssessment };
}): Html {
  const r = d.result;
  return page({
    title: 'কাস্টমার চেক',
    active: 'check',
    seller: d.seller,
    csrf: d.csrf,
    now: d.now,
    body: html`
      <h1>কাস্টমার চেক</h1>
      <p class="muted">অর্ডার নেওয়ার আগে নম্বরটির ডেলিভারি রেকর্ড দেখুন। প্রতিটি চেক মাসিক সীমা থেকে কাটে।</p>
      ${flash('error', d.error)}
      <form class="card" method="post" action="/app/check">
        ${csrfField(d.csrf)}
        <div class="fields">
          <div><label for="phone">মোবাইল নম্বর</label><input id="phone" name="phone" type="tel" inputmode="tel" required value="${d.phone ?? ''}" placeholder="01XXXXXXXXX"></div>
          <div><label for="codAmount">অর্ডারের মূল্য (৳, ঐচ্ছিক)</label><input id="codAmount" name="codAmount" inputmode="decimal"></div>
        </div>
        <button class="primary" type="submit">চেক করুন</button>
      </form>
      ${r
        ? r.valid
          ? html`<p class="muted" style="margin-top:14px">ফলাফল: <strong>${r.phone}</strong></p>${riskCard(r.risk)}
              <p class="muted small">পরামর্শ: ${{
                auto_ship: 'সরাসরি পাঠাতে পারেন।',
                confirm: 'পাঠানোর আগে কনফার্ম করিয়ে নিন।',
                advance_payment: 'ডেলিভারি চার্জ অগ্রিম নিন।',
                hold: 'অর্ডার নেওয়ার আগে ভালোভাবে যাচাই করুন।',
              }[r.risk.action]}</p>`
          : html`<div class="flash flash-error" role="alert">এটি সঠিক বাংলাদেশি মোবাইল নম্বর নয়।</div>`
        : ''}`,
  });
}

// --------------------------------------------------------------------- settings

const COURIER_FIELDS: Record<CourierId, Array<{ name: string; label: string; secret?: boolean; numeric?: boolean }>> = {
  steadfast: [
    { name: 'apiKey', label: 'API Key' },
    { name: 'secretKey', label: 'Secret Key', secret: true },
  ],
  pathao: [
    { name: 'clientId', label: 'Client ID' },
    { name: 'clientSecret', label: 'Client Secret', secret: true },
    { name: 'username', label: 'Username (ইমেইল)' },
    { name: 'password', label: 'Password', secret: true },
    { name: 'storeId', label: 'Store ID', numeric: true },
  ],
  redx: [
    { name: 'accessToken', label: 'API Access Token', secret: true },
    { name: 'pickupStoreId', label: 'Pickup Store ID', numeric: true },
  ],
};

const COURIER_NAME: Record<CourierId, string> = { steadfast: 'Steadfast', pathao: 'Pathao', redx: 'RedX' };

export function settingsPage(d: {
  seller: Seller;
  now?: Date;
  csrf: string;
  plan: Plan;
  usage: { period: string; usage: UsageRow; overageBdt: number };
  couriers: CourierId[];
  blocklist: Array<{ phoneHash: string; phoneMasked: string | null; reason: string | null; createdAt: string }>;
  publicBaseUrl: string;
  message?: string;
  error?: string;
}): Html {
  const s = d.seller;
  const policy = s.riskPolicy ?? { mediumAt: 30, highAt: 60, criticalAt: 80, advancePaymentEnabled: true };
  const sampleLink = `${d.publicBaseUrl}/c/Ab12Cd34`;
  const langs: Array<{ id: SmsLanguage; label: string }> = [
    { id: 'bn', label: 'বাংলা' },
    { id: 'banglish', label: 'Banglish' },
    { id: 'en', label: 'English' },
  ];
  const sel = (on: boolean) => (on ? raw('selected') : '');
  return page({
    title: 'সেটিংস',
    active: 'settings',
    seller: s,
    csrf: d.csrf,
    now: d.now,
    body: html`
      <h1>সেটিংস</h1>
      ${flash('ok', d.message)} ${flash('error', d.error)}

      <form class="card" method="post" action="/app/settings">
        ${csrfField(d.csrf)}<input type="hidden" name="op" value="profile">
        <h2>দোকান ও SMS</h2>
        <div class="fields">
          <div><label for="shopName">দোকানের নাম (SMS-এ দেখাবে)</label><input id="shopName" name="shopName" required maxlength="60" value="${s.shopName}"></div>
          <div><label for="bkashNumber">bKash নম্বর (অগ্রিমের জন্য)</label><input id="bkashNumber" name="bkashNumber" type="tel" value="${s.bkashNumber ?? ''}" placeholder="01XXXXXXXXX"></div>
          <div><label for="advanceFeeBdt">অগ্রিম ডেলিভারি চার্জ (৳)</label><input id="advanceFeeBdt" name="advanceFeeBdt" inputmode="numeric" value="${s.advanceFeeBdt}"></div>
          <div><label for="costPerFailedOrderBdt">প্রতি ফেরতে আপনার খরচ (৳)</label><input id="costPerFailedOrderBdt" name="costPerFailedOrderBdt" inputmode="numeric" value="${s.costPerFailedOrderBdt}"></div>
          <div><label for="autoBookCourier">কম ঝুঁকির অর্ডার অটো-বুক</label>
            <select id="autoBookCourier" name="autoBookCourier">
              <option value="">বন্ধ</option>
              ${d.couriers.map((c) => html`<option value="${c}" ${sel(s.autoBookCourier === c)}>${COURIER_NAME[c]}</option>`)}
            </select>
            <p class="muted small">এখন শুধু Steadfast অটো-বুক হয় (Pathao/RedX-এ প্রতি অর্ডারে এরিয়া লাগে)।</p></div>
        </div>
        <label>কাস্টমারকে SMS-এর ভাষা</label>
        ${langs.map((l) => {
          const sms = confirmationSms({ shopName: s.shopName, amount: 1450, link: sampleLink, lang: l.id });
          return html`<label class="check" style="align-items:flex-start;margin-top:8px"><input type="radio" name="smsLang" value="${l.id}" ${s.smsLang === l.id ? raw('checked') : ''}>
            <span><strong>${l.label}</strong> <span class="muted small">· ${num(sms.segments)} পার্ট SMS</span><br><code>${sms.text}</code></span></label>`;
        })}
        <button class="primary" type="submit">সেভ করুন</button>
      </form>

      <form class="card" method="post" action="/app/settings">
        ${csrfField(d.csrf)}<input type="hidden" name="op" value="risk">
        <h2>ঝুঁকির নিয়ম</h2>
        ${d.plan.customRiskRules
          ? html`<p class="muted small">স্কোর এই সীমা ছুঁলে: মাঝারি → SMS কনফার্মেশন, বেশি → অগ্রিম, খুব বেশি → হোল্ড।</p>
              <div class="fields">
                <div><label for="mediumAt">মাঝারি ঝুঁকি শুরু</label><input id="mediumAt" name="mediumAt" inputmode="numeric" value="${policy.mediumAt}"></div>
                <div><label for="highAt">বেশি ঝুঁকি শুরু</label><input id="highAt" name="highAt" inputmode="numeric" value="${policy.highAt}"></div>
                <div><label for="criticalAt">খুব বেশি ঝুঁকি শুরু</label><input id="criticalAt" name="criticalAt" inputmode="numeric" value="${policy.criticalAt}"></div>
              </div>
              <label class="check"><input type="checkbox" name="advancePaymentEnabled" value="1" ${policy.advancePaymentEnabled ? raw('checked') : ''}>বেশি ঝুঁকিতে অগ্রিম চাইব (বন্ধ থাকলে শুধু SMS কনফার্মেশন)</label>
              <div class="actions"><button class="primary" type="submit">সেভ করুন</button><button type="submit" name="reset" value="1">ডিফল্টে ফেরান</button></div>`
          : html`<p class="muted">ডিফল্ট নিয়ম চালু আছে: ৩০+ SMS কনফার্মেশন, ৬০+ অগ্রিম, ৮০+ হোল্ড। নিজের নিয়ম বানাতে Growth প্ল্যান লাগবে।</p>`}
      </form>

      <div class="card" id="couriers">
        <h2>কুরিয়ার</h2>
        <p class="muted small">আপনার নিজের মার্চেন্ট অ্যাকাউন্টের তথ্য দিন। তথ্য এনক্রিপ্ট করে রাখা হয়, আর কখনো দেখানো হয় না। আপনার প্ল্যানে ${num(d.plan.maxCouriers)}টি কুরিয়ার যুক্ত করা যায়।</p>
        ${COURIER_IDS.map(
          (c) => html`<details style="margin-top:10px">
            <summary><strong>${COURIER_NAME[c]}</strong> — ${d.couriers.includes(c) ? html`<span aria-hidden="true">✓ </span>যুক্ত` : 'যুক্ত নয়'}</summary>
            <form method="post" action="/app/settings">
              ${csrfField(d.csrf)}<input type="hidden" name="op" value="courier"><input type="hidden" name="courier" value="${c}">
              <div class="fields">
                ${COURIER_FIELDS[c].map(
                  (f) => html`<div><label for="${c}-${f.name}">${f.label}</label><input id="${c}-${f.name}" name="${f.name}" required autocomplete="off" ${f.secret ? raw('type="password"') : ''} ${f.numeric ? raw('inputmode="numeric"') : ''}></div>`,
                )}
              </div>
              <button type="submit">${d.couriers.includes(c) ? 'আপডেট করুন' : 'যুক্ত করুন'}</button>
            </form>
          </details>`,
        )}
      </div>

      <div class="card">
        <h2>WooCommerce / Shopify</h2>
        ${d.plan.storeIntegrations
          ? html`<p class="muted small">নতুন অর্ডার ওয়েবহুক এই ঠিকানায় পাঠান, আর নিচের secret দিন।</p>
              <dl class="kv">
                <dt>WooCommerce</dt><dd><code>${d.publicBaseUrl}/webhooks/woocommerce/${s.id}</code> <span class="muted small">(Topic: Order created)</span></dd>
                <dt>Shopify</dt><dd><code>${d.publicBaseUrl}/webhooks/shopify/${s.id}</code> <span class="muted small">(orders/create)</span></dd>
                <dt>Secret</dt><dd><code>${s.webhookSecret}</code></dd>
              </dl>`
          : html`<p class="muted">স্টোর ইন্টিগ্রেশন Growth প্ল্যান থেকে পাওয়া যায়।</p>`}
      </div>

      <div class="card">
        <h2>ব্লকলিস্ট</h2>
        <p class="muted small">এই নম্বরগুলোর অর্ডার সরাসরি হোল্ডে যাবে।</p>
        <form method="post" action="/app/settings" class="fields" style="align-items:end">
          ${csrfField(d.csrf)}<input type="hidden" name="op" value="block">
          <div><label for="b-phone">মোবাইল নম্বর</label><input id="b-phone" name="phone" type="tel" required></div>
          <div><label for="b-reason">কারণ</label><input id="b-reason" name="reason" maxlength="200"></div>
          <div><button type="submit">ব্লক করুন</button></div>
        </form>
        ${d.blocklist.length === 0
          ? html`<p class="muted small" style="margin-top:10px">কোনো নম্বর ব্লক করা নেই।</p>`
          : html`<table style="margin-top:10px"><tbody>${d.blocklist.map(
              (b) => html`<tr><td>${b.phoneMasked ?? 'নম্বর'}</td><td>${b.reason ?? ''}</td><td class="muted">${dateTime(b.createdAt)}</td>
                <td style="text-align:right"><form class="inline" method="post" action="/app/settings">${csrfField(d.csrf)}<input type="hidden" name="op" value="unblock"><input type="hidden" name="hash" value="${b.phoneHash}"><button type="submit" style="margin:0">আনব্লক</button></form></td></tr>`,
            )}</tbody></table>`}
      </div>

      <div class="card">
        <h2>প্ল্যান ও ব্যবহার</h2>
        <p><strong>${d.plan.name}</strong> · ${d.plan.priceBdt > 0 ? html`${taka(d.plan.priceBdt)}/মাস` : 'ফ্রি'} · মাস ${d.usage.period}</p>
        ${meter('অর্ডার', d.usage.usage.orders, d.plan.monthlyOrders)}
        ${meter('কাস্টমার চেক', d.usage.usage.riskChecks, d.plan.monthlyRiskChecks)}
        ${d.usage.overageBdt > 0 ? html`<p>অতিরিক্ত চার্জ: <strong>${taka(d.usage.overageBdt)}</strong></p>` : ''}
        <p class="muted small">প্ল্যান বদলাতে Shipnod টিমের সাথে যোগাযোগ করুন।</p>
      </div>`,
  });
}
