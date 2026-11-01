// src/utils/agpConfig.js
// Pengaturan AutoGoPay yang bisa diubah admin TANPA akses Environment Render:
// lewat Telegram (/setagpkey) atau panel admin website. Lihat juga gateway.js.
//
// Urutan sumber:
//   API key : env AUTOGOPAY_API_KEY  ->  key yang disimpan admin
//   gateway : env PAYMENT_PROVIDER    ->  pilihan admin  ->  otomatis (autogopay kalau ada key)
//
// Key disimpan TERENKRIPSI (AES-256-GCM) di store.data.autogopay, jadi ikut file data
// dan cadangan Telegram tanpa pernah berupa teks biasa. Kunci enkripsinya diturunkan dari
// WEB_SECRET + BOT_TOKEN. WEB_SECRET wajib: BOT_TOKEN bot ini pernah ter-commit di repo
// publik, jadi BOT_TOKEN saja tidak boleh cukup untuk membuka key.
const crypto = require('crypto');
const store = require('./store');

function cfg() {
  if (!store.data.autogopay || typeof store.data.autogopay !== 'object') store.data.autogopay = {};
  return store.data.autogopay;
}

function cipherKey() {
  const web = process.env.WEB_SECRET;
  if (!web) throw new Error('WEB_SECRET belum diisi di Environment Render: key tidak bisa disimpan dengan aman.');
  return crypto.createHash('sha256').update(`rdp-agp|v1|${web}|${process.env.BOT_TOKEN || ''}`).digest();
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cipherKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decrypt(stored) {
  const [v, iv, tag, ct] = String(stored || '').split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('format key tersimpan tidak dikenal');
  const d = crypto.createDecipheriv('aes-256-gcm', cipherKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// Hasil dekripsi di-cache per (isi terenkripsi, rahasia env); dibuka ulang bila salah satunya berubah.
let cached = { id: null, plain: null, failed: false };
function storedKey() {
  const enc = cfg().keyEnc;
  if (!enc) return null;
  const id = `${enc}|${process.env.WEB_SECRET || ''}|${process.env.BOT_TOKEN || ''}`;
  if (cached.id !== id) {
    try { cached = { id, plain: decrypt(enc), failed: false }; } catch (_) { cached = { id, plain: null, failed: true }; }
  }
  return cached.plain;
}

const apiKey = () => process.env.AUTOGOPAY_API_KEY || storedKey() || null;
const keySource = () => (process.env.AUTOGOPAY_API_KEY ? 'env' : storedKey() ? 'admin' : null);

function envProvider() {
  const p = String(process.env.PAYMENT_PROVIDER || '').trim().toLowerCase();
  return p === 'autogopay' || p === 'pakasir' ? p : null;
}
/** Pilihan gateway eksplisit (env lalu admin), atau null = otomatis. */
const providerChoice = () => envProvider() || (['autogopay', 'pakasir'].includes(cfg().provider) ? cfg().provider : null);
const providerSource = () => (envProvider() ? 'env' : cfg().provider ? 'admin' : 'otomatis');

function saveKey(key, by) {
  const c = cfg();
  c.keyEnc = encrypt(key);
  c.keySetAt = new Date().toISOString();
  c.keySetBy = String(by || '-');
  return store.saveNow();
}
function clearKey() {
  const c = cfg();
  delete c.keyEnc; delete c.keySetAt; delete c.keySetBy;
  return store.saveNow();
}
function setProvider(p) {
  const c = cfg();
  if (p === 'auto') delete c.provider; else c.provider = p;
  return store.saveNow();
}

const mask = (k) => (k && k.length > 12 ? `${k.slice(0, 8)}…${k.slice(-4)}` : '****');
const looksLikeKey = (k) => /^agp_[A-Za-z0-9_-]{16,200}$/.test(String(k || ''));

function info() {
  const key = apiKey();
  storedKey();
  return {
    keySource: keySource(),
    keyMasked: key ? mask(key) : null,
    keySetAt: cfg().keySetAt || null,
    keySetBy: cfg().keySetBy || null,
    decryptFailed: !!(cfg().keyEnc && cached.failed),
    webSecretSet: !!process.env.WEB_SECRET,
    providerSource: providerSource(),
  };
}

module.exports = {
  apiKey, keySource, providerChoice, providerSource,
  saveKey, clearKey, setProvider, mask, looksLikeKey, info,
  _encrypt: encrypt, _decrypt: decrypt,
};
