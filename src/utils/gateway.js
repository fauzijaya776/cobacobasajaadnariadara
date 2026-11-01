// src/utils/gateway.js
// Pemilihan payment gateway + aturan anti-blokir QRIS.
//
// Gateway untuk deposit BARU: PAYMENT_PROVIDER=autogopay | pakasir
// (kosong -> autogopay kalau AUTOGOPAY_API_KEY ada, selain itu pakasir).
// Deposit yang sedang menunggu selalu dicek ke gateway yang membuatnya
// (pending.gateway; kosong = pakasir), jadi pindah gateway aman kapan saja.
//
// AutoGoPay: QRIS dinamis GoPay, tanpa biaya untuk pembeli, berlaku ±15 menit.
// TIDAK ada retry otomatis: generate QRIS berulang dianggap spam oleh provider
// dan yang diblokir adalah akun merchant kita.
const pakasir = require('./pakasir');
const agp = require('./autogopay');
const store = require('./store');
const agpConfig = require('./agpConfig');

// Gateway deposit baru: env PAYMENT_PROVIDER -> pilihan admin (/agpgateway, panel admin)
// -> otomatis (autogopay kalau ada API key dari env atau /setagpkey). Lihat agpConfig.js.
function activeGateway() {
  return agpConfig.providerChoice() || (agpConfig.apiKey() ? 'autogopay' : 'pakasir');
}

function isConfigured() {
  return activeGateway() === 'autogopay' ? Boolean(agpConfig.apiKey()) : pakasir.isConfigured();
}

/** Ringkasan untuk /agpkey, panel admin, dan /health. Key tidak pernah utuh. */
function describe() {
  return { gateway: activeGateway(), configured: isConfigured(), ...agpConfig.info() };
}

const gatewayOf = (pending) => (pending && pending.gateway) || 'pakasir';

/**
 * Buat QRIS di gateway aktif. Bentuk hasil sama dengan pakasir.createPayment
 * ditambah `gateway` dan `checkoutUrl`.
 */
async function createPayment(reference, amount) {
  if (activeGateway() !== 'autogopay') return { ...(await pakasir.createPayment(reference, amount)), gateway: 'pakasir' };
  const n = Math.floor(Number(amount));
  const q = await agp.generateQris(n);
  return {
    id: String(reference),
    reference: String(reference),
    txnId: q.transaction_id,
    amount: n,              // saldo yang dikredit = yang dibayar (tanpa biaya)
    gatewayAmount: n,
    totalBayar: n,
    fee: 0,
    feePayer: 'none',
    qr_string: q.qr_string,
    status: 'pending',
    expired_at: q.expires_at,
    isSandbox: false,
    checkoutUrl: q.checkout_url,
    gateway: 'autogopay',
  };
}

/** Status dengan bentuk yang sama dengan pakasir.checkStatusByTxn: { status: completed|canceled|pending, amount }. */
async function checkStatus(pending) {
  if (gatewayOf(pending) === 'autogopay') {
    const s = await agp.qrisStatus(pending.txn_id);
    const status = s.status === 'completed' ? 'completed'
      : (s.status === 'expired' || s.status === 'canceled') ? 'canceled' : 'pending';
    return { status, amount: s.amount, txn_id: pending.txn_id };
  }
  if (!pending.txn_id) return pakasir.checkStatusLegacy(pending.ref, pending.amount);
  return pakasir.checkStatusByTxn(pending.txn_id);
}

/** Batalkan QRIS di gateway. Pakasir v2 tidak punya endpoint batal → false. */
async function cancel(pending) {
  if (gatewayOf(pending) !== 'autogopay' || !pending.txn_id) return false;
  return agp.cancelQris(pending.txn_id).catch(() => false);
}

