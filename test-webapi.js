// Uji cepat API website: node test-webapi.js
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
process.env.WEB_SECRET = 'test-secret-'.repeat(4);
process.env.DATA_FILE = path.join(os.tmpdir(), `webapi-test-${Date.now()}.json`);
process.env.ADMIN_ID = '999';
const store = require('./src/utils/store');
// Instalasi palsu: IP berakhiran .1 sukses, selain itu gagal.
const multi = require('./src/handlers/multiInstallHandler');
multi.installOne = async (state) => {
  await new Promise((r) => setTimeout(r, 20));
  state.status = state.ip.endsWith('.1') ? 'success' : 'failed';
  if (state.status === 'success') state.charged = true;
};
const { createWebApi } = require('./src/webApi');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastCode = null;
const sent = [];
const bot = { sendMessage: async (id, text) => {
  sent.push({ id, text });
  const m = text.match(/\*(\d{6})\*/);
  if (m) lastCode = m[1];
  return {};
} };

(async () => {
  await store.init(() => null);
  store.credit(111, 5000, 'deposit');
  const api = createWebApi({ bot, dataSiap: Promise.resolve() });
  const server = http.createServer(api).listen(0);
  const port = server.address().port;
  let cookie = '';
  const call = async (method, p, body) => {
    const r = await fetch(`http://localhost:${port}/api${p}`, {
      method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body)
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, data: await r.json() };
  };

  assert.equal((await call('GET', '/me')).status, 401);
  assert.equal((await call('POST', '/otp', { telegram_id: 111 })).status, 200);
  assert.equal((await call('POST', '/register', { telegram_id: 111, code: '000000', username: 'budi', password: 'rahasia123' })).status, 400);
  assert.equal((await call('POST', '/register', { telegram_id: 111, code: lastCode, username: 'budi', password: 'rahasia123' })).status, 200);
  let me = await call('GET', '/me');
  assert.equal(me.data.balance, 5000, 'saldo web = saldo telegram');
  assert.equal(me.data.admin, false);
  assert.equal((await call('GET', '/admin/stats')).status, 403);

  // Install: saldo ditahan di depan, VPS gagal di-refund. Harga = INSTALLATION_COST bot.
  const { INSTALLATION_COST } = require('./src/config/constants');
  const lines = ['10.0.0.1 pw', '10.0.0.2 pw', '10.0.0.3 pw'].join('\n');
  let r = await call('POST', '/install', { lines, windowsId: 3, rdpPassword: 'Abcdefg1' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(store.getBalance(111), 5000 - 3 * INSTALLATION_COST, 'ditahan di depan');
  assert.equal((await call('GET', '/me')).data.held, 3 * INSTALLATION_COST);
  assert.equal((await call('POST', '/install', { lines, windowsId: 3, rdpPassword: 'Abcdefg1' })).status, 409, 'tidak boleh dobel');
  await sleep(150);
  const job = (await call('GET', `/jobs/${r.data.jobId}`)).data;
  assert.equal(job.status, 'done');
  assert.deepEqual(job.items.map((i) => i.refunded), [false, true, true]);
  assert.equal(store.getBalance(111), 5000 - INSTALLATION_COST, 'hanya VPS sukses yang dibayar');
  assert.equal((await call('GET', '/me')).data.held, 0);
  assert.deepEqual(Object.keys(store.data.holds), []);
  // Saldo tidak cukup -> ditolak, tidak ada yang terpotong
  r = await call('POST', '/install', { lines: Array.from({ length: 5 }, (_, i) => `10.0.1.${i + 1} pw`).join('\n'), windowsId: 3, rdpPassword: 'Abcdefg1' });
  assert.equal(r.status, 402);
  assert.equal(store.getBalance(111), 5000 - INSTALLATION_COST);
  assert.deepEqual(Object.keys(store.data.holds), []);

  // Ganti password
  assert.equal((await call('POST', '/password', { old: 'salah', password: 'rahasia123' })).status, 400);
  assert.equal((await call('POST', '/password', { old: 'rahasia123', password: 'rahasia123' })).status, 200);

  await call('POST', '/logout');
  assert.equal((await call('GET', '/me')).status, 401);
  assert.equal((await call('POST', '/login', { username: 'budi', password: 'salah12345' })).status, 401);
  assert.equal((await call('POST', '/login', { username: 'BUDI', password: 'rahasia123' })).status, 200);
  assert.equal((await call('GET', '/me')).status, 200);

  // Token dirusak -> ditolak
  const good = cookie;
  cookie = good.slice(0, -2) + 'xx';
  assert.equal((await call('GET', '/me')).status, 401);
  cookie = good;

  // Reset password mengeluarkan sesi lama
  await call('POST', '/otp', { telegram_id: 111 });
  const old = cookie;
  assert.equal((await call('POST', '/reset', { telegram_id: 111, code: lastCode, password: 'barubaru99' })).status, 200);
  r = await fetch(`http://localhost:${port}/api/me`, { headers: { cookie: old } });
  assert.equal(r.status, 401, 'sesi lama mati setelah reset');

  // Daftar tanpa Telegram: ID negatif, tidak ada pesan bot ke ID itu.
  await call('POST', '/logout');
  r = await call('POST', '/register', { username: 'webonly', password: 'webonly123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  me = (await call('GET', '/me')).data;
  assert.ok(me.telegram_id < 0 && me.webOnly, 'akun web memakai ID negatif');
  const webId = me.telegram_id;
  assert.equal((await call('POST', '/register', { username: 'webonly2', password: 'webonly123' })).data.ok, true);
  assert.equal((await call('GET', '/me')).data.telegram_id, webId - 1, 'ID web unik');

  // Admin: daftar -> sesi tanpa OTP tidak boleh akses admin
  await call('POST', '/otp', { telegram_id: 999 });
  await call('POST', '/register', { telegram_id: 999, code: lastCode, username: 'bos', password: 'adminadmin' });
  assert.equal((await call('GET', '/me')).data.adminVerified, false);
  assert.equal((await call('GET', '/admin/stats')).status, 403, 'admin wajib OTP');
  // Password salah -> peringatan ke Telegram admin
  sent.length = 0;
  assert.equal((await call('POST', '/login', { username: 'bos', password: 'salahsalah' })).status, 401);
  assert.ok(sent.some((x) => x.id === 999 && /GAGAL/.test(x.text)), 'peringatan login gagal');
  // Login admin -> minta OTP, belum dapat cookie admin
  r = await call('POST', '/login', { username: 'bos', password: 'adminadmin' });
  assert.equal(r.data.otp, true);
  assert.equal((await call('POST', '/login/otp', { challenge: r.data.challenge, code: '000000' })).status, 400);
  sent.length = 0;
  assert.equal((await call('POST', '/login/otp', { challenge: r.data.challenge, code: lastCode })).status, 200);
  assert.ok(sent.some((x) => x.id === 999 && /BERHASIL/.test(x.text)), 'notifikasi login admin');
  assert.equal((await call('POST', '/login/otp', { challenge: r.data.challenge, code: lastCode })).status, 400, 'OTP sekali pakai');
  assert.equal((await call('GET', '/me')).data.adminVerified, true);
  assert.equal((await call('GET', '/admin/stats')).status, 200);
  assert.equal((await call('POST', '/admin/balance', { user_id: webId, amount: 7000 })).data.balance, 7000, 'saldo akun web');
  assert.equal((await call('POST', '/admin/balance', { user_id: 111, amount: -6000 })).status, 400);
  assert.equal((await call('POST', '/admin/balance', { user_id: 111, amount: -1000 })).data.balance, 3000);
  const ov = (await call('GET', '/admin/overview')).data;
  assert.equal(ov.series.length, 14);
  assert.equal(ov.today.revenue, INSTALLATION_COST, 'pendapatan = pemakaian - refund');
  for (const p of ['/admin/users/111', `/admin/users/${webId}`, '/admin/deposits', '/admin/jobs', '/admin/users?q=bud']) {
    assert.equal((await call('GET', p)).status, 200, p);
  }
  assert.equal((await call('POST', '/admin/accounts/budi/password', { password: 'dariadmin1' })).status, 200);

  // Backup: wajib OTP, tanpa hash password, tercatat
  assert.equal((await call('GET', '/admin/export?code=123456')).status, 400);
  assert.equal((await call('POST', '/admin/export/otp')).status, 200);
  const ex = await call('GET', `/admin/export?code=${lastCode}`);
  assert.equal(ex.status, 200);
  assert.ok(ex.data.users && !JSON.stringify(ex.data.webAccounts).includes('hash'), 'backup tanpa hash');

  // Log aktivitas admin mencatat siapa melakukan apa
  const log = (await call('GET', '/admin/log')).data.log;
  for (const a of ['login', 'login_gagal', 'saldo_tambah', 'saldo_kurang', 'akun_reset_password', 'backup_unduh']) {
    assert.ok(log.some((e) => e.action === a), `log ${a}`);
  }
  assert.ok(log.every((e) => e.admin === 'bos'));

  // Restart di tengah instalasi: sisa tahanan dikembalikan saat start.
  store.data.holds.x = { user_id: 111, amount: 2000, at: new Date().toISOString() };
  const before = store.getBalance(111);
  createWebApi({ bot, dataSiap: Promise.resolve() });
  await sleep(10);
  assert.equal(store.getBalance(111), before + 2000);
  assert.deepEqual(Object.keys(store.data.holds), []);
  assert.ok(store.data.webAccounts.budi && !JSON.stringify((await call('GET', '/admin/accounts')).data).includes('hash'));

  console.log('webApi OK');
  server.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
