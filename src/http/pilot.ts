import type { Hono } from 'hono';
import { html, raw } from 'hono/html';
import { toE164 } from '../domain/phone.js';
import { AppError } from '../lib/errors.js';
import type { LeadService } from '../services/leads.js';
import { flash, shell, type Html } from './dashboard/ui.js';

/**
 * Public pilot request ("১৪ দিনের ফ্রি পাইলট"). The landing page posts its form here; this module
 * renders the thank-you page, or the same form again with an explanation when something is wrong.
 */
export interface PilotValues {
  name?: string;
  shopName?: string;
  phone?: string;
  monthlyOrders?: string;
  channel?: string;
  couriers?: string[];
  source?: string;
}

export function supportWhatsappUrl(number: string | null): string | null {
  if (!number) return null;
  const text = 'আসসালামু আলাইকুম, Shipnod-এর ১৪ দিনের ফ্রি পাইলট সম্পর্কে জানতে চাই।';
  return `https://wa.me/${toE164(number).slice(1)}?text=${encodeURIComponent(text)}`;
}

function publicPage(title: string, body: Html): Html {
  return shell(
    title,
    html`<header class="top"><div class="top-in"><a class="brand" href="/">Shipnod</a><nav><a href="/app/login">বিক্রেতা লগইন</a></nav></div></header>
      <main style="max-width:640px">${body}</main>`,
  );
}

const ORDER_OPTIONS: Array<[string, string]> = [
  ['', 'বেছে নিন'],
  ['<300', '৩০০-এর কম'],
  ['300-1000', '৩০০–১,০০০'],
  ['1000-3000', '১,০০০–৩,০০০'],
  ['3000+', '৩,০০০+'],
];
const CHANNEL_OPTIONS: Array<[string, string]> = [
  ['', 'বেছে নিন'],
  ['facebook', 'ফেসবুক পেজ'],
  ['website', 'ওয়েবসাইট (WooCommerce / Shopify)'],
  ['both', 'দুটোই'],
];
const COURIER_OPTIONS: Array<[string, string]> = [
  ['steadfast', 'Steadfast'],
  ['pathao', 'Pathao'],
  ['redx', 'RedX'],
  ['other', 'অন্যান্য'],
];

export function pilotFormPage(v: PilotValues = {}, error?: string, whatsapp: string | null = null): Html {
  const sel = (on: boolean) => (on ? raw('selected') : '');
  return publicPage(
    '১৪ দিনের ফ্রি পাইলট',
    html`<h1>১৪ দিনের ফ্রি পাইলট</h1>
      <p class="muted">ফর্মটি পূরণ করুন — ২৪ ঘণ্টার মধ্যে আমরা ফোন করে সেটআপ করে দেব। কোনো কার্ড বা অগ্রিম লাগবে না।</p>
      ${flash('error', error)}
      <form class="card" method="post" action="/pilot">
        <div class="fields">
          <div><label for="name">আপনার নাম</label><input id="name" name="name" required maxlength="80" value="${v.name ?? ''}" autocomplete="name"></div>
          <div><label for="shopName">দোকান / পেজের নাম</label><input id="shopName" name="shopName" required maxlength="80" value="${v.shopName ?? ''}"></div>
          <div><label for="phone">মোবাইল নম্বর</label><input id="phone" name="phone" type="tel" inputmode="tel" required value="${v.phone ?? ''}" placeholder="01XXXXXXXXX" autocomplete="tel"></div>
          <div><label for="monthlyOrders">মাসে কতগুলো COD অর্ডার?</label>
            <select id="monthlyOrders" name="monthlyOrders">${ORDER_OPTIONS.map(([k, l]) => html`<option value="${k}" ${sel(v.monthlyOrders === k)}>${l}</option>`)}</select></div>
          <div><label for="channel">কোথায় বিক্রি করেন?</label>
            <select id="channel" name="channel">${CHANNEL_OPTIONS.map(([k, l]) => html`<option value="${k}" ${sel(v.channel === k)}>${l}</option>`)}</select></div>
        </div>
        <label>কোন কুরিয়ার ব্যবহার করেন?</label>
        <div class="actions" style="gap:6px 16px">${COURIER_OPTIONS.map(
          ([k, l]) => html`<label class="check" style="margin:0"><input type="checkbox" name="couriers" value="${k}" ${v.couriers?.includes(k) ? raw('checked') : ''}>${l}</label>`,
        )}</div>
        <div style="position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden" aria-hidden="true"><label for="website">Website</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>
        <input type="hidden" name="source" value="${v.source ?? ''}">
        <div class="actions">
          <button class="primary" type="submit">পাইলটের জন্য আবেদন করুন</button>
          ${whatsapp ? html`<a class="btn" href="${whatsapp}" target="_blank" rel="noopener">WhatsApp-এ কথা বলুন</a>` : ''}
        </div>
      </form>`,
  );
}

