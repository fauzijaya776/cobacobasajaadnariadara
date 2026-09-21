// src/utils/pakasir.js
// Integrasi Payment Gateway Pakasir — API v2 (metode QRIS).
//
// API v1 (transactioncreate / transactiondetail) DIHENTIKAN Pakasir pada
// 20 Oktober 2026. File ini memakai v2:
//   Buat transaksi : POST {base}/api/v2/create-transaction/{slug}/{order_id}
//                    header  X-Api-Key
//                    body    { method: "qris", amount }
//   Cek status     : GET  {base}/api/v2/transaction-status/{slug}/{txn_id}
//                    header  X-Api-Key
//   Hitung biaya   : GET  {base}/api/v2/payment-fee/{amount}   (publik, tanpa key)
//
// PERBEDAAN PENTING DARI v1:
//   • Cek status memakai txn_id (dari respons create), BUKAN order_id + amount.
//     Karena itu txn_id WAJIB disimpan bersama deposit yang menunggu.
//   • Status v2: pending | completed | canceled. Tidak ada endpoint pembatalan;
//     QR yang tidak dibayar gugur sendiri (maks. 24 jam).
//
// SIAPA MENANGGUNG BIAYA (PAKASIR_FEE_BY):
//   Pakasir SELALU menambahkan biaya di ATAS amount (total_payment = amount+fee).
//   • merchant (default) → biaya ditanggung PENJUAL. Bot mengecilkan amount yang
//     dikirim ke Pakasir supaya buyer membayar PERSIS nominal deposit; saldo yang
//     masuk = yang benar-benar dibayar. Penjual menerima nominal dikurangi biaya.
//   • customer            → biaya ditambahkan ke tagihan buyer (buyer bayar lebih).
//
// Kredensial di .env:
//   PAKASIR_PROJECT (atau PAKASIR_SLUG) = slug project di dashboard Pakasir
//   PAKASIR_API_KEY                     = API key dari halaman detail project
//   PAKASIR_FEE_BY                      = merchant (default) | customer
//   PAKASIR_BASE_URL                    = opsional, default https://app.pakasir.com
//
// Dokumentasi: https://pakasir.com/p/docs
const axios = require('axios');

const BASE = (process.env.PAKASIR_BASE_URL || 'https://app.pakasir.com').replace(/\/+$/, '');
const QRIS_MIN = 500;         // batas nominal QRIS dari dokumentasi v2
const QRIS_MAX = 10000000;
const STATUS_GAP_MS = 4000;   // batas Pakasir: 1 cek status / 4 detik / transaksi

function getConfig() {
  const slug = (process.env.PAKASIR_PROJECT || process.env.PAKASIR_SLUG || '').trim();
  const apiKey = (process.env.PAKASIR_API_KEY || '').trim();
  if (!slug) throw new Error('PAKASIR_PROJECT belum diatur di .env');
  if (!apiKey) throw new Error('PAKASIR_API_KEY belum diatur di .env');
  return { slug, apiKey };
}

/** Apakah kredensial Pakasir sudah lengkap? (dipakai health check). */
function isConfigured() {
  try { getConfig(); return true; } catch (_) { return false; }
}

/** 'merchant' (default) atau 'customer'. */
function feePayer() {
  return String(process.env.PAKASIR_FEE_BY || 'merchant').trim().toLowerCase() === 'customer'
    ? 'customer' : 'merchant';
}

/* ============ util ============ */
const enc = encodeURIComponent;
function normStatus(s) {
  const v = String(s || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'completed' || v === 'success' || v === 'paid') return 'completed';
  if (v === 'canceled' || v === 'cancelled' || v === 'expired' || v === 'failed') return 'canceled';
  return 'pending';
}
/** True bila status transaksi menandakan sudah LUNAS. */
function isCompletedStatus(status) {
  return normStatus(status) === 'completed';
}
function describeAxiosError(prefix, error) {
  if (error.response) {
    const st = error.response.status;
    const raw = typeof error.response.data === 'object'
      ? JSON.stringify(error.response.data) : String(error.response.data);
    if (st === 401 || st === 403) return new Error('PAKASIR_AUTH: Slug atau API key Pakasir salah.');
    if (st === 404) return new Error('PAKASIR_NOTFOUND: Transaksi/proyek tidak ditemukan di Pakasir.');
    if (st === 429) return new Error('PAKASIR_RATELIMIT: Terlalu sering memanggil Pakasir, tunggu sebentar.');
    console.error(prefix, st, raw);
    return new Error(`Pakasir API Error (HTTP ${st}): ${raw}`);
  }
  console.error(prefix, error.message);
  return error;
}

