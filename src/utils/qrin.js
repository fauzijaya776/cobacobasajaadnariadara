// src/utils/qrin.js
// Integrasi Payment Gateway QRIN (https://qrin.web.id) - metode QRIS.
//
// QRIN TIDAK punya endpoint cek status (polling). Konfirmasi pembayaran HANYA
// lewat CALLBACK/WEBHOOK: QRIN mengirim POST ke URL callback merchant setiap
// status berubah, dengan header X-Callback-Signature = HMAC-SHA256(raw body, token).
//
// Kredensial di .env:
//   QRIN_TOKEN = token_qrin dari Setting Merchant QRIN
const axios = require('axios');
const crypto = require('crypto');

const QRIN_BASE = 'https://qrin.web.id/api';

function getToken() {
  const token = process.env.QRIN_TOKEN;
  if (!token) throw new Error('QRIN_TOKEN belum diatur di .env');
  return token;
}

/**
 * Membuat transaksi QRIS baru di QRIN.
 * @param {string} reference  no_ref_merchant (kode unik deposit kita).
 * @param {number} amount     Nominal IDR (min 1.000).
 * @param {string} validityMinutes  Durasi kedaluwarsa (menit), default "15".
 * @returns {object} { id, reference, amount, totalBayar, fee, amountReceived, qr_string, status, expired_at }
 */
async function createPayment(reference, amount, validityMinutes = '15') {
  const token = getToken();

  const nominal = Number(amount);
  if (!Number.isFinite(nominal) || nominal < 1000) {
    throw new Error('Nominal QRIS minimal Rp 1.000');
  }

  const body = {
    token_qrin: token,
    payment_method: 'qris',
    request_payload: {
      no_ref_merchant: String(reference),
      amount_value: nominal,
      amount_currency: 'IDR',
      product_details: JSON.stringify([{ name: 'Deposit Saldo', price: nominal }]),
      validity: String(validityMinutes)
    }
  };

  try {
    const response = await axios.post(`${QRIN_BASE}/create-transaksi`, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
      maxBodyLength: Infinity
    });

    const d = response.data;
    if (!d || d.success !== true || !d.data) {
      throw new Error(`QRIN API Error: ${d && d.message ? d.message : 'respons tidak sukses'}`);
    }

    const data = d.data;
    const qrString = data.qris_data;
    if (!qrString) throw new Error('QRIN tidak mengembalikan qris_data (string QRIS).');

    return {
      id: String(data.no_ref_merchant || reference), // QRIN pakai no_ref_merchant sebagai referensi
      reference: String(reference),
      amount: data.amount_value != null ? Number(data.amount_value) : nominal,        // dibayar customer
      totalBayar: data.amount_value != null ? Number(data.amount_value) : nominal,    // customer_cost QRIS = 0
      fee: data.merchant_cost != null ? Number(data.merchant_cost) : 0,
      amountReceived: data.amount_received != null ? Number(data.amount_received) : nominal,
      qr_string: qrString,
      status: data.transaction_status || 'pending',
      expired_at: data.validity || null
    };
  } catch (error) {
    if (error.response) {
      const raw =
        typeof error.response.data === 'object'
          ? JSON.stringify(error.response.data)
          : String(error.response.data);
      console.error('[QRIN CREATE ERROR]', error.response.status, raw);
      throw new Error(`QRIN API Error (HTTP ${error.response.status}): ${raw}`);
    }
    console.error('[QRIN CREATE ERROR]', error.message);
    throw error;
  }
}

/**
 * Verifikasi tanda tangan callback QRIN.
 * X-Callback-Signature = HMAC-SHA256(raw body JSON, token_qrin).
 * @param {string|Buffer} rawBody
 * @param {string} signatureHeader
 * @returns {boolean}
 */
function verifyCallbackSignature(rawBody, signatureHeader) {
  const token = getToken();
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  const expected = crypto.createHmac('sha256', token).update(payload).digest('hex');
  const got = String(signatureHeader || '');
  try {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(got, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

module.exports = { createPayment, verifyCallbackSignature };
