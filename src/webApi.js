/**
 * API JSON untuk website (folder web/, di-deploy ke Vercel).
 *
 * Website TIDAK punya database sendiri. Semua permintaan diteruskan Vercel ke
 * sini, sehingga saldo, riwayat, dan cadangan Telegram tetap satu sumber —
 * persis yang dipakai bot. Instalasi RDP (15-45 menit) juga berjalan di proses
 * ini, karena fungsi Vercel dihentikan jauh sebelum instalasi selesai.
 *
 * Login: username + password. Akun ditautkan ke ID Telegram lewat kode OTP
 * yang dikirim bot, jadi saldo web = saldo Telegram.
 */
const crypto = require('crypto');
const { promisify } = require('util');
const QRCode = require('qrcode');

const store = require('./utils/store');
const pakasir = require('./utils/pakasir');
const ssh = require('./utils/ssh');
const installLock = require('./utils/installLock');
const DO = require('./utils/digitalocean');
const { detectVPSSpecs } = require('./utils/vpsSpecs');
const { checkVPSSupport } = require('./utils/vpsChecker');
const { calculateAllocation } = require('./utils/specFormatter');
const { parseVpsInput, resolveSSHPort, INPUT_ERROR_MESSAGES } = require('./utils/vpsTarget');
const {
  isValidRdpPassword, RDP_PASSWORD_RULE, isValidVpsPassword, VPS_PASSWORD_RULE, VPS_SYMBOLS
} = require('./utils/password');
const { WINDOWS_VERSIONS, findVersion, getCompatibleVersions } = require('./config/windows');
const { INSTALLATION_COST, VPS_CREATE_COST } = require('./config/constants');
const { isAdmin, hasSufficientBalance, deductBalance } = require('./utils/userManager');
const { safeSend } = require('./utils/telegram');
const { MIN_CPU, MIN_RAM, MIN_STORAGE } = require('./handlers/rdpHandler');
const { installOne, parseTargetLine, friendlyError, MAX_TARGETS } = require('./handlers/multiInstallHandler');
const {
  verifyAndCreditDeposit, startPaymentMonitor, generateUniqueCode, MIN_DEPOSIT, MAX_DEPOSIT
} = require('./handlers/depositHandler');
const broadcastMessage = require('./handlers/broadcastMessage');
const { createSshGateway } = require('./webSsh');

const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_DROPLETS = 10;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const DUMMY_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

/* ============ Password & sesi ============ */

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(pw, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}

async function checkPassword(pw, stored) {
  const [salt, hex] = String(stored || '').split(':');
  if (!salt || !hex) return false;
  const key = await scrypt(pw, salt, 64);
  const expect = Buffer.from(hex, 'hex');
  return expect.length === key.length && crypto.timingSafeEqual(key, expect);
}

function hmac(body) {
  return crypto.createHmac('sha256', process.env.WEB_SECRET).update(body).digest('base64url');
}

/**
 * `pv` = salt password; reset password otomatis mengeluarkan sesi lama.
 * `a`  = 1 kalau admin sudah lolos OTP Telegram. Tanpa itu, akses admin ditolak.
 */
function makeToken(acc, { admin2fa = false } = {}) {
  const body = Buffer.from(JSON.stringify({
    u: acc.username, pv: acc.hash.slice(0, 8), a: admin2fa ? 1 : 0,
    exp: Date.now() + (admin2fa ? ADMIN_SESSION_MS : SESSION_MS)
  })).toString('base64url');
  return `${body}.${hmac(body)}`;
}

function readToken(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expect = hmac(body);
  if (mac.length !== expect.length ||
      !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > Date.now() ? p : null;
  } catch (_) { return null; }
}