export function pilotThanksPage(kind: 'thanks' | 'existing_seller', v: { name?: string; phone?: string }, whatsapp: string | null): Html {
  if (kind === 'existing_seller') {
    return publicPage(
      'আপনার অ্যাকাউন্ট আছে',
      html`<div class="card"><h1>আপনার অ্যাকাউন্ট আগে থেকেই আছে</h1>
        <p>এই নম্বরে একটি Shipnod অ্যাকাউন্ট আছে। নম্বর দিয়ে লগইন করুন — SMS-এ একটি কোড আসবে।</p>
        <a class="btn primary" href="/app/login">লগইন করুন</a></div>`,
    );
  }
  return publicPage(
    'ধন্যবাদ',
    html`<div class="card"><h1>ধন্যবাদ${v.name ? html`, ${v.name}` : ''}!</h1>
      <p>আপনার আবেদন পেয়েছি। ২৪ ঘণ্টার মধ্যে আমরা ${v.phone ? html`<strong>${v.phone}</strong> নম্বরে` : ''} ফোন করে পাইলট চালু করে দেব।</p>
      <p class="muted small">এর মধ্যে আগের মাসের হিসাব (কতগুলো অর্ডার, কতগুলো ফেরত এসেছে) হাতে রাখলে সেটআপ দ্রুত হবে।</p>
      <div class="actions">${whatsapp ? html`<a class="btn primary" href="${whatsapp}" target="_blank" rel="noopener">WhatsApp-এ কথা বলুন</a>` : ''}<a class="btn" href="/">হোমে ফিরুন</a></div></div>`,
  );
}

const ERRORS: Record<string, string> = {
  invalid_name: 'আপনার নাম লিখুন।',
  invalid_shop: 'দোকান বা পেজের নাম লিখুন।',
  invalid_phone: 'সঠিক বাংলাদেশি মোবাইল নম্বর দিন (যেমন 01712345678)।',
};

export function registerPilotRoutes(app: Hono<any>, leads: LeadService, whatsappNumber: string | null): void {
  const whatsapp = supportWhatsappUrl(whatsappNumber);

  app.get('/pilot', (c) => c.html(pilotFormPage({ source: (c.req.query('ref') ?? c.req.query('utm_source') ?? '').slice(0, 60) }, undefined, whatsapp)));

  app.post('/pilot', async (c) => {
    const form = await c.req.parseBody({ all: true });
    const one = (k: string) => {
      const v = form[k];
      const first = Array.isArray(v) ? v[0] : v;
      return typeof first === 'string' ? first : '';
    };
    const many = (k: string) => {
      const v = form[k];
      return (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string');
    };
    const values: PilotValues = {
      name: one('name'),
      shopName: one('shopName'),
      phone: one('phone'),
      monthlyOrders: one('monthlyOrders'),
      channel: one('channel'),
      couriers: many('couriers'),
      source: one('source'),
    };
    try {
      const result = await leads.submit({
        name: one('name'),
        shopName: one('shopName'),
        phone: one('phone'),
        monthlyOrders: one('monthlyOrders'),
        channel: one('channel'),
        couriers: many('couriers'),
        source: one('source'),
        honeypot: one('website'),
      });
      if (result.status === 'existing_seller') return c.html(pilotThanksPage('existing_seller', values, whatsapp));
      if (result.status === 'ignored') return c.html(pilotThanksPage('thanks', {}, whatsapp));
      return c.html(pilotThanksPage('thanks', { name: result.lead.name, phone: result.lead.phone }, whatsapp));
    } catch (err) {
      if (err instanceof AppError && ERRORS[err.code]) return c.html(pilotFormPage(values, ERRORS[err.code], whatsapp), 422);
      throw err;
    }
  });
}
