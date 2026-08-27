#!/usr/bin/env node
/**
 * Cek koneksi Turso.
 *
 * Jalankan:  node scripts/cek-turso.js
 *
 * Skrip ini hanya MEMBACA dan membuat tabel kalau belum ada. Tidak ada data
 * yang dihapus. Jalankan ini dulu sebelum menyalakan bot, supaya kalau ada
 * yang salah ketahuan di sini — bukan saat buyer sedang transaksi.
 */
require('dotenv').config();
const { createClient } = require('@libsql/client');

const url = (process.env.TURSO_DATABASE_URL || '').trim();
const token = (process.env.TURSO_AUTH_TOKEN || '').trim();

function gagal(pesan, saran) {
  console.error(`\n❌ ${pesan}`);
  if (saran) console.error(`   ${saran}`);
  process.exit(1);
}

(async () => {
  console.log('=== Cek koneksi Turso ===\n');

  if (!url) {
    gagal('TURSO_DATABASE_URL kosong di .env',
      'Isi dengan URL dari dashboard Turso, contoh: libsql://namadb-user.turso.io');
  }
  if (!token) {
    gagal('TURSO_AUTH_TOKEN kosong di .env',
      'Klik "Create Token" di dashboard Turso, lalu tempel hasilnya di .env');
  }
  if (!url.startsWith('libsql://') && !url.startsWith('https://')) {
    gagal(`URL tidak dikenali: ${url}`, 'URL harus diawali libsql:// atau https://');
  }

  console.log('URL   :', url);
  console.log('Token : ada (' + token.length + ' karakter)\n');

  let client;
  try {
    client = createClient({ url, authToken: token });
  } catch (error) {
    gagal(`Gagal membuat koneksi: ${error.message}`);
  }

  // 1. Koneksi dasar
  try {
    const r = await client.execute('SELECT 1 AS ok');
    if (r.rows[0].ok !== 1) throw new Error('balasan tidak terduga');
    console.log('✅ Koneksi berhasil');
  } catch (error) {
    const m = String(error.message || '');
    if (/401|unauthor|token/i.test(m)) {
      gagal('Token ditolak Turso.',
        'Token mungkin salah tempel, sudah kedaluwarsa, atau sudah di-revoke. Buat token baru.');
    }
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) {
      gagal('Alamat database tidak ditemukan.', 'Cek kembali ejaan TURSO_DATABASE_URL.');
    }
    gagal(`Koneksi gagal: ${m}`);
  }

  // 2. Tabel
  try {
    await client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        balance REAL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        type TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS installations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        ip TEXT,
        ssh_port INTEGER,
        windows_id INTEGER,
        windows_name TEXT,
        cost REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        finished_at TIMESTAMP
      );
    `);
    console.log('✅ Tabel siap (users, transactions, installations)');
  } catch (error) {
    gagal(`Gagal menyiapkan tabel: ${error.message}`,
      'Pastikan token punya izin Read & Write, bukan Read Only.');
  }

  // 3. Uji tulis-baca-hapus pakai ID yang tidak mungkin dipakai user asli
  const UJI_ID = -999999;
  try {
    await client.execute({ sql: 'DELETE FROM users WHERE telegram_id = ?', args: [UJI_ID] });
    await client.execute({
      sql: 'INSERT INTO users (telegram_id, balance) VALUES (?, ?)',
      args: [UJI_ID, 12345]
    });
    const cek = await client.execute({
      sql: 'SELECT balance FROM users WHERE telegram_id = ?',
      args: [UJI_ID]
    });
    if (Number(cek.rows[0].balance) !== 12345) throw new Error('nilai tidak cocok');
    await client.execute({ sql: 'DELETE FROM users WHERE telegram_id = ?', args: [UJI_ID] });
    console.log('✅ Tulis & baca berfungsi (izin Read/Write aktif)');
  } catch (error) {
    gagal(`Uji tulis gagal: ${error.message}`,
      'Kemungkinan token hanya punya izin Read Only. Buat ulang dengan Read & Write.');
  }

  // 4. Ringkasan isi
  try {
    const u = await client.execute('SELECT COUNT(*) AS n, COALESCE(SUM(balance),0) AS total FROM users');
    const t = await client.execute('SELECT COUNT(*) AS n FROM transactions');
    console.log('\n--- Isi database saat ini ---');
    console.log('User        :', Number(u.rows[0].n));
    console.log('Total saldo : Rp', Number(u.rows[0].total).toLocaleString('id-ID'));
    console.log('Transaksi   :', Number(t.rows[0].n));
  } catch (_) {}

  console.log('\n🎉 Semua siap. Bot boleh dijalankan: npm start\n');
  client.close();
})();