/* ================= aturan anti-blokir ================= */
const envInt = (k, d) => { const n = parseInt(process.env[k], 10); return Number.isFinite(n) && n >= 0 ? n : d; };
const LIMITS = {
  maxPerDay: envInt('QRIS_MAX_PER_DAY', 8),        // QRIS per user per 24 jam
  maxUnpaid: envInt('QRIS_MAX_UNPAID', 5),         // tak dibayar berturut-turut -> dikunci (maks 24 jam)
  cooldownMin: envInt('QRIS_COOLDOWN_MIN', 3),     // jeda setelah QRIS hangus / dibatalkan
  globalPerMin: envInt('QRIS_GLOBAL_PER_MIN', 30), // rem darurat seluruh bot + website
};
const depositEnabled = () => process.env.DEPOSIT_ENABLED !== '0';

// Riwayat pembuatan QRIS 24 jam terakhir (di memori; deposit yang masih
// menunggu tetap tersimpan permanen di store.pendingDeposits).
const log = []; // { user_id, ref, at, status: 'pending'|'paid'|'ended', endedAt }
function prune() {
  const since = Date.now() - 864e5;
  while (log.length && log[0].at < since) log.shift();
  if (log.length > 5000) log.splice(0, log.length - 5000);
}
function record(userId, ref) { prune(); log.push({ user_id: Number(userId), ref: String(ref), at: Date.now(), status: 'pending' }); }
function mark(ref, status) {
  const e = log.find((x) => x.ref === String(ref));
  if (e && e.status === 'pending') { e.status = status; e.endedAt = Date.now(); }
}

const isLive = (p) => p && p.qr_string && p.expired_at && new Date(p.expired_at).getTime() > Date.now();

/** QRIS milik user yang masih hidup (untuk ditampilkan ulang). */
function liveDepositOf(userId) {
  const all = (store.data && store.data.pendingDeposits) || {};
  let best = null;
  for (const [ref, p] of Object.entries(all)) {
    if (Number(p.user_id) !== Number(userId) || !isLive(p)) continue;
    if (!best || String(p.at) > String(best.p.at)) best = { ref, p };
  }
  return best;
}

/**
 * Boleh membuat QRIS baru?
 * @returns {{reuse:{ref,p}}|{error:string, status:number, brake?:boolean}|{}}
 */
function guardNewQris(userId) {
  if (!depositEnabled()) return { error: 'Deposit sedang ditutup sementara. Coba lagi nanti.', status: 503 };
  const live = liveDepositOf(userId);
  if (live) return { reuse: live };

  prune();
  const now = Date.now();
  const mine = log.filter((e) => e.user_id === Number(userId)).reverse(); // terbaru dulu
  let streak = 0;
  for (const e of mine) { if (e.status === 'paid') break; if (e.status === 'ended') streak++; }
  if (LIMITS.maxUnpaid && streak >= LIMITS.maxUnpaid) {
    return { error: 'Terlalu banyak QRIS yang tidak dibayar. Deposit dikunci sementara (maks. 24 jam).', status: 429 };
  }
  if (LIMITS.maxPerDay && mine.length >= LIMITS.maxPerDay) {
    return { error: `Batas ${LIMITS.maxPerDay} QRIS per hari tercapai. Coba lagi besok.`, status: 429 };
  }
  const last = mine[0];
  if (last && last.status === 'ended' && LIMITS.cooldownMin) {
    const wait = (last.endedAt || last.at) + LIMITS.cooldownMin * 60000 - now;
    if (wait > 0) return { error: `Tunggu ${Math.ceil(wait / 60000)} menit sebelum membuat QRIS baru.`, status: 429 };
  }
  if (LIMITS.globalPerMin && log.filter((e) => e.at > now - 60000).length >= LIMITS.globalPerMin) {
    console.error('[QRIS] rem darurat: pembuatan QRIS per menit melewati batas');
    return { error: 'Sistem pembayaran sedang ramai. Coba lagi 1 menit lagi.', status: 429, brake: true };
  }
  return {};
}

module.exports = {
  activeGateway, isConfigured, describe, gatewayOf, createPayment, checkStatus, cancel,
  guardNewQris, record, mark, LIMITS, _log: log,
};
