// AutoGoPay (autogopay.site) — QRIS dinamis merchant GoPay. Docs: https://autogopay.site/docs
// TIDAK ada retry otomatis: generate QRIS berulang dianggap spam dan bisa memblokir akun merchant.
const axios = require("axios");

const base = () => (process.env.AUTOGOPAY_BASE || "https://v1-gateway.autogopay.site").replace(/\/$/, "");

async function call(path, body) {
  const key = process.env.AUTOGOPAY_API_KEY;
  if (!key) throw new Error("AUTOGOPAY_API_KEY belum di-set");
  const res = await axios.post(`${base()}${path}`, body, {
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    timeout: 15000,
    validateStatus: () => true,
  });
  return { http: res.status, data: res.data || {} };
}

// "2026-03-27 20:49:00" -> ISO (zona: lihat di bawah)
function wibToIso(s) {
  if (!s) return null;
  const str = String(s).trim();
  // Dokumentasi menyebut WIB, tetapi API /qris/* nyatanya memakai UTC+8 (transaksi yang sama:
  // 16:01:37 di /transactions = WIB, 17:01:37 di /qris/status). Waktu tanpa zona dicoba sebagai
  // +08:00 lalu +07:00; yang masuk akal (QRIS berlaku ±15 menit, maks 20 menit ke depan) dipakai.
  // Tidak ada yang cocok -> null, dan pemanggil memakai 15 menit dari sekarang.
  const zoned = /[zZ]|[+-]\d\d:?\d\d$/.test(str);
  const now = Date.now();
  for (const c of zoned ? [str] : ["+08:00", "+07:00"].map((z) => str.replace(" ", "T") + z)) {
    const d = new Date(c);
    if (!Number.isNaN(d.getTime()) && d.getTime() > now && d.getTime() <= now + 20 * 60 * 1000) return d.toISOString();
  }
  return null;
}

async function generateQris(amount) {
  const { http, data } = await call("/qris/generate", { amount });
  const d = data.data;
  if (http !== 200 || !data.success || !d || !d.transaction_id || !d.qr_string) {
    throw new Error(`AutoGoPay generate gagal (${http}): ${data.message || "-"}`);
  }
  return {
    transaction_id: String(d.transaction_id),
    qr_string: d.qr_string,
    checkout_url: d.checkout_url || null,
    expires_at: wibToIso(d.expiry_time) || new Date(Date.now() + 15 * 60000).toISOString(),
  };
}

const STATUS_MAP = {
  settlement: "completed", capture: "completed", paid: "completed", success: "completed",
  pending: "pending", expire: "expired", expired: "expired", cancel: "canceled", deny: "canceled",
};

// Melempar error kalau API tidak terjangkau (JANGAN dianggap gagal bayar).
async function qrisStatus(transactionId) {
  const { http, data } = await call("/qris/status", { transaction_id: transactionId });
  if (http >= 500) throw new Error(`AutoGoPay status ${http}`);
  const d = data.data || {};
  const raw = String(d.transaction_status || d.status || "").toLowerCase();
  const amt = d.gross_amount != null ? d.gross_amount : d.amount;
  return { status: STATUS_MAP[raw] || "unknown", amount: amt == null ? null : Number(amt) };
}

async function cancelQris(transactionId) {
  const { data } = await call("/qris/cancel", { transaction_id: transactionId });
  return !!data.success;
}

module.exports = { generateQris, qrisStatus, cancelQris, wibToIso };
