// Uji key AutoGoPay yang diatur admin tanpa Environment Render: node test-agpkey.js
// Semua key di sini PALSU.
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
Object.assign(process.env, {
  WEB_SECRET: 'web-secret-uji-'.repeat(4), BOT_TOKEN: '111:TOKEN-UJI', ADMIN_ID: '999,998',
  ADMIN_USERNAME: 'Owner', ADMIN_PASSWORD: 'rahasia-admin-123', AUTOGOPAY_BASE: 'https://agp.test',
  DATA_FILE: path.join(os.tmpdir(), `agpkey-test-${Date.now()}.json`), QRIS_COOLDOWN_MIN: '0',
});
delete process.env.AUTOGOPAY_API_KEY; delete process.env.PAYMENT_PROVIDER;

const GOOD = 'agp_' + 'f00d'.repeat(16);
const BAD = 'agp_' + 'dead'.repeat(16);
const axios = require('axios');
const calls = [];
axios.post = async (url, body, opt) => {
  const p = new URL(url).pathname; const auth = opt.headers.Authorization; calls.push({ p, auth });
  if (auth !== `Bearer ${GOOD}`) return { status: 401, data: { success: false, message: 'Invalid API key' } };
  if (p === '/transactions') return { status: 200, data: { success: true, data: { transactions: [] } } };
  if (p === '/qris/generate') {
    const wib = new Date(Date.now() + 15 * 60000 + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
    return { status: 200, data: { success: true, data: { transaction_id: 'T1', qr_string: '000201QR', checkout_url: null, expiry_time: wib } } };
  }
  return { status: 200, data: { success: false, data: { transaction_status: 'pending' } } };
};

const store = require('./src/utils/store');
const gateway = require('./src/utils/gateway');
const agpConfig = require('./src/utils/agpConfig');
const { registerAgpCommands } = require('./src/handlers/agpAdminHandler');
const { createWebApi } = require('./src/webApi');

const sent = []; const deleted = []; const handlers = [];
const bot = {
  onText: (re, fn) => handlers.push({ re, fn }),
  sendMessage: async (id, text) => { sent.push({ id: String(id), text }); return { message_id: 1 }; },
  deleteMessage: async (chat, mid) => { deleted.push(mid); },
};
const tg = async (from, text, chatType = 'private') => {
  const msg = { message_id: Math.floor(Math.random() * 1e6), from: { id: from }, chat: { id: from, type: chatType }, text };
  for (const h of handlers) if (h.re.test(text)) await h.fn(msg);
  return msg;
};
const lastTo = (id) => sent.filter((m) => m.id === String(id)).at(-1)?.text || '';
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) process.exitCode = 1; };