/* ============ biaya QRIS ============ */
/**
 * Biaya QRIS Pakasir (cocok dengan /api/v2/payment-fee):
 *   amount <= 105.000 : 0,7% + Rp 310, dibulatkan ke atas
 *   amount  > 105.000 : 1%,           dibulatkan ke atas
 * Terverifikasi: 99.000→1.003, 12.000→394, 24.321→481, 105.001→1.051.
 */
function qrisFee(amount) {
  const a = Math.max(0, Math.floor(Number(amount) || 0));
  if (a <= 105000) return Math.floor((a * 7 + 999) / 1000) + 310;
  return Math.floor((a + 99) / 100);
}

/** Biaya QRIS menurut API publik Pakasir. null bila tidak bisa dihubungi. */
async function feeFromApi(amount) {
  try {
    const r = await axios.get(`${BASE}/api/v2/payment-fee/${enc(Math.floor(amount))}`, { timeout: 8000 });
    const f = r.data && Number(r.data.qris);
    return Number.isFinite(f) && f >= 0 ? f : null;
  } catch (_) { return null; }
}

/** Nominal terbesar `a` dengan a + qrisFee(a) <= target (rumus lokal). */
function largestUnder(target) {
  const guesses = [Math.floor((target - 310) / 1.007), Math.floor(target / 1.01)];
  let best = null;
  for (const g of guesses) {
    for (let a = g - 4; a <= g + 4; a++) {
      if (a < 1) continue;
      const f = qrisFee(a);
      if (a + f <= target && (!best || a > best.amount)) best = { amount: a, fee: f };
    }
  }
  return best;
}

/**
 * Rencana tagihan untuk nominal deposit pilihan buyer.
 * @returns {{feePayer, gatewayAmount, estFee, estTotal}}
 *   gatewayAmount = "amount" yang dikirim ke Pakasir
 *   estTotal      = yang dibayar buyer (untuk merchant ≈ nominal)
 */
async function quote(nominal) {
  const n = Math.floor(Number(nominal) || 0);
  const payer = feePayer();
  const rp = (v) => 'Rp ' + v.toLocaleString('id-ID');

  if (payer === 'customer') {
    if (n < QRIS_MIN || n > QRIS_MAX) throw new Error(`Nominal QRIS harus ${rp(QRIS_MIN)} – ${rp(QRIS_MAX)}.`);
    const f = qrisFee(n);
    return { feePayer: payer, gatewayAmount: n, estFee: f, estTotal: n + f };
  }

  let best = largestUnder(n);
  if (!best || best.amount < QRIS_MIN) {
    throw new Error(`Nominal terlalu kecil untuk QRIS (minimal ${rp(QRIS_MIN + qrisFee(QRIS_MIN))}).`);
  }

  // Verifikasi rumus lokal ke tarif Pakasir saat ini; koreksi bila berbeda.
  const apiFee = await feeFromApi(best.amount);
  if (apiFee != null && apiFee !== best.fee) {
    const over = (best.amount + apiFee) - n;
    const cand = best.amount - over;
    const candFee = cand >= QRIS_MIN ? await feeFromApi(cand) : null;
    if (candFee != null && cand + candFee <= n) best = { amount: cand, fee: candFee };
    else if (over > 0) best = { amount: best.amount - over, fee: apiFee };
    else best = { amount: best.amount, fee: apiFee };
  }

  if (best.amount < QRIS_MIN) throw new Error(`Nominal terlalu kecil untuk QRIS (minimal ${rp(QRIS_MIN + qrisFee(QRIS_MIN))}).`);
  if (best.amount > QRIS_MAX) throw new Error(`Nominal QRIS maksimal ${rp(QRIS_MAX)}.`);
  return { feePayer: payer, gatewayAmount: best.amount, estFee: best.fee, estTotal: best.amount + best.fee };
}

