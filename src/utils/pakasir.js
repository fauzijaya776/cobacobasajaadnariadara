// src/utils/pakasir.js
// Integrasi Payment Gateway Pakasir (https://pakasir.com) - metode QRIS.
//
// Berbeda dengan QRIN, Pakasir menyediakan DUA jalur konfirmasi pembayaran:
//   1. WEBHOOK/CALLBACK — Pakasir mengirim POST ke URL callback merchant saat
//      status berubah menjadi "completed".
//   2. STATUS API (transactiondetail) — bot bisa MENANYAKAN status transaksi
//      kapan saja. Ini yang membuat tombol "Cek Status" dan pemantau otomatis
//      bisa jalan tanpa harus menunggu webhook.
//
// PENTING soal keamanan: webhook Pakasir TIDAK bertanda tangan. Karena itu bot
// TIDAK pernah langsung percaya isi webhook — setiap kali menerima callback
// (atau saat user menekan "Cek Status"), bot memverifikasi ulang ke STATUS API
// Pakasir sebelum menambah saldo. Ini menutup celah orang mengirim callback
// palsu ke URL bot.
//
// Kredensial di .env:
//   PAKASIR_PROJECT   = slug/nama project di dashboard Pakasir (mis. "fzistore")
//   PAKASIR_API_KEY   = API key dari halaman detail project Pakasir
//
// Dokumentasi: https://pakasir.com/p/docs
const axios = require('axios');

const PAKASIR_BASE = 'https://app.pakasir.com/api';
const DEFAULT_METHOD = 'qris';

function getConfig() {
  const project = (process.env.PAKASIR_PROJECT || process.env.PAKASIR_SLUG || '').trim();
  const apiKey = (process.env.PAKASIR_API_KEY || '').trim();
  if (!project) throw new Error('PAKASIR_PROJECT belum diatur di .env');
  if (!apiKey) throw new Error('PAKASIR_API_KEY belum diatur di .env');
  return { project, apiKey };
}

/** Apakah kredensial Pakasir sudah lengkap? (dipakai health check). */
function isConfigured() {
  try {
    getConfig();
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Membuat transaksi pembayaran baru di Pakasir.
 * @param {string} reference  order_id (kode unik deposit kita).
 * @param {number} amount     Nominal IDR (min 1.000).
 * @param {string} method     Metode pembayaran ('qris' default).
 * @returns {object} { id, reference, amount, totalBayar, fee, qr_string, status, expired_at }
 */
async function createPayment(reference, amount, method = DEFAULT_METHOD) {
  const { project, apiKey } = getConfig();

  const nominal = Number(amount);
  if (!Number.isFinite(nominal) || nominal < 1000) {
    throw new Error('Nominal QRIS minimal Rp 1.000');
  }

  const body = {
    project,
    order_id: String(reference),
    amount: nominal,
    api_key: apiKey
  };

  try {
    const response = await axios.post(
      `${PAKASIR_BASE}/transactioncreate/${method}`,
      body,
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    const d = response.data;
    const p = d && d.payment;
    if (!p || !p.payment_number) {
      const pesan = (d && (d.message || d.error)) || 'respons tidak sukses';
      throw new Error(`Pakasir API Error: ${pesan}`);
    }

    return {
      id: String(p.order_id || reference),
      reference: String(reference),
      // Nominal yang DIBAYAR customer. Untuk QRIS = amount (biaya ditanggung merchant).
      amount: p.amount != null ? Number(p.amount) : nominal,
      // total_payment kadang termasuk fee bila fee dibebankan ke customer.
      totalBayar: p.total_payment != null ? Number(p.total_payment) : nominal,
      fee: p.fee != null ? Number(p.fee) : 0,
      // Untuk metode qris, payment_number = string QRIS yang di-encode jadi QR.
      qr_string: p.payment_number,
      status: 'pending',
      expired_at: p.expired_at || null
    };
  } catch (error) {
    if (error.response) {
      const raw =
        typeof error.response.data === 'object'
          ? JSON.stringify(error.response.data)
          : String(error.response.data);
      console.error('[PAKASIR CREATE ERROR]', error.response.status, raw);
      throw new Error(`Pakasir API Error (HTTP ${error.response.status}): ${raw}`);
    }
    console.error('[PAKASIR CREATE ERROR]', error.message);
    throw error;
  }
}

/**
 * Menanyakan status transaksi ke Pakasir (sumber kebenaran).
 * @param {string} reference  order_id.
 * @param {number} amount     Nominal transaksi (wajib — dipakai Pakasir sebagai kunci).
 * @returns {object|null} { amount, order_id, project, status, payment_method, completed_at } | null
 */
async function checkStatus(reference, amount) {
  const { project, apiKey } = getConfig();

  try {
    const response = await axios.get(`${PAKASIR_BASE}/transactiondetail`, {
      params: {
        project,
        amount: Number(amount),
        order_id: String(reference),
        api_key: apiKey
      },
      timeout: 30000
    });

    const t = response.data && response.data.transaction;
    return t || null;
  } catch (error) {
    if (error.response) {
      console.error('[PAKASIR STATUS ERROR]', error.response.status);
    } else {
      console.error('[PAKASIR STATUS ERROR]', error.message);
    }
    throw error;
  }
}

/** True bila status transaksi dari Pakasir menandakan sudah LUNAS. */
function isCompletedStatus(status) {
  return String(status || '').toLowerCase() === 'completed';
}

module.exports = {
  createPayment,
  checkStatus,
  isConfigured,
  isCompletedStatus
};