(async () => {
  await store.init(() => null);
  registerAgpCommands(bot, Promise.resolve());
  ok(gateway.activeGateway() === 'pakasir', 'tanpa key: tetap Pakasir');

  // --- Telegram ---
  let m = await tg(123, `/setagpkey ${GOOD}`);
  ok(deleted.includes(m.message_id) && !agpConfig.apiKey() && lastTo(123) === '', 'bukan admin: pesan dihapus, diabaikan');
  m = await tg(999, `/setagpkey ${GOOD}`, 'supergroup');
  ok(deleted.includes(m.message_id) && /BOCOR/.test(lastTo(999)) && !agpConfig.apiKey(), 'di grup: dihapus, ditolak, diminta buat key baru');
  await tg(999, '/setagpkey bukan-key'); ok(/Format key salah/.test(lastTo(999)), 'format salah ditolak');
  await tg(999, `/setagpkey ${BAD}`); ok(/TIDAK disimpan/.test(lastTo(999)) && !agpConfig.apiKey(), 'key ditolak AutoGoPay tidak disimpan');
  const gens = calls.filter((c) => c.p === '/qris/generate').length;
  m = await tg(999, `/setagpkey@rdpbot ${GOOD}`);
  const reply = lastTo(999);
  ok(deleted.includes(m.message_id) && /disimpan/.test(reply) && reply.includes(agpConfig.mask(GOOD)) && !reply.includes(GOOD), 'admin: tersimpan, balasan hanya key tersamar');
  ok(calls.filter((c) => c.p === '/qris/generate').length === gens, 'verifikasi tidak membuat QRIS');
  ok(/API key diganti/.test(lastTo(998)), 'admin lain diberi tahu perubahan key');
  const raw = JSON.stringify(store.data);
  ok(!raw.includes(GOOD) && !raw.includes('f00df00d') && /^v1:/.test(store.data.autogopay.keyEnc), 'tersimpan TERENKRIPSI di data & cadangan');
  ok(gateway.activeGateway() === 'autogopay' && gateway.isConfigured(), 'key ada → deposit baru lewat AutoGoPay');

  // QRIS memakai key yang disimpan admin
  const p = await gateway.createPayment('RDP-TEST1', 5000);
  ok(p.gateway === 'autogopay' && calls.at(-1).auth === `Bearer ${GOOD}` && p.totalBayar === 5000, 'QRIS dibuat dengan key dari admin');
  const exp = new Date(p.expired_at).getTime() - Date.now();
  ok(exp > 14 * 60000 && exp < 16 * 60000, 'kedaluwarsa UTC+8 terbaca ±15 menit');

  await tg(999, '/agpgateway pakasir'); ok(gateway.activeGateway() === 'pakasir' && /Pakasir/.test(lastTo(999)), '/agpgateway pakasir');
  await tg(999, '/agpgateway auto'); ok(gateway.activeGateway() === 'autogopay', '/agpgateway auto');
  await tg(123, '/agpkey'); ok(lastTo(123) === '', 'bukan admin tidak bisa melihat status');

  // WEB_SECRET berubah -> key lama tidak bisa dibuka (aman), status memberi tahu
  process.env.WEB_SECRET = 'lain';
  ok(agpConfig.apiKey() === null && gateway.activeGateway() === 'pakasir', 'tanpa WEB_SECRET yang sama, key tidak terbuka');
  process.env.WEB_SECRET = 'web-secret-uji-'.repeat(4);
  ok(agpConfig.apiKey() === GOOD, 'WEB_SECRET kembali → key terbuka lagi');

  // env Render tetap didahulukan
  process.env.AUTOGOPAY_API_KEY = 'agp_' + 'e'.repeat(40); process.env.PAYMENT_PROVIDER = 'pakasir';
  ok(agpConfig.apiKey().startsWith('agp_eee') && gateway.activeGateway() === 'pakasir', 'env AUTOGOPAY_API_KEY / PAYMENT_PROVIDER didahulukan');
  delete process.env.AUTOGOPAY_API_KEY; delete process.env.PAYMENT_PROVIDER;

  await tg(999, '/hapusagpkey'); ok(!agpConfig.apiKey() && gateway.activeGateway() === 'pakasir', '/hapusagpkey → kembali ke Pakasir');

  // --- panel admin website ---
  const api = createWebApi({ bot, dataSiap: Promise.resolve() });
  const server = http.createServer(api).listen(0);
  const port = server.address().port;
  let cookie = '';
  const call = async (method, p2, body) => {
    const r = await fetch(`http://localhost:${port}/api${p2}`, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, data: await r.json() };
  };
  ok((await call('GET', '/admin/autogopay')).status === 401, 'tanpa login ditolak');
  assert.equal((await call('POST', '/login', { username: 'Owner', password: 'rahasia-admin-123' })).status, 200);
  let r = await call('POST', '/admin/autogopay', { action: 'key', key: BAD });
  ok(r.status === 400 && /TIDAK disimpan/.test(r.data.error), 'web: key salah ditolak');
  r = await call('POST', '/admin/autogopay', { action: 'key', key: GOOD });
  ok(r.status === 200 && r.data.gateway === 'autogopay' && !JSON.stringify(r.data).includes(GOOD), 'web: key tersimpan, jawaban tanpa key utuh');
  r = await call('GET', '/admin/autogopay');
  ok(r.data.keySource === 'admin' && r.data.keyMasked === agpConfig.mask(GOOD) && /key aktif/.test(r.data.status), 'web: status tersamar + key aktif');
  ok(!JSON.stringify(store.data.adminLog || []).includes(GOOD), 'key tidak tercatat di log admin');
  r = await call('POST', '/admin/autogopay', { action: 'gateway', gateway: 'pakasir' });
  ok(r.data.gateway === 'pakasir', 'web: pindah ke Pakasir');
  r = await call('POST', '/admin/autogopay', { action: 'clear' });
  ok(r.data.keySource === null, 'web: hapus key');

  delete process.env.WEB_SECRET;
  const noSecret = await require('./src/handlers/agpAdminHandler').setKey(bot, GOOD, 'uji');
  ok(!noSecret.ok && /WEB_SECRET/.test(noSecret.message) && !store.data.autogopay.keyEnc, 'tanpa WEB_SECRET key tidak disimpan');

  server.close();
  console.log(process.exitCode ? 'agpkey GAGAL' : 'agpkey OK');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('✗ GAGAL', e); process.exit(1); });