/* ============ transaksi ============ */
/**
 * Membuat transaksi QRIS baru (v2). "find or create": order_id yang sama
 * mengembalikan transaksi yang sama.
 * @param {string} reference  order_id unik.
 * @param {number} amount     Nominal deposit yang diminta buyer.
 * @returns {object} {
 *   id, reference, txnId, amount, gatewayAmount, totalBayar, fee,
 *   feePayer, qr_string, status, expired_at, isSandbox
 * }
 *   amount = saldo yang akan dikreditkan (= yang dibayar buyer).
 */
async function createPayment(reference, amount) {
  const { slug, apiKey } = getConfig();
  const nominal = Number(amount);
  if (!Number.isFinite(nominal) || nominal < 1000) throw new Error('Nominal QRIS minimal Rp 1.000');

  const plan = await quote(nominal);

  let data;
  try {
    const res = await axios.post(
      `${BASE}/api/v2/create-transaction/${enc(slug)}/${enc(String(reference))}`,
      { method: 'qris', amount: plan.gatewayAmount },
      { headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey }, timeout: 30000 }
    );
    data = res.data;
  } catch (error) {
    throw describeAxiosError('[PAKASIR CREATE ERROR]', error);
  }

  const p = (data && (data.transaction || data.payment || data)) || {};
  if (!p.txn_id) throw new Error('Pakasir tidak mengembalikan txn_id.');
  if (!p.qr_string) throw new Error('Pakasir tidak mengembalikan kode QRIS.');

  const gAmount = p.amount != null ? Number(p.amount) : plan.gatewayAmount;
  const fee = p.fee != null ? Number(p.fee) : plan.estFee;
  const totalPayment = p.total_payment != null ? Number(p.total_payment) : gAmount + fee;
  // Saldo yang dikreditkan = yang benar-benar dibayar buyer.
  const credit = plan.feePayer === 'merchant' ? totalPayment : gAmount;

  return {
    id: String(p.order_id || reference),
    reference: String(reference),
    txnId: String(p.txn_id),
    amount: credit,
    gatewayAmount: gAmount,
    totalBayar: totalPayment,
    fee,
    feePayer: plan.feePayer,
    qr_string: p.qr_string,
    status: normStatus(p.status) || 'pending',
    expired_at: p.expired_at || null,
    isSandbox: p.is_sandbox === true
  };
}

/**
 * Cek status transaksi ke Pakasir v2 (sumber kebenaran), memakai txn_id.
 * @returns {object|null} { status, amount, order_id, txn_id, completed_at, is_sandbox } | null
 */
async function checkStatusByTxn(txnId) {
  const { slug, apiKey } = getConfig();
  if (!txnId) return null;
  try {
    const res = await axios.get(
      `${BASE}/api/v2/transaction-status/${enc(slug)}/${enc(String(txnId))}`,
      { headers: { 'X-Api-Key': apiKey }, timeout: 30000 }
    );
    const t = (res.data && (res.data.transaction || res.data)) || null;
    if (!t) return null;
    return {
      status: normStatus(t.status),
      amount: t.amount != null ? Number(t.amount) : null,
      order_id: t.order_id || null,
      txn_id: t.txn_id || txnId,
      completed_at: t.completed_at || null,
      is_sandbox: t.is_sandbox === true
    };
  } catch (error) {
    throw describeAxiosError('[PAKASIR STATUS ERROR]', error);
  }
}

/**
 * v1 — HANYA untuk deposit lama (dibuat sebelum migrasi, tanpa txn_id).
 * Endpoint ini mati 20 Oktober 2026.
 */
async function checkStatusLegacy(reference, amount) {
  const { slug, apiKey } = getConfig();
  try {
    const res = await axios.get(`${BASE}/api/transactiondetail`, {
      params: { project: slug, amount: Number(amount), order_id: String(reference), api_key: apiKey },
      timeout: 30000
    });
    const t = (res.data && res.data.transaction) || null;
    if (!t) return null;
    return {
      status: normStatus(t.status),
      amount: t.amount != null ? Number(t.amount) : null,
      order_id: t.order_id || reference,
      txn_id: null,
      completed_at: t.completed_at || null,
      is_sandbox: false
    };
  } catch (error) {
    throw describeAxiosError('[PAKASIR STATUS ERROR]', error);
  }
}

module.exports = {
  BASE, QRIS_MIN, QRIS_MAX, STATUS_GAP_MS,
  isConfigured, feePayer, qrisFee, feeFromApi, quote,
  createPayment, checkStatusByTxn, checkStatusLegacy,
  isCompletedStatus, normStatus,
  _internal: { largestUnder }
};
