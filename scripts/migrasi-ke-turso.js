#!/usr/bin/env node
/**
 * Pindahkan data dari rdp.db lokal ke Turso.
 *
 * Jalankan:  node scripts/migrasi-ke-turso.js
 *            node scripts/migrasi-ke-turso.js --dry-run    (lihat saja, tidak menulis)
 *
 * Aman diulang: memakai INSERT OR IGNORE untuk user, dan melewati transaksi
 * yang sudah ada. Menjalankannya dua kali tidak menggandakan saldo.
 *
 * Data lama TIDAK dihapus — rdp.db tetap utuh sebagai cadangan.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

const DRY = process.argv.includes('--dry-run');

/**
 * Jalankan pernyataan DDL satu per satu.
 *
 * Tidak memakai executeMultiple(): server Turso membalas permintaan
 * "sequence" dengan HTTP 400, sehingga pembuatan tabel gagal padahal
 * koneksinya sehat. execute() didukung di semua mode.
 */
async function jalankanDDL(client, sql) {
  const pernyataan = String(sql)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const p of pernyataan) {
    await client.execute(p);
  }
}


const localPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '../src/rdp.db');

const url = (process.env.TURSO_DATABASE_URL || '').trim();
const token = (process.env.TURSO_AUTH_TOKEN || '').trim();

(async () => {
  console.log('=== Migrasi rdp.db -> Turso ===\n');
  if (DRY) console.log('MODE UJI COBA — tidak ada yang ditulis ke Turso\n');

  if (!fs.existsSync(localPath)) {
    console.error(`❌ File database lokal tidak ditemukan: ${localPath}`);
    console.error('   Kalau memang belum punya data lama, lewati saja langkah ini.');
    process.exit(1);
  }
  if (!url || !token) {
    console.error('❌ TURSO_DATABASE_URL / TURSO_AUTH_TOKEN belum diisi di .env');
    process.exit(1);
  }

  const lokal = createClient({ url: `file:${localPath}` });
  const turso = createClient({ url, authToken: token });

  const ambil = async (tabel) => {
    try {
      const r = await lokal.execute(`SELECT * FROM ${tabel}`);
      return r.rows;
    } catch (_) {
      return [];
    }
  };

  const users = await ambil('users');
  const transactions = await ambil('transactions');
  const installations = await ambil('installations');

  const totalSaldo = users.reduce((s, u) => s + Number(u.balance || 0), 0);
  console.log('Ditemukan di database lokal:');
  console.log(`  User        : ${users.length}`);
  console.log(`  Total saldo : Rp ${totalSaldo.toLocaleString('id-ID')}`);
  console.log(`  Transaksi   : ${transactions.length}`);
  console.log(`  Instalasi   : ${installations.length}\n`);

  if (users.length === 0 && transactions.length === 0) {
    console.log('Tidak ada yang perlu dipindahkan.');
    process.exit(0);
  }

  if (DRY) {
    console.log('Uji coba selesai. Jalankan tanpa --dry-run untuk benar-benar memindahkan.');
    process.exit(0);
  }

  // Pastikan tabel ada di sisi Turso
  await jalankanDDL(turso, `
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
      ip TEXT, ssh_port INTEGER, windows_id INTEGER, windows_name TEXT,
      cost REAL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, finished_at TIMESTAMP
    );
  `);

  let userBaru = 0;
  let userDilewati = 0;
  for (const u of users) {
    const r = await turso.execute({
      sql: 'INSERT OR IGNORE INTO users (telegram_id, balance, created_at) VALUES (?, ?, ?)',
      args: [u.telegram_id, u.balance ?? 0, u.created_at ?? new Date().toISOString()]
    });
    if (Number(r.rowsAffected) > 0) userBaru++;
    else userDilewati++;
  }

  // Transaksi dipindahkan dengan id aslinya supaya tidak dobel saat diulang.
  let trxBaru = 0;
  for (const t of transactions) {
    const r = await turso.execute({
      sql: 'INSERT OR IGNORE INTO transactions (id, user_id, amount, type, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [t.id, t.user_id, t.amount, t.type, t.created_at ?? new Date().toISOString()]
    });
    if (Number(r.rowsAffected) > 0) trxBaru++;
  }

  let instBaru = 0;
  for (const i of installations) {
    const r = await turso.execute({
      sql: `INSERT OR IGNORE INTO installations
            (id, user_id, ip, ssh_port, windows_id, windows_name, cost, status, note, created_at, finished_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [i.id, i.user_id, i.ip ?? null, i.ssh_port ?? null, i.windows_id ?? null,
             i.windows_name ?? null, i.cost ?? 0, i.status ?? 'unknown', i.note ?? null,
             i.created_at ?? new Date().toISOString(), i.finished_at ?? null]
    });
    if (Number(r.rowsAffected) > 0) instBaru++;
  }

  // Verifikasi: saldo di Turso harus sama persis dengan sumbernya
  const cek = await turso.execute('SELECT COUNT(*) AS n, COALESCE(SUM(balance),0) AS total FROM users');
  const saldoTurso = Number(cek.rows[0].total);

  console.log('Hasil migrasi:');
  console.log(`  User dipindahkan : ${userBaru} (dilewati karena sudah ada: ${userDilewati})`);
  console.log(`  Transaksi        : ${trxBaru}`);
  console.log(`  Instalasi        : ${instBaru}`);
  console.log(`\nVerifikasi saldo:`);
  console.log(`  Lokal : Rp ${totalSaldo.toLocaleString('id-ID')}`);
  console.log(`  Turso : Rp ${saldoTurso.toLocaleString('id-ID')}`);

  if (Math.abs(saldoTurso - totalSaldo) < 0.01) {
    console.log('\n🎉 Cocok. Migrasi berhasil.');
    console.log('   rdp.db lokal tidak dihapus — simpan sebagai cadangan.');
  } else {
    console.log('\n⚠️  Total saldo BERBEDA.');
    console.log('   Ini normal kalau Turso sudah berisi data dari migrasi/penggunaan sebelumnya.');
    console.log('   Periksa manual sebelum menjalankan bot.');
  }

  lokal.close();
  turso.close();
})().catch((e) => {
  console.error('\n❌ Migrasi gagal:', e.message);
  process.exit(1);
});
