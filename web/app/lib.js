'use client';
import { createContext, useContext, useEffect, useRef } from 'react';

export const MeContext = createContext(null);
/** { me, reload } — data user yang sedang login. */
export const useMe = () => useContext(MeContext);

/** Panggil API bot (diteruskan lewat rewrite di next.config.mjs). */
export async function api(path, { method = 'GET', body, headers } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (_) {
    throw new Error('Tidak bisa terhubung ke server. Periksa koneksi internet Anda.');
  }
  // Balasan bukan JSON = server bot belum punya API website (kode lama) atau
  // BOT_API_URL salah. Jangan diteruskan sebagai data kosong — halaman bisa crash.
  if (!String(res.headers.get('content-type') || '').includes('application/json')) {
    const e = new Error(res.status >= 500 || res.status === 404
      ? `Server bot tidak merespons (${res.status}). Mungkin sedang bangun, coba lagi sebentar.`
      : 'Server bot belum mendukung website. Pastikan kode bot terbaru sudah ter-deploy dan BOT_API_URL benar.');
    e.status = res.status === 200 ? 502 : res.status;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `Server sedang sibuk atau baru bangun (${res.status}). Coba lagi sebentar.`);
    e.status = res.status;
    throw e;
  }
  return data;
}

/** ID user untuk ditampilkan: akun website saja memakai ID negatif. */
export const userLabel = (id) => (Number(id) < 0 ? `Web #${-Number(id)}` : String(id));

export const rp = (n) => 'Rp ' + Math.round(Number(n || 0)).toLocaleString('id-ID');
export const tgl = (s) => (s ? new Date(s).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '-');

/** Label & warna tipe transaksi — sama dengan yang dipakai bot Telegram. */
export const TRX = {
  deposit: ['Deposit', 'ok'],
  install: ['Install RDP', 'info'],
  deduct: ['Pemakaian', 'info'],
  admin: ['Tambah admin', 'ok'],
  admin_deduct: ['Dikurangi admin', 'bad'],
  refund: ['Refund', 'ok'],
  refund_install_failed: ['Refund install gagal', 'ok'],
  refund_cancelled: ['Refund dibatalkan', 'ok']
};
export const trxLabel = (t) => (TRX[t] || [t])[0];
export const trxTone = (t) => (TRX[t] || [null, ''])[1];

/** Status riwayat instalasi (tersimpan di bot). */
export const INSTALL_STATUS = {
  running: ['Berjalan', 'warn'],
  pending: ['Menunggu', 'warn'],
  success: ['Berhasil', 'ok'],
  success_uncharged: ['Berhasil', 'ok'],
  failed: ['Gagal', 'bad'],
  cancelled: ['Dibatalkan', '']
};

/** Status per VPS dalam satu proses web. */
export const JOB_STATUS = {
  queued: ['Antre', ''],
  checking: ['Cek VPS', 'info'],
  installing: ['Menginstal', 'warn'],
  success: ['Berhasil', 'ok'],
  failed: ['Gagal', 'bad'],
  skipped: ['Dilewati', 'bad']
};

/** Jalankan fn tiap `ms` selama `active`. */
export function usePoll(fn, ms, active = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    ref.current();
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms, active]);
}
