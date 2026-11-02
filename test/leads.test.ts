import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_ALERTS_PER_DAY } from '../src/services/leads.js';
import { ADMIN_PASSWORD, client, createHarness, LEAD_ALERT_PHONE } from './helpers.js';

let h: ReturnType<typeof createHarness>;
beforeEach(() => {
  h = createHarness();
});

const FORM = {
  name: 'Rahim Uddin',
  shopName: 'Rahim Fashion',
  phone: '+880 1711-111111',
  monthlyOrders: '1000-3000',
  channel: 'facebook',
  source: 'fb-we-group',
  website: '',
};

/** Posts the public form like a browser, with repeated `couriers` fields. */
function submit(fields: Record<string, string> = {}, couriers: string[] = ['steadfast', 'pathao']) {
  const body = new URLSearchParams({ ...FORM, ...fields });
  for (const c of couriers) body.append('couriers', c);
  return h.app.request('/pilot', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
}

const leadsList = () => h.leads.list();
const alertsTo = () => h.sms.sent.filter((m) => m.to === LEAD_ALERT_PHONE);

async function adminSession() {
  const a = client(h.app);
  expect((await a.rawPost('/admin/login', { password: ADMIN_PASSWORD })).status).toBe(303);
  await a.get('/admin/leads');
  return a;
}

describe('landing page', () => {
  it('has the pilot form and a WhatsApp button when configured', async () => {
    const page = await (await h.app.request('/')).text();
    expect(page).toContain('href="#pilot"');
    expect(page).toContain('action="/pilot"');
    expect(page).toContain('name="couriers" value="redx"');
    expect(page).toContain('https://wa.me/8801888888888?text=');
    expect(page).not.toContain('TODO');
    // Planned Scale features are labelled as coming, not sold as included.
    expect(page).not.toContain('<li>ভয়েস কল কনফার্মেশন</li>');
    expect(page).toContain('শিগগিরই আসছে: ভয়েস কল কনফার্মেশন, একাধিক ইউজার');

    h = createHarness({ whatsapp: false });
    const without = await (await h.app.request('/')).text();
    expect(without).not.toContain('wa.me');
    expect(without).not.toContain('<!--WHATSAPP-->');
  });

  it('serves the standalone form with the ref kept', async () => {
    const page = await (await h.app.request('/pilot?ref=fb-group-dhaka')).text();
    expect(page).toContain('name="source" value="fb-group-dhaka"');
  });
});

describe('pilot requests', () => {
  it('stores the request, thanks the seller and texts the founder', async () => {
    const res = await submit();
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('ধন্যবাদ, Rahim Uddin!');
    expect(page).toContain('01711111111');

    const [lead] = leadsList();
    expect(lead).toMatchObject({
      name: 'Rahim Uddin',
      shopName: 'Rahim Fashion',
      phone: '01711111111',
      monthlyOrders: '1000-3000',
      couriers: ['steadfast', 'pathao'],
      channel: 'facebook',
      source: 'fb-we-group',
      status: 'new',
      alerted: true,
    });
    expect(alertsTo()).toHaveLength(1);
    expect(alertsTo()[0]!.text).toBe('Shipnod lead: Rahim Fashion (01711111111, 1000-3000 orders/mo). https://nsc.test/admin/leads');
  });

  it('explains mistakes and keeps what was typed', async () => {
    const res = await submit({ phone: '12345' }, ['redx']);
    expect(res.status).toBe(422);
    const page = await res.text();
    expect(page).toContain('সঠিক বাংলাদেশি মোবাইল নম্বর দিন');
    expect(page).toContain('value="Rahim Fashion"');
    expect(page).toMatch(/value="redx" checked/);
    expect(page).toMatch(/value="1000-3000" selected/);
    expect((await submit({ shopName: ' ' })).status).toBe(422);
    expect(leadsList()).toHaveLength(0);
  });

  it('ignores bots that fill the hidden field', async () => {
    const res = await submit({ website: 'http://spam.example' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('ধন্যবাদ');
    expect(leadsList()).toHaveLength(0);
    expect(h.sms.sent).toHaveLength(0);
  });

  it('merges repeats from the same phone within a day', async () => {
    await submit();
    await submit({ monthlyOrders: '3000+' });
    expect(leadsList()).toHaveLength(1);
    expect(leadsList()[0]!.monthlyOrders).toBe('3000+');
    expect(alertsTo()).toHaveLength(1);

    h.clock.now = new Date(h.clock.now.getTime() + 25 * 3600_000);
    await submit();
    expect(leadsList()).toHaveLength(2);
  });

  it('sends existing sellers to the login page', async () => {
    h.service.createSeller({ name: 'R', shopName: 'Rahim Fashion', plan: 'growth', phone: '01711111111' });
    const page = await (await submit()).text();
    expect(page).toContain('আপনার অ্যাকাউন্ট আগে থেকেই আছে');
    expect(page).toContain('href="/app/login"');
    expect(leadsList()).toHaveLength(0);
  });

  it('caps founder alerts per day but still stores every request', async () => {
    for (let i = 0; i < MAX_ALERTS_PER_DAY + 2; i++) {
      await submit({ phone: `0171${String(i).padStart(7, '0')}` });
    }
    expect(leadsList()).toHaveLength(MAX_ALERTS_PER_DAY + 2);
    expect(alertsTo()).toHaveLength(MAX_ALERTS_PER_DAY);
    expect(leadsList().filter((l) => !l.alerted)).toHaveLength(2);
  });

  it('drops junk values instead of storing them', async () => {
    await submit({ monthlyOrders: 'lots', channel: 'tv', source: '<script>x</script>', name: 'A'.repeat(200) }, ['dhl', 'redx']);
    const [lead] = leadsList();
    expect(lead).toMatchObject({ monthlyOrders: null, channel: null, couriers: ['redx'] });
    expect(lead!.source).not.toContain('<');
    expect(lead!.name).toHaveLength(80);
  });
});

describe('admin: leads', () => {
  it('lists requests with call and WhatsApp links, and tracks follow-up', async () => {
    await submit();
    const anon = client(h.app);
    expect((await anon.get('/admin/leads')).location).toBe('/admin/login');

    const a = await adminSession();
    expect((await a.get('/admin')).text).toMatch(/নতুন পাইলট আবেদন<\/p><p class="tile-value">১</);
    const page = await a.get('/admin/leads');
    expect(page.text).toContain('Rahim Fashion');
    expect(page.text).toContain('href="tel:01711111111"');
    expect(page.text).toContain('https://wa.me/8801711111111?text=');
    expect(page.text).toContain('Steadfast, Pathao');
    expect(page.text).toContain('fb-we-group');
    expect(page.text).toContain('নতুন (১)');

    const id = leadsList()[0]!.id;
    expect((await a.rawPost(`/admin/leads/${id}`, { status: 'contacted' })).status).toBe(403);
    expect((await a.post(`/admin/leads/${id}`, { status: 'contacted', back: 'new' })).location).toBe('/admin/leads?status=new&msg=updated');
    expect(h.leads.get(id).status).toBe('contacted');
    expect((await a.get('/admin/leads?status=contacted')).text).toContain('Rahim Fashion');
    expect((await a.post(`/admin/leads/${id}`, { status: 'converted' })).status).toBe(422);
  });

  it('turns a request into a seller with the form pre-filled', async () => {
    await submit({ monthlyOrders: '3000+' });
    const lead = leadsList()[0]!;
    const a = await adminSession();

    const form = await a.get(`/admin/sellers/new?lead=${lead.id}`);
    expect(form.text).toContain('পাইলট আবেদন থেকে');
    expect(form.text).toContain('value="Rahim Uddin"');
    expect(form.text).toContain('value="01711111111"');
    expect(form.text).toMatch(/value="scale" selected/);
    expect(form.text).toContain(`name="leadId" value="${lead.id}"`);

    const res = await a.post('/admin/sellers', {
      leadId: lead.id,
      name: 'Rahim Uddin',
      shopName: 'Rahim Fashion',
      phone: '01711111111',
      plan: 'scale',
      trialDays: '14',
      smsLang: 'bn',
      sendWelcome: '1',
    });
    expect(res.status).toBe(200);
    const seller = h.service.findSellerByPhone('01711111111')!;
    expect(h.leads.get(lead.id)).toMatchObject({ status: 'converted', sellerId: seller.id });

    const converted = await a.get('/admin/leads?status=converted');
    expect(converted.text).toContain(seller.id);
    expect(converted.text).not.toContain('/admin/sellers/new?lead=');
    expect((await a.get('/admin/sellers/new?lead=lead_missing')).status).toBe(404);
  });
});
