// Uji deposit QRIS AutoGoPay + aturan anti-blokir (API tiruan): node test-deposit.js
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
Object.assign(process.env, {
  WEB_SECRET: 'test-secret-'.repeat(4), DATA_FILE: path.join(os.tmpdir(), `deposit-test-${Date.now()}.json`),
  ADMIN_ID: '999', PAYMENT_PROVIDER: 'autogopay', AUTOGOPAY_API_KEY: 'agp_test', AUTOGOPAY_BASE: 'https://agp.test',
  QRIS_COOLDOWN_MIN: '3',
});

// ---- AutoGoPay tiruan ----
const axios = require('axios');
const agp = new Map(); const calls = []; let fail = false; let seq = 0;
axios.post = async (url, body) => {
  const p = new URL(url).pathname; calls.push(p);
  if (p === '/qris/generate') {
    if (fail) return { status: 502, data: { success: false, message: 'down' } };
    const id = 'AGP' + (++seq); agp.set(id, { status: 'pending', amount: body.amount });
    const wib = new Date(Date.now() + 15 * 60000 + 7 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
    return { status: 200, data: { success: true, data: { transaction_id: id, qr_string: '000201COM.GO-JEK' + id, checkout_url: 'https://autogopay.site/pay/' + id, expiry_time: wib } } };
  }
  if (p === '/qris/status') { const t = agp.get(body.transaction_id); return { status: 200, data: { success: true, data: { transaction_status: t ? t.status : '', gross_amount: t && t.amount } } }; }
  if (p === '/qris/cancel') { const t = agp.get(body.transaction_id); if (t) t.status = 'cancel'; return { status: 200, data: { success: true } }; }
  throw new Error('axios tak terduga ' + url);
};
const gens = () => calls.filter((c) => c === '/qris/generate').length;

const store = require('./src/utils/store');
const gateway = require('./src/utils/gateway');
const dep = require('./src/handlers/depositHandler');
const { createWebApi } = require('./src/webApi');

let lastCode = null; const sent = []; const photos = []; const deleted = [];
const bot = {
  sendMessage: async (id, text) => { sent.push({ id, text }); const m = String(text).match(/\*(\d{6})\*/); if (m) lastCode = m[1]; return { message_id: 1 }; },
  sendPhoto: async (id, buf, opt) => { photos.push({ id, opt }); return { message_id: 500 + photos.length }; },
  editMessageText: async () => ({}), deleteMessage: async (c, m) => { deleted.push(m); }, answerCallbackQuery: async (id, o) => { sent.push({ id: 'cb', text: o.text }); },
};

(async () => {
  await store.init(() => null);
  const api = createWebApi({ bot, dataSiap: Promise.resolve() });
  const server = http.createServer(api).listen(0);
  const port = server.address().port;
  let cookie = '';
  const call = async (method, p, body) => {
    const r = await fetch(`http://localhost:${port}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, data: await r.json() };
  };
  await call('POST', '/otp', { telegram_id: 111 });
  assert.equal((await call('POST', '/register', { telegram_id: 111, code: lastCode, username: 'budi', password: 'rahasia123' })).status, 200);

  // 1. buat deposit lewat website
  let r = await call('POST', '/deposit', { amount: 10000 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.total, 10000); assert.equal(r.data.credit, 10000); assert.ok(r.data.qr.startsWith('data:image/png'));
  assert.ok(r.data.checkout_url.includes('autogopay.site/pay/')); assert.equal(gens(), 1);
  const ref1 = r.data.ref;
  assert.equal(store.getPendingDeposit(ref1).gateway, 'autogopay');
  console.log('✓ website: deposit lewat AutoGoPay, tanpa biaya, ada link bayar');

  // 2. klik ulang -> QRIS sama
  r = await call('POST', '/deposit', { amount: 25000 });
  assert.equal(r.data.ref, ref1); assert.ok(r.data.reused); assert.equal(gens(), 1);
  console.log('✓ anti-blokir: klik ulang menampilkan QRIS yang sama, tidak generate baru');

  // 3. bayar -> kredit sekali
  r = await call('GET', `/deposit/${ref1}`); assert.equal(r.data.state, 'unpaid');
  agp.get(store.getPendingDeposit(ref1).txn_id).status = 'settlement';
  await new Promise((x) => setTimeout(x, 8100)); // lewati cache status 8 detik
  r = await call('GET', `/deposit/${ref1}`); assert.equal(r.data.state, 'credited'); assert.equal(r.data.balance, 10000);
  r = await call('GET', `/deposit/${ref1}`); assert.equal(r.data.state, 'already'); assert.equal(store.getBalance(111), 10000);
  console.log('✓ settlement → saldo +10.000, tidak dobel');

  // 4. batal -> /qris/cancel, pending hilang, lalu jeda
  r = await call('POST', '/deposit', { amount: 5000 }); const ref2 = r.data.ref; assert.equal(gens(), 2);
  r = await call('POST', `/deposit/${ref2}/cancel`); assert.equal(r.data.state, 'canceled');
  assert.ok(calls.includes('/qris/cancel')); assert.equal(store.getPendingDeposit(ref2), null);
  r = await call('POST', '/deposit', { amount: 5000 }); assert.equal(r.status, 429); assert.match(r.data.error, /Tunggu/); assert.equal(gens(), 2);
  console.log('✓ batal → QRIS dibatalkan di AutoGoPay; deposit baru kena jeda');

  // 5. nominal tidak cocok -> tidak dikredit
  gateway.LIMITS.cooldownMin = 0;
  r = await call('POST', '/deposit', { amount: 5000 }); const ref3 = r.data.ref;
  Object.assign(agp.get(store.getPendingDeposit(ref3).txn_id), { status: 'settlement', amount: 1 });
  r = await call('GET', `/deposit/${ref3}`); assert.equal(r.data.state, 'error'); assert.equal(store.getBalance(111), 10000);
  Object.assign(agp.get(store.getPendingDeposit(ref3).txn_id), { status: 'expire', amount: 5000 });
  await new Promise((x) => setTimeout(x, 8100));
  r = await call('GET', `/deposit/${ref3}`); assert.equal(r.data.state, 'expired');
  console.log('✓ nominal tidak cocok ditolak; QRIS hangus → expired');

  // 6. generate gagal: 1x panggilan, lalu jeda
  gateway.LIMITS.cooldownMin = 3; fail = true; const g0 = gens();
  r = await call('POST', '/deposit', { amount: 5000 }); assert.equal(r.status, 429); // masih jeda dari QRIS hangus
  gateway.LIMITS.cooldownMin = 0;
  r = await call('POST', '/deposit', { amount: 5000 }); assert.equal(r.status, 502); assert.equal(gens(), g0 + 1);
  gateway.LIMITS.cooldownMin = 3;
  r = await call('POST', '/deposit', { amount: 5000 }); assert.equal(r.status, 429); assert.equal(gens(), g0 + 1);
  fail = false; gateway.LIMITS.cooldownMin = 0;
  console.log('✓ generate gagal → 1x panggilan tanpa retry, klik ulang kena jeda');

  // 7. Telegram: QR dikirim dengan tombol Batal & link bayar; klik ulang = QR sama
  const tg = 222;
  await dep.handleDepositAmount(bot, { chat: { id: tg }, message_id: 9, text: '7000' }, { messageId: 8 });
  const ph = photos.at(-1); const kb = JSON.stringify(ph.opt.reply_markup);
  assert.ok(kb.includes('paycancel:') && kb.includes('autogopay.site/pay/'));
  const g1 = gens();
  await dep.handleDepositAmount(bot, { chat: { id: tg }, message_id: 9, text: '9000' }, { messageId: 8 });
  assert.equal(gens(), g1); assert.match(photos.at(-1).opt.caption, /masih punya QRIS/);
  const tref = kb.match(/paycancel:([\w-]+)/)[1];
  await dep.handleDepositCancel(bot, tg, tref, { id: 'q', message: { message_id: 777 } });
  assert.equal(store.getPendingDeposit(tref), null); assert.ok(deleted.includes(777));
  console.log('✓ Telegram: tombol Batal & Bayar via Browser, QR sama saat klik ulang, batal menghapus QR');

  // 8. tak dibayar beruntun, batas harian, rem global, kill switch
  for (let i = 0; i < 5; i++) { gateway.record(333, 'X' + i); gateway.mark('X' + i, 'ended'); }
  let g = gateway.guardNewQris(333); assert.match(g.error, /tidak dibayar/);
  for (let i = 0; i < 8; i++) { gateway.record(444, 'D' + i); gateway.mark('D' + i, i % 2 ? 'paid' : 'ended'); }
  gateway._log.filter((e) => e.user_id === 444).at(-1).status = 'paid';
  g = gateway.guardNewQris(444); assert.match(g.error, /per hari/);
  for (let i = 0; i < 30; i++) gateway.record(1000 + i, 'G' + i);
  g = gateway.guardNewQris(555); assert.ok(g.brake);
  await dep.handleDepositAmount(bot, { chat: { id: 555 }, message_id: 9, text: '5000' }, { messageId: 8 });
  assert.ok(sent.some((m) => m.id === '999' && /REM DARURAT/.test(m.text)), 'admin diberi tahu');
  gateway._log.splice(0);
  process.env.DEPOSIT_ENABLED = '0'; g = gateway.guardNewQris(555); assert.match(g.error, /ditutup/); delete process.env.DEPOSIT_ENABLED;
  console.log('✓ kunci setelah 5 tak dibayar, batas harian, rem darurat + notifikasi admin, kill switch');

  // 9. deposit Pakasir lama tetap dicek ke Pakasir; pemantau dilanjutkan setelah restart
  store.addPendingDeposit('RDP-OLD1', 111, 3000, { txn_id: 'PK1', credit: 3000 });
  const pakasir = require('./src/utils/pakasir'); let pk = 0;
  pakasir.checkStatusByTxn = async () => { pk++; return { status: 'pending', amount: 3000 }; };
  const before = calls.length; await gateway.checkStatus(store.getPendingDeposit('RDP-OLD1'));
  assert.equal(pk, 1); assert.equal(calls.length, before, 'tidak dicek ke AutoGoPay');
  assert.ok(dep.resumePaymentMonitors(bot) >= 1);
  console.log('✓ deposit Pakasir lama dicek ke Pakasir; pemantau dilanjutkan setelah restart');

  server.close();
  console.log('deposit OK');
  process.exit(0);
})().catch((e) => { console.error('✗ GAGAL', e); process.exit(1); });