function sessionCookie(token, maxAgeSec) {
  return `sid=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}

function accounts() {
  if (!store.data.webAccounts) store.data.webAccounts = {};
  return store.data.webAccounts;
}

function holds() {
  if (!store.data.holds) store.data.holds = {};
  return store.data.holds;
}

function accountByTelegram(tid) {
  return Object.values(accounts()).find((a) => Number(a.telegram_id) === Number(tid)) || null;
}

/* ============ Rate limit (memori) ============ */
// ponytail: limit per proses, cukup karena bot berjalan 1 instance.
const hits = new Map();
function limit(key, max, windowMs) {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return; }
  if (++h.n > max) fail(429, 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.');
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (h.reset < now) hits.delete(k);
}, 10 * 60 * 1000).unref();

/* ============ OTP via bot Telegram ============ */
// kunci -> { code, exp, tries, ...data }. Kunci: telegram_id (daftar/reset),
// "login:<challenge>" (login admin), "export:<uid>" (unduh backup).
const otps = new Map();

/** Cek kode OTP; kembalikan entrinya kalau benar (sekali pakai). */
function useOtp(key, code) {
  const k = String(key);
  const o = otps.get(k);
  if (!o || o.exp < Date.now()) fail(400, 'Kode OTP kadaluarsa. Minta kode baru.');
  if (++o.tries > 5) { otps.delete(k); fail(400, 'Terlalu banyak kode salah. Minta kode baru.'); }
  if (String(code || '').trim() !== o.code) fail(400, 'Kode OTP salah.');
  otps.delete(k);
  return o;
}

/**
 * Akun yang daftar lewat website saja (tanpa Telegram) memakai ID negatif:
 * -1, -2, ... ID user Telegram selalu positif, jadi tidak mungkin bentrok,
 * dan bot tidak pernah mengirim pesan ke ID ini.
 */
function nextWebId() {
  let min = 0;
  for (const k of Object.keys(store.data.users)) { const n = Number(k); if (n < min) min = n; }
  for (const a of Object.values(accounts())) { const n = Number(a.telegram_id); if (n < min) min = n; }
  return min - 1;
}

/** ID user untuk rute admin: ID Telegram (positif) atau akun web (negatif). */
function parseUserId(v) {
  const n = Number(String(v ?? '').trim());
  if (!Number.isInteger(n) || n === 0) fail(400, 'ID user tidak valid.');
  return n;
}

const fmtWaktu = () => new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' }) + ' WIB';
const userAgent = (req) => String(req.headers['user-agent'] || '-').slice(0, 120);

function parseTelegramId(v) {
  const n = Number(String(v || '').trim());
  if (!Number.isInteger(n) || n <= 0) fail(400, 'ID Telegram tidak valid (angka, lihat di menu bot).');
  return n;
}

/* ============ Job instalasi / pembuatan droplet ============ */
const jobs = new Map();

function newJob(userId, kind, extra, id = crypto.randomBytes(8).toString('hex')) {
  const job = { id, userId, kind, status: 'running', created_at: new Date().toISOString(), ...extra };
  jobs.set(id, job);
  return job;
}

// Job selesai disimpan 12 jam supaya hasilnya masih bisa dibuka.
setInterval(() => {
  const batas = Date.now() - 12 * 60 * 60 * 1000;
  for (const [id, j] of jobs) {
    if (j.status === 'done' && new Date(j.created_at).getTime() < batas) jobs.delete(id);
  }
}, 30 * 60 * 1000).unref();

/** Jangan pernah kirim password SSH VPS ke browser. */
function publicJob(j) {
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    created_at: j.created_at,
    title: j.title,
    error: j.error || null,
    items: (j.states || []).map((s) => ({
      ip: s.ip, status: s.status, percent: s.percent || 0, note: s.note || '',
      charged: !!s.charged, refunded: !!s.refunded
    })),
    cost: j.cost || null,
    prepaid: !!j.prepaid,
    droplets: j.droplets || null,
    rootPassword: j.rootPassword || null
  };
}

/* ============ Util HTTP ============ */

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 200_000) { reject(new HttpError(413, 'Data terlalu besar')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new HttpError(400, 'JSON tidak valid')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(JSON.stringify(data));
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function doToken(req) {
  const t = String(req.headers['x-do-token'] || '').trim();
  if (!t) fail(400, 'Token DigitalOcean belum diisi.');
  return t;
}

function doFail(error) {
  const raw = DO.describeError(error);
  fail(raw.startsWith('DO_AUTH') ? 401 : 400, raw.slice(raw.indexOf(':') + 1));
}

/* ============ Rute ============ */

function createWebApi({ bot, dataSiap }) {
  const routes = [];
  const route = (method, pattern, auth, fn) => routes.push({ method, pattern, auth, fn });

  /* ---------- Auth ---------- */

  /** Kirim pesan Telegram hanya ke user Telegram (ID positif). Gagal kirim diabaikan. */
  const notify = (chatId, text) => {
    if (Number(chatId) > 0) safeSend(bot, chatId, text).catch(() => {});
  };

  /** Catatan aktivitas admin — siapa, kapan, dari mana, melakukan apa. */
  const audit = (ctx, action, detail = '', admin = ctx.acc && ctx.acc.username) => {
    if (!store.data.adminLog) store.data.adminLog = [];
    const log = store.data.adminLog;
    log.push({ at: new Date().toISOString(), admin: admin || '-', action, detail: String(detail).slice(0, 300), ip: ctx.ip });
    if (log.length > 3000) log.splice(0, log.length - 2000);
    store.saveNow();
  };

  /** Buat & kirim kode OTP lewat bot. Gagal kirim = error yang jelas, bukan diam. */
  async function sendCode(chatId, key, intro, extra = {}) {
    const code = String(crypto.randomInt(100000, 1000000));
    try {
      await bot.sendMessage(chatId, `${intro}\n\nKode: *${code}*\nBerlaku 10 menit. Jangan berikan kode ini ke siapa pun.`, { parse_mode: 'Markdown' });
    } catch (_) {
      fail(503, 'Kode tidak bisa dikirim ke Telegram. Pastikan sudah menekan /start di bot dan BOT_TOKEN di server benar.');
    }
    otps.set(String(key), { code, exp: Date.now() + 10 * 60 * 1000, tries: 0, ...extra });
  }

  route('POST', /^\/otp$/, null, async ({ body, ip }) => {
    const tid = parseTelegramId(body.telegram_id);
    limit(`otp:${tid}`, 3, 10 * 60 * 1000);
    limit(`otpip:${ip}`, 10, 10 * 60 * 1000);
    const code = String(crypto.randomInt(100000, 1000000));
    try {
      await bot.sendMessage(tid,
        `🔐 Kode verifikasi website: *${code}*\n\nBerlaku 10 menit. Abaikan kalau bukan Anda yang meminta.`,
        { parse_mode: 'Markdown' });
    } catch (_) {
      fail(400, 'Bot tidak bisa mengirim pesan ke ID ini. Buka bot Telegram dan tekan /start dulu.');
    }
    otps.set(String(tid), { code, exp: Date.now() + 10 * 60 * 1000, tries: 0 });
    return { ok: true };
  });

  /**
   * Daftar akun. Dua cara:
   *  - Website saja: cukup username + password (tidak butuh Telegram).
   *  - Tautkan saldo bot Telegram: tambah telegram_id + kode OTP dari bot.
   */
  route('POST', /^\/register$/, null, async ({ body, ip }) => {
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const link = body.telegram_id !== undefined && String(body.telegram_id).trim() !== '';
    if (!/^[a-z0-9_]{3,20}$/.test(username)) fail(400, 'Username 3-20 karakter: huruf kecil, angka, atau _.');
    if (password.length < 8) fail(400, 'Password minimal 8 karakter.');
    if (accounts()[username]) fail(409, 'Username sudah dipakai.');

    let tid = null;
    if (link) {
      tid = parseTelegramId(body.telegram_id);
      if (accountByTelegram(tid)) fail(409, 'ID Telegram ini sudah punya akun. Pakai "Lupa password".');
      useOtp(tid, body.code);
    } else {
      limit(`reg:${ip}`, 5, 60 * 60 * 1000);
      // IP di header bisa dipalsukan; batas global mencegah banjir akun spam.
      limit('reg:all', 60, 60 * 60 * 1000);
    }

    const hash = await hashPassword(password);
    // Cek ulang setelah await: dua pendaftaran bersamaan tidak boleh sama-sama lolos.
    if (accounts()[username] || (link && accountByTelegram(tid))) fail(409, 'Username atau ID Telegram sudah terdaftar.');
    const uid = link ? tid : nextWebId();
    const acc = { username, hash, telegram_id: uid, web_only: !link, created_at: new Date().toISOString() };
    accounts()[username] = acc;
    store.getUser(uid);
    store.saveNow();
    return { ok: true, _cookie: makeToken(acc) };
  });

  route('POST', /^\/reset$/, null, async ({ body }) => {
    const tid = parseTelegramId(body.telegram_id);
    const password = String(body.password || '');
    if (password.length < 8) fail(400, 'Password minimal 8 karakter.');
    const acc = accountByTelegram(tid);
    if (!acc) fail(404, 'Belum ada akun untuk ID Telegram ini. Silakan daftar.');
    useOtp(tid, body.code);
    acc.hash = await hashPassword(password);
    store.saveNow();
    return { ok: true, username: acc.username, _cookie: makeToken(acc) };
  });

  route('POST', /^\/login$/, null, async (ctx) => {
    const { body, ip } = ctx;
    const username = String(body.username || '').trim().toLowerCase();
    limit(`login:${ip}`, 20, 15 * 60 * 1000);
    limit(`loginu:${username}`, 10, 15 * 60 * 1000);
    const acc = accounts()[username];
    // Tetap hitung scrypt walau username tidak ada, supaya waktu respons tidak membocorkan username.
    const ok = (await checkPassword(String(body.password || ''), acc ? acc.hash : DUMMY_HASH)) && !!acc;
    const adminAcc = acc && isAdmin(acc.telegram_id);
    if (!ok) {
      if (adminAcc) {
        audit(ctx, 'login_gagal', 'password salah', username);
        // Maks 1 peringatan per 10 menit supaya Telegram admin tidak dibanjiri.
        if (!hits.has(`warn:${username}`)) {
          hits.set(`warn:${username}`, { n: 1, reset: Date.now() + 10 * 60 * 1000 });
          notify(acc.telegram_id, `⚠️ Percobaan login admin GAGAL (password salah)\n👤 ${username}\n🌐 IP ${ctx.ip}\n🕒 ${fmtWaktu()}\n\nKalau bukan Anda, segera ganti password.`);
        }
      }
      fail(401, 'Username atau password salah.');
    }

    // Admin wajib langkah kedua: kode OTP ke Telegram admin.
    if (adminAcc) {
      const challenge = crypto.randomBytes(16).toString('hex');
      await sendCode(acc.telegram_id, `login:${challenge}`,
        `🔐 Login admin website\n👤 ${username}\n🌐 IP ${ctx.ip}\n🕒 ${fmtWaktu()}`, { username });
      return { otp: true, challenge };
    }
    return { ok: true, _cookie: makeToken(acc) };
  });

  route('POST', /^\/login\/otp$/, null, async (ctx) => {
    const challenge = String(ctx.body.challenge || '');
    limit(`loginotp:${ctx.ip}`, 20, 15 * 60 * 1000);
    if (!/^[a-f0-9]{32}$/.test(challenge)) fail(400, 'Sesi login tidak valid. Ulangi login.');
    const entry = useOtp(`login:${challenge}`, ctx.body.code);
    const acc = accounts()[entry.username];
    if (!acc || !isAdmin(acc.telegram_id)) fail(401, 'Akun tidak ditemukan. Ulangi login.');
    audit(ctx, 'login', userAgent(ctx.req), acc.username);
    notify(acc.telegram_id, `✅ Login admin website BERHASIL\n👤 ${acc.username}\n🌐 IP ${ctx.ip}\n💻 ${userAgent(ctx.req)}\n🕒 ${fmtWaktu()}\n\nKalau bukan Anda, segera ganti password admin.`);
    return { ok: true, _cookie: makeToken(acc, { admin2fa: true }) };
  });

  route('POST', /^\/logout$/, null, async () => ({ ok: true, _cookie: '' }));

  /* ---------- Publik ---------- */

  route('GET', /^\/info$/, null, async () => ({
    installCost: INSTALLATION_COST,
    vpsCreateCost: VPS_CREATE_COST,
    minSpecs: { cpu: MIN_CPU, ram: MIN_RAM, storage: MIN_STORAGE },
    windowsCount: WINDOWS_VERSIONS.length
  }));

  /* ---------- SSH online: tiket sekali pakai untuk WebSocket ---------- */
  const sshTickets = new Map(); // ticket -> { uid, username, exp }
  const takeTicket = (ticket) => {
    const t = sshTickets.get(String(ticket || ''));
    if (!t) return null;
    sshTickets.delete(String(ticket));
    return t.exp > Date.now() ? t : null;
  };

  route('POST', /^\/ssh\/ticket$/, 'user', async ({ uid, acc }) => {
    limit(`ssh:${uid}`, 30, 10 * 60 * 1000);
    const now = Date.now();
    for (const [k, t] of sshTickets) if (t.exp < now) sshTickets.delete(k);
    const ticket = crypto.randomBytes(24).toString('hex');
    sshTickets.set(ticket, { uid, username: acc.username, exp: now + 60 * 1000 });
    // Vercel tidak meneruskan WebSocket: browser langsung ke server bot.
    const base = (process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL ||
      `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
    return { ticket, wsUrl: `${base.replace(/^http/, 'ws')}/api/ssh/ws` };
  });

  /* ---------- User ---------- */

  route('GET', /^\/me$/, 'user', async ({ acc, uid, admin }) => ({
    username: acc.username,
    telegram_id: uid,
    webOnly: uid < 0,
    admin: isAdmin(uid),
    adminVerified: admin,
    balance: store.getBalance(uid),
    installCost: INSTALLATION_COST,
    vpsCreateCost: VPS_CREATE_COST,
    minSpecs: { cpu: MIN_CPU, ram: MIN_RAM, storage: MIN_STORAGE },
    installing: installLock.isLocked(uid),
    held: Object.values(holds()).filter((h) => Number(h.user_id) === uid).reduce((n, h) => n + h.amount, 0)
  }));

  route('POST', /^\/password$/, 'user', async ({ body, acc, admin }) => {
    const password = String(body.password || '');
    if (password.length < 8) fail(400, 'Password baru minimal 8 karakter.');
    if (!(await checkPassword(String(body.old || ''), acc.hash))) fail(400, 'Password lama salah.');
    acc.hash = await hashPassword(password);
    store.saveNow();
    return { ok: true, _cookie: makeToken(acc, { admin2fa: admin }) };
  });

  route('GET', /^\/history$/, 'user', async ({ uid }) => ({
    transactions: store.transactionsFor(uid, 100),
    installations: store.data.installations
      .filter((r) => Number(r.user_id) === uid).slice(-100).reverse()
  }));

  route('GET', /^\/windows$/, 'user', async () => ({
    versions: WINDOWS_VERSIONS, rdpRule: RDP_PASSWORD_RULE, maxTargets: MAX_TARGETS
  }));

  /* ---------- Deposit ---------- */

  route('POST', /^\/deposit$/, 'user', async ({ body, uid }) => {
    if (!pakasir.isConfigured()) fail(503, 'Pembayaran belum dikonfigurasi admin.');
    const amount = parseInt(String(body.amount || '').replace(/\D/g, ''), 10);
    if (!amount || amount < MIN_DEPOSIT || amount > MAX_DEPOSIT) {
      fail(400, `Nominal harus Rp ${MIN_DEPOSIT.toLocaleString('id-ID')} – Rp ${MAX_DEPOSIT.toLocaleString('id-ID')}.`);
    }
    limit(`dep:${uid}`, 10, 10 * 60 * 1000);
    const ref = generateUniqueCode();
    let p;
    try {
      p = await pakasir.createPayment(ref, amount);
    } catch (error) {
      console.error('[WEB DEPOSIT]', error.message);
      fail(502, /QRIS|Nominal|minimal|maksimal/i.test(error.message) ? error.message : 'Gagal membuat QRIS. Coba lagi.');
    }
    store.addPendingDeposit(ref, uid, amount, {
      txn_id: p.txnId, credit: p.amount, gateway_amount: p.gatewayAmount,
      total_payment: p.totalBayar, fee_payer: p.feePayer, expired_at: p.expired_at
    });
    startPaymentMonitor(bot, ref);
    return {
      ref,
      amount,
      total: p.totalBayar,
      credit: p.amount,
      expired_at: p.expired_at,
      sandbox: p.isSandbox,
      qr: await QRCode.toDataURL(p.qr_string, { width: 400, margin: 1 })
    };
  });

  route('GET', /^\/deposit\/([\w-]+)$/, 'user', async ({ uid, m }) => {
    const ref = m[1];
    const pending = store.getPendingDeposit(ref);
    if (!pending) {
      const done = store.data.deposits && store.data.deposits[ref];
      if (done && Number(done.user_id) === uid) return { state: 'already', balance: store.getBalance(uid) };
      fail(404, 'Transaksi tidak ditemukan atau sudah kadaluarsa.');
    }
    if (Number(pending.user_id) !== uid) fail(404, 'Transaksi tidak ditemukan.');
    const { state } = await verifyAndCreditDeposit(bot, ref);
    return { state, balance: store.getBalance(uid) };
  });

  /* ---------- Install RDP ---------- */

  // Cek VPS dulu (spesifikasi, KVM, versi Windows yang muat). Tidak memotong saldo.
  route('POST', /^\/install\/check$/, 'user', async ({ body, uid }) => {
    limit(`check:${uid}`, 20, 10 * 60 * 1000);
    const parsed = parseVpsInput(body.target);
    if (parsed.error) fail(400, INPUT_ERROR_MESSAGES[parsed.error] || 'Format IP tidak valid.');
    if (!body.password) fail(400, 'Password VPS kosong.');

    const resolved = await resolveSSHPort(parsed.ip, parsed.port);
    if (!resolved.port) fail(400, 'Port SSH tidak ditemukan. Pastikan VPS menyala dan firewall mengizinkan SSH.');

    const target = { host: parsed.ip, port: resolved.port, username: parsed.username || 'root', password: String(body.password) };
    let conn;
    try {
      conn = await ssh.connectWithRetry(target, { percobaan: 3 });
      const raw = await detectVPSSpecs(conn);
      const kvm = await checkVPSSupport(conn);
      const alloc = calculateAllocation(raw);
      const problems = [];
      if (raw.cpu < MIN_CPU) problems.push(`CPU ${raw.cpu} core (minimal ${MIN_CPU})`);
      if (alloc.ram < MIN_RAM) problems.push(`RAM ${alloc.ram} GB (minimal ${MIN_RAM} GB)`);
      if (alloc.storage < MIN_STORAGE) problems.push(`Disk tersisa ${alloc.storage} GB (minimal ${MIN_STORAGE} GB)`);
      return {
        ip: parsed.ip,
        port: resolved.port,
        allocation: alloc,
        arch: raw.arch,
        isArm: raw.isArm,
        kvm: kvm.supported,
        problems,
        compatible: getCompatibleVersions(alloc).map((v) => v.id)
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      fail(400, friendlyError(error));
    } finally {
      try { if (conn) conn.end(); } catch (_) {}
    }
  });

  // Satu jalur untuk install satuan & multi: `lines` = "IP PASSWORD" per baris.
  route('POST', /^\/install$/, 'user', async ({ body, uid }) => {
    if (installLock.isLocked(uid)) fail(409, 'Masih ada instalasi Anda yang berjalan. Tunggu selesai dulu.');
    const version = findVersion(body.windowsId);
    if (!version) fail(400, 'Pilih versi Windows.');
    const rdpPassword = String(body.rdpPassword || '');
    if (!isValidRdpPassword(rdpPassword)) fail(400, `Password RDP: ${RDP_PASSWORD_RULE}.`);

    const seen = new Set();
    const targets = [];
    for (const line of String(body.lines || '').split('\n')) {
      const t = parseTargetLine(line);
      if (t === null) continue;
      if (t.error) fail(400, `Baris "${t.raw}": ${t.error}`);
      if (seen.has(t.ip)) continue;
      seen.add(t.ip);
      targets.push(t);
    }
    if (!targets.length) fail(400, 'Isi minimal satu VPS.');
    if (targets.length > MAX_TARGETS) fail(400, `Maksimal ${MAX_TARGETS} VPS per batch.`);

    // Harga sama dengan bot Telegram (INSTALLATION_COST per VPS). Di website
    // saldo DITAHAN di depan, lalu dikembalikan per VPS yang gagal/dilewati.
    // Dengan begitu saldo tidak bisa terpakai di tempat lain selama instalasi,
    // dan user tetap tidak rugi kalau gagal.
    const cost = INSTALLATION_COST;
    const total = targets.length * cost;
    const prepaid = !isAdmin(uid);
    const jobId = crypto.randomBytes(8).toString('hex');
    if (prepaid) {
      // Sinkron (tanpa await): potong + catat tahanan tersimpan bersamaan.
      holds()[jobId] = { user_id: uid, amount: total, at: new Date().toISOString() };
      const hasil = store.debit(uid, total, 'install');
      if (!hasil.ok) {
        delete holds()[jobId];
        fail(402, `Saldo tidak cukup. Butuh Rp ${total.toLocaleString('id-ID')} (Rp ${cost.toLocaleString('id-ID')} × ${targets.length} VPS).`);
      }
    }

    installLock.lock(uid);
    const states = targets.map((t) => ({
      ip: t.ip, port: t.port, username: t.username, password: t.password,
      status: 'queued', percent: 0, note: '', charged: false, refunded: false
    }));
    const job = newJob(uid, 'install', { title: version.name, states, cost, prepaid }, jobId);

    /** Selesaikan tahanan satu VPS: sukses = biaya jadi, selain itu = refund. */
    const settle = (s) => {
      const h = holds()[jobId];
      if (!prepaid || !h) return;
      h.amount -= cost;                       // ubah tahanan DULU, supaya ikut tersimpan
      if (h.amount <= 0) delete holds()[jobId];
      if (s.status === 'success') store.saveNow();
      else { store.credit(uid, cost, 'refund_install_failed'); s.refunded = true; }
    };

    Promise.all(states.map((s) => installOne(s, version, rdpPassword, uid, { prepaid })
      .catch((err) => { s.status = 'failed'; s.note = friendlyError(err); })
      .then(() => settle(s))))
      .finally(() => {
        installLock.unlock(uid);
        for (const s of states) delete s.password;
        job.status = 'done';
        const ok = states.filter((s) => s.status === 'success').length;
        const refund = states.filter((s) => s.refunded).length * cost;
        notify(uid,
          `🖥️ Instalasi via website selesai: ${ok}/${states.length} VPS berhasil (${version.name}).` +
          (refund ? `\n💰 Rp ${refund.toLocaleString('id-ID')} dikembalikan ke saldo untuk VPS yang gagal.` : ''));
      });

    return { jobId };
  });

  route('GET', /^\/jobs$/, 'user', async ({ uid }) => ({
    jobs: [...jobs.values()].filter((j) => j.userId === uid).reverse().map(publicJob)
  }));

  route('GET', /^\/jobs\/(\w+)$/, 'user', async ({ uid, m, admin }) => {
    const j = jobs.get(m[1]);
    if (!j || (j.userId !== uid && !admin)) fail(404, 'Proses tidak ditemukan (mungkin bot baru restart).');
    const out = publicJob(j);
    if (j.userId !== uid) out.rootPassword = null;
    return out;
  });

  /* ---------- DigitalOcean (token dikirim browser tiap permintaan, tidak disimpan) ---------- */

  route('GET', /^\/do\/options$/, 'user', async () => ({
    regions: DO.DO_REGIONS, sizes: DO.DO_SIZES, images: DO.DO_IMAGES,
    maxDroplets: MAX_DROPLETS, cost: VPS_CREATE_COST, passwordRule: VPS_PASSWORD_RULE, symbols: VPS_SYMBOLS
  }));

  route('GET', /^\/do\/account$/, 'user', async ({ req }) => {
    const token = doToken(req);
    const v = await DO.validateToken(token);
    if (!v.ok) fail(401, v.error.slice(v.error.indexOf(':') + 1));
    return { email: v.email, status: v.status, dropletLimit: v.dropletLimit, billing: await DO.getBalance(token) };
  });

  route('GET', /^\/do\/droplets$/, 'user', async ({ req, url }) => {
    const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
    try { return await DO.listDroplets(doToken(req), { page, perPage: 20 }); }
    catch (e) { if (e instanceof HttpError) throw e; doFail(e); }
  });

  const doCall = async (fn) => {
    try { return await fn(); } catch (e) { if (e instanceof HttpError) throw e; doFail(e); }
  };

  route('GET', /^\/do\/droplets\/(\d+)$/, 'user', async ({ req, m }) => {
    const token = doToken(req);
    return doCall(async () => {
      const [droplet, actions, images] = await Promise.all([
        DO.getDropletInfo(token, m[1]),
        DO.listDropletActions(token, m[1]).catch(() => []),
        DO.listDropletImages(token, m[1]).catch(() => [])
      ]);
      return { droplet, actions, images };
    });
  });

  // Aksi berparameter: resize, rebuild, rename, restore, snapshot, backup, ipv6.
  route('POST', /^\/do\/droplets\/(\d+)\/action$/, 'user', async ({ req, m, body }) => {
    const token = doToken(req);
    const type = String(body.type || '');
    const a = { type };
    if (type === 'resize') {
      if (!/^[a-z0-9-]{2,40}$/.test(String(body.size || ''))) fail(400, 'Pilih ukuran baru.');
      a.size = body.size;
      a.disk = !!body.disk;
    } else if (type === 'rebuild' || type === 'restore') {
      const img = String(body.image || '');
      if (!/^[a-z0-9-]{2,60}$/.test(img)) fail(400, 'Pilih image.');
      a.image = /^\d+$/.test(img) ? Number(img) : img;
      if (type === 'restore' && typeof a.image !== 'number') fail(400, 'Restore butuh ID snapshot/backup.');
    } else if (type === 'rename') {
      if (!/^[a-zA-Z0-9.-]{1,63}$/.test(String(body.name || ''))) fail(400, 'Nama hanya huruf, angka, titik, dan tanda hubung.');
      a.name = body.name;
    } else if (type === 'snapshot') {
      a.name = String(body.name || `snap-${m[1]}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`).slice(0, 100);
    }
    return doCall(async () => ({ action: await DO.dropletActionRaw(token, m[1], a) }));
  });

  route('GET', /^\/do\/sizes$/, 'user', async ({ req }) => doCall(async () => ({ sizes: await DO.listSizes(doToken(req)) })));

  route('GET', /^\/do\/snapshots$/, 'user', async ({ req }) => doCall(async () => ({ snapshots: await DO.listSnapshots(doToken(req)) })));

  route('DELETE', /^\/do\/snapshots\/(\d+)$/, 'user', async ({ req, m }) => doCall(async () => ({ ok: await DO.deleteSnapshot(doToken(req), m[1]) })));

  route('GET', /^\/do\/keys$/, 'user', async ({ req }) => doCall(async () => ({ keys: await DO.listSshKeys(doToken(req)) })));

  route('POST', /^\/do\/keys$/, 'user', async ({ req, body }) => {
    const name = String(body.name || '').trim().slice(0, 60);
    const pub = String(body.public_key || '').trim();
    if (!name) fail(400, 'Nama key wajib diisi.');
    if (!/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp\d+|sk-[a-z0-9@.-]+) [A-Za-z0-9+/=]+/.test(pub)) fail(400, 'Public key tidak valid (mulai dengan ssh-ed25519 / ssh-rsa ...).');
    return doCall(async () => ({ key: await DO.addSshKey(doToken(req), name, pub) }));
  });

  route('DELETE', /^\/do\/keys\/(\d+)$/, 'user', async ({ req, m }) => doCall(async () => ({ ok: await DO.deleteSshKey(doToken(req), m[1]) })));

  route('POST', /^\/do\/droplets\/(\d+)\/(\w+)$/, 'user', async ({ req, m }) => {
    const token = doToken(req);
    const [, id, key] = m;
    try {
      if (key === 'delete') await DO.deleteDroplet(token, id);
      else if (DO.DROPLET_ACTIONS[key]) await DO.dropletAction(token, id, key);
      else fail(400, 'Aksi tidak dikenal.');
    } catch (e) { if (e instanceof HttpError) throw e; doFail(e); }
    return { ok: true };
  });

  route('POST', /^\/do\/create$/, 'user', async ({ req, body, uid }) => {
    const token = doToken(req);
    const count = parseInt(body.count, 10);
    // Image: slug OS dari daftar, atau ID snapshot milik user (angka).
    const image = /^\d{1,12}$/.test(String(body.image)) ? Number(body.image) : body.image;
    if (!DO.findRegion(body.region) || !DO.findSize(body.size) || !(typeof image === 'number' || DO.findImage(image))) fail(400, 'Pilihan droplet tidak valid.');
    if (!Number.isInteger(count) || count < 1 || count > MAX_DROPLETS) fail(400, `Jumlah 1-${MAX_DROPLETS}.`);
    const rootPassword = body.rootPassword ? String(body.rootPassword) : DO.genPassword(16);
    if (!isValidVpsPassword(rootPassword)) fail(400, `Password root: ${VPS_PASSWORD_RULE}.`);
    const userData = String(body.userData || '');
    if (Buffer.byteLength(userData) > 60 * 1024) fail(400, 'Cloud-init maksimal 60 KB.');
    const sshKeys = (Array.isArray(body.sshKeys) ? body.sshKeys : []).slice(0, 20).map(Number).filter(Number.isInteger);
    const tags = (Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(','))
      .map((x) => String(x).trim().toLowerCase()).filter((x) => /^[a-z0-9:_-]{1,40}$/.test(x)).slice(0, 10);
    if (!(await hasSufficientBalance(uid, VPS_CREATE_COST))) fail(402, 'Saldo tidak cukup.');
    limit(`docreate:${uid}`, 5, 10 * 60 * 1000);

    const ts = Date.now().toString(36);
    // Hostname tidak boleh diawali tanda minus: akun web (ID negatif) jadi 'w1', 'w2', ...
    const names = Array.from({ length: count }, (_, i) => `rdp-${String(uid).replace('-', 'w')}-${ts}-${i + 1}`);
    let created;
    try {
      created = await DO.createDroplets({
        token, names, region: body.region, size: body.size, image, rootPassword,
        userData, sshKeys, tags, backups: !!body.backups, monitoring: !!body.monitoring, ipv6: body.ipv6 !== false
      });
    } catch (e) { doFail(e); }
    if (!created.length) fail(502, 'DigitalOcean tidak mengembalikan droplet apa pun.');

    // Droplet sudah jadi — baru potong biaya layanan, flat sekali.
    if (!isAdmin(uid) && !(await deductBalance(uid, VPS_CREATE_COST))) {
      console.error(`[WEB DO BILLING] Gagal memotong saldo user ${uid} setelah droplet dibuat.`);
    }

    const job = newJob(uid, 'do_create', {
      title: `${count} droplet ${body.size}`,
      rootPassword,
      droplets: created.map((d) => ({ id: d.id, name: d.name, ip: null, status: d.status }))
    });
    DO.waitForDroplets({ token, ids: created.map((d) => d.id), onTick: (list) => { job.droplets = list; } })
      .then((list) => { job.droplets = list; })
      .catch((e) => { job.error = e.message; })
      .finally(() => { job.status = 'done'; });

    return { jobId: job.id };
  });

  /* ---------- Admin ---------- */

  route('GET', /^\/admin\/stats$/, 'admin', async () => {
    const s = store.stats();
    return {
      users: s.users,
      totalSaldo: s.totalSaldo,
      transactions: s.transactions,
      installations: s.installations,
      deposits: s.deposits,
      webAccounts: Object.keys(accounts()).length,
      runningJobs: [...jobs.values()].filter((j) => j.status === 'running').length,
      backupOk: s.bolehCadangkan,
      backupLockReason: s.alasanKunci,
      updated_at: s.updated_at
    };
  });

  route('GET', /^\/admin\/users$/, 'admin', async ({ url }) => {
    // "Web #3" = akun website dengan ID -3.
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase().replace(/^web\s*#\s*/, '-');
    const byTid = new Map(Object.values(accounts()).map((a) => [Number(a.telegram_id), a.username]));
    let rows = Object.values(store.data.users).map((u) => ({
      telegram_id: u.telegram_id,
      username: byTid.get(Number(u.telegram_id)) || null,
      balance: Number(u.balance) || 0,
      created_at: u.created_at
    }));
    if (q) rows = rows.filter((r) => String(r.telegram_id).includes(q) || (r.username || '').includes(q));
    rows.sort((a, b) => b.balance - a.balance);
    return { total: rows.length, users: rows.slice(0, 200) };
  });

  route('POST', /^\/admin\/balance$/, 'admin', async (ctx) => {
    const { body } = ctx;
    const tid = parseUserId(body.user_id);
    const amount = parseInt(body.amount, 10);
    if (!Number.isInteger(amount) || amount === 0) fail(400, 'Jumlah tidak valid (boleh minus untuk mengurangi).');
    if (Math.abs(amount) > 100_000_000) fail(400, 'Jumlah terlalu besar.');
    const sebelum = store.getBalance(tid);
    const hasil = amount > 0 ? store.credit(tid, amount, 'admin') : store.debit(tid, -amount, 'admin_deduct');
    if (!hasil.ok) fail(400, 'Saldo user tidak cukup untuk dikurangi sebanyak itu.');
    audit(ctx, amount > 0 ? 'saldo_tambah' : 'saldo_kurang',
      `user ${tid}: ${amount > 0 ? '+' : '-'}Rp ${Math.abs(amount).toLocaleString('id-ID')} (Rp ${sebelum.toLocaleString('id-ID')} → Rp ${Number(hasil.balance).toLocaleString('id-ID')})`);
    notify(tid,
      `💰 Saldo Anda ${amount > 0 ? 'ditambah' : 'dikurangi'} admin sebesar Rp ${Math.abs(amount).toLocaleString('id-ID')}.\n` +
      `💳 Saldo sekarang: Rp ${Number(hasil.balance).toLocaleString('id-ID')}`);
    return { ok: true, balance: hasil.balance };
  });

  route('GET', /^\/admin\/transactions$/, 'admin', async ({ url }) => {
    const tid = Number(url.searchParams.get('user_id')) || null;
    const list = tid ? store.transactionsFor(tid, 200) : store.data.transactions.slice(-200).reverse();
    return { transactions: list };
  });

  route('GET', /^\/admin\/installations$/, 'admin', async () => ({
    installations: store.data.installations.slice(-200).reverse()
  }));

  route('GET', /^\/admin\/accounts$/, 'admin', async () => ({
    accounts: Object.values(accounts()).map(({ hash, ...a }) => a)
  }));

  route('DELETE', /^\/admin\/accounts\/(\w+)$/, 'admin', async (ctx) => {
    const acc = accounts()[ctx.m[1]];
    if (!acc) fail(404, 'Akun tidak ditemukan.');
    if (acc.username === ctx.acc.username) fail(400, 'Tidak bisa menghapus akun sendiri.');
    delete accounts()[ctx.m[1]];
    audit(ctx, 'akun_hapus', `${acc.username} (user ${acc.telegram_id})`);
    return { ok: true };
  });

  route('POST', /^\/admin\/broadcast$/, 'admin', async (ctx) => {
    const { body, uid } = ctx;
    const message = String(body.message || '').trim();
    if (!message) fail(400, 'Pesan kosong.');
    audit(ctx, 'broadcast', message.slice(0, 200));
    // Berjalan di latar belakang; laporan dikirim bot ke Telegram admin.
    broadcastMessage(bot, message, uid).catch((e) => console.error('[WEB BROADCAST]', e.message));
    return { ok: true, targets: store.listUserIds().filter((id) => Number(id) > 0).length };
  });

  route('GET', /^\/admin\/overview$/, 'admin', async () => {
    const DAYS = 14;
    const day = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
    const keys = Array.from({ length: DAYS }, (_, i) => day(Date.now() - (DAYS - 1 - i) * 864e5));
    const series = Object.fromEntries(keys.map((k) => [k, { day: k, deposit: 0, revenue: 0, success: 0, failed: 0 }]));
    const today = keys[keys.length - 1];

    // Pendapatan = pemakaian dikurangi refund (tahanan yang dikembalikan tidak dihitung).
    for (const t of store.data.transactions) {
      const row = series[day(t.created_at)];
      if (!row) continue;
      const n = Number(t.amount) || 0;
      if (t.type === 'deposit') row.deposit += n;
      else if (t.type === 'deduct' || t.type === 'install' || String(t.type).startsWith('refund')) row.revenue -= n;
    }
    for (const r of store.data.installations) {
      const row = series[day(r.created_at)];
      if (!row) continue;
      if (String(r.status).startsWith('success')) row.success++;
      else if (r.status === 'failed') row.failed++;
    }
    const s = store.stats();
    return {
      series: keys.map((k) => series[k]),
      today: series[today],
      newUsersToday: Object.values(store.data.users).filter((u) => u.created_at && day(u.created_at) === today).length,
      users: s.users,
      totalSaldo: s.totalSaldo,
      webAccounts: Object.keys(accounts()).length,
      pendingDeposits: Object.keys(store.data.pendingDeposits || {}).length,
      runningJobs: [...jobs.values()].filter((j) => j.status === 'running').length,
      held: Object.values(holds()).reduce((n, h) => n + h.amount, 0),
      installCost: INSTALLATION_COST,
      backupOk: s.bolehCadangkan,
      backupLockReason: s.alasanKunci,
      updated_at: s.updated_at
    };
  });

  route('GET', /^\/admin\/users\/(-?\d+)$/, 'admin', async ({ m }) => {
    const tid = Number(m[1]);
    const u = store.data.users[String(tid)];
    if (!u) fail(404, 'User tidak ditemukan.');
    const acc = accountByTelegram(tid);
    return {
      user: { telegram_id: tid, balance: Number(u.balance) || 0, created_at: u.created_at, admin: isAdmin(tid) },
      account: acc ? { username: acc.username, created_at: acc.created_at, web_only: !!acc.web_only } : null,
      installing: installLock.isLocked(tid),
      transactions: store.transactionsFor(tid, 100),
      installations: store.data.installations.filter((r) => Number(r.user_id) === tid).slice(-50).reverse()
    };
  });

  route('GET', /^\/admin\/deposits$/, 'admin', async () => ({
    pending: Object.entries(store.data.pendingDeposits || {})
      .map(([ref, p]) => ({ ref, user_id: p.user_id, amount: p.amount, credit: p.credit, at: p.at, expired_at: p.expired_at }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at))),
    credited: Object.entries(store.data.deposits || {})
      .map(([ref, d]) => ({ ref, ...d }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 100)
  }));

  route('POST', /^\/admin\/deposits\/([\w-]+)\/check$/, 'admin', async (ctx) => {
    const p = store.getPendingDeposit(ctx.m[1]);
    if (!p) fail(404, 'Deposit tidak ada di daftar tunggu.');
    const r = await verifyAndCreditDeposit(bot, ctx.m[1]);
    audit(ctx, 'deposit_cek', `${ctx.m[1]} user ${p.user_id}: ${r.state}`);
    return r;
  });

  route('DELETE', /^\/admin\/deposits\/([\w-]+)$/, 'admin', async (ctx) => {
    const p = store.getPendingDeposit(ctx.m[1]);
    if (!p) fail(404, 'Deposit tidak ada di daftar tunggu.');
    store.removePendingDeposit(ctx.m[1]);
    audit(ctx, 'deposit_hapus', `${ctx.m[1]} user ${p.user_id} Rp ${Number(p.amount).toLocaleString('id-ID')}`);
    return { ok: true };
  });

  route('GET', /^\/admin\/jobs$/, 'admin', async () => {
    const byTid = new Map(Object.values(accounts()).map((a) => [Number(a.telegram_id), a.username]));
    return {
      jobs: [...jobs.values()].reverse().map((j) => ({
        ...publicJob(j), rootPassword: null, user_id: j.userId, username: byTid.get(j.userId) || null
      })),
      running: store.data.installations.filter((r) => r.status === 'running').slice(-50).reverse()
    };
  });

  route('POST', /^\/admin\/accounts\/(\w+)\/password$/, 'admin', async (ctx) => {
    const acc = accounts()[ctx.m[1]];
    if (!acc) fail(404, 'Akun tidak ditemukan.');
    const password = String(ctx.body.password || '');
    if (password.length < 8) fail(400, 'Password minimal 8 karakter.');
    acc.hash = await hashPassword(password);
    audit(ctx, 'akun_reset_password', acc.username);
    return { ok: true };
  });

  route('GET', /^\/admin\/log$/, 'admin', async ({ url }) => {
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    let log = (store.data.adminLog || []).slice().reverse();
    if (q) log = log.filter((e) => `${e.admin} ${e.action} ${e.detail} ${e.ip}`.toLowerCase().includes(q));
    return { log: log.slice(0, 500) };
  });

  /*
   * Unduh backup: wajib kode OTP baru ke Telegram admin, dicatat di log, dan
   * admin diberi tahu. Isinya TANPA hash password (cadangan otomatis ke
   * Telegram tetap berisi data lengkap untuk pemulihan).
   */
  route('POST', /^\/admin\/export\/otp$/, 'admin', async (ctx) => {
    limit(`exportotp:${ctx.uid}`, 3, 10 * 60 * 1000);
    await sendCode(ctx.uid, `export:${ctx.uid}`, `📦 Permintaan UNDUH BACKUP data website\n👤 ${ctx.acc.username}\n🌐 IP ${ctx.ip}\n🕒 ${fmtWaktu()}`);
    return { ok: true };
  });

  route('GET', /^\/admin\/export$/, 'admin', async (ctx) => {
    useOtp(`export:${ctx.uid}`, ctx.url.searchParams.get('code'));
    audit(ctx, 'backup_unduh', userAgent(ctx.req));
    notify(ctx.uid, `📦 Backup data diunduh oleh ${ctx.acc.username} dari IP ${ctx.ip} (${fmtWaktu()}).`);
    const data = store.exportAll();
    data.webAccounts = Object.fromEntries(Object.entries(data.webAccounts || {})
      .map(([k, { hash, ...a }]) => [k, a]));
    return { _download: `backup-saldo-${new Date().toISOString().slice(0, 10)}.json`, ...data };
  });

  /* ---------- Saat start: kembalikan tahanan yang tertinggal ---------- */
  // Bot restart di tengah instalasi web = hasilnya tidak bisa dipantau lagi.
  // Sisa saldo yang masih ditahan dikembalikan, supaya user tidak pernah rugi.
  dataSiap.then(() => {
    const sisa = Object.entries(holds());
    if (!sisa.length) return;
    for (const [id, h] of sisa) {
      delete holds()[id];
      if (h.amount > 0) {
        store.credit(h.user_id, h.amount, 'refund_install_failed');
        notify(h.user_id,
          `💰 Rp ${Number(h.amount).toLocaleString('id-ID')} dikembalikan ke saldo: instalasi via website terhenti karena server restart.`);
      }
    }
    store.saveNow();
    console.log(`[WEB] ${sisa.length} tahanan saldo instalasi dikembalikan setelah restart.`);
  }).catch(() => {});

  /* ---------- Dispatcher ---------- */

  const handle = async function handle(req, res) {
    if (!process.env.WEB_SECRET) return send(res, 503, { error: 'WEB_SECRET belum diatur di server bot.' });
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/^\/api/, '');
    let m = null;
    const r = routes.find((x) => x.method === req.method && (m = path.match(x.pattern)));
    if (!r) return send(res, 404, { error: 'Tidak ditemukan' });

    try {
      await dataSiap;
      const ctx = { req, url, m, ip: clientIp(req), body: {} };
      if (req.method !== 'GET') ctx.body = await readJson(req);

      if (r.auth) {
        const sid = (String(req.headers.cookie || '').match(/(?:^|;\s*)sid=([^;]+)/) || [])[1];
        const p = readToken(sid);
        const acc = p && accounts()[p.u];
        if (!acc || acc.hash.slice(0, 8) !== p.pv) fail(401, 'Silakan login dulu.');
        ctx.acc = acc;
        ctx.uid = Number(acc.telegram_id);
        // Admin = ID ada di ADMIN_ID DAN sesi ini sudah lolos OTP Telegram.
        ctx.admin = isAdmin(ctx.uid) && p.a === 1;
        if (r.auth === 'admin' && !ctx.admin) {
          fail(403, isAdmin(ctx.uid) ? 'Akses admin butuh verifikasi OTP. Keluar lalu login lagi.' : 'Khusus admin.');
        }
      }

      const data = await r.fn(ctx);
      const headers = {};
      if (data && data._download) {
        headers['Content-Disposition'] = `attachment; filename="${data._download}"`;
        delete data._download;
      }
      if (data && '_cookie' in data) {
        headers['Set-Cookie'] = sessionCookie(data._cookie, data._cookie ? SESSION_MS / 1000 : 0);
        delete data._cookie;
      }
      send(res, 200, data, headers);
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      console.error(`[WEB API] ${req.method} ${path}:`, error);
      send(res, 500, { error: 'Terjadi kesalahan di server.' });
    }
  };
  handle.upgrade = createSshGateway({ takeTicket });
  return handle;
}

module.exports = { createWebApi };
