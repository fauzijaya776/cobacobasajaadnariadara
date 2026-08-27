#!/usr/bin/env node
/**
 * Pindahkan data lama ke penyimpanan JSON yang baru.
 *
 * Jalankan:
 *   node scripts/migrasi-ke-json.js                    (baca src/rdp.db)
 *   node scripts/migrasi-ke-json.js backup.json        (baca file backup JSON)
 *
 * Aman diulang: user yang sudah ada tidak ditimpa, jadi saldo tidak menggandakan.
 * File sumber TIDAK dihapus.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const store = require('../src/utils/store');

const sumber = process.argv[2] || path.join(__dirname, '../src/rdp.db');

/** Baca database SQLite lama memakai SQLite bawaan Node (Node 22+). */
function bacaSqlite(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_) {
    console.error('❌ Node versi ini belum punya SQLite bawaan (butuh Node 22+).');
    console.error('   Cek versi Anda: node -v');
    console.error('');
    console.error('   Alternatif tanpa upgrade Node: jalankan bot versi LAMA sekali,');
    console.error('   tekan menu Database -> "Backup Sekarang" untuk mendapat file JSON,');
    console.error('   lalu jalankan: node scripts/migrasi-ke-json.js file-backup.json');
    process.exit(1);
  }

  const db = new DatabaseSync(file);
  const ambil = (sql) => {
    try { return db.prepare(sql).all(); } catch (_) { return []; }
  };
  const hasil = {
    users: ambil('SELECT * FROM users'),
    transactions: ambil('SELECT * FROM transactions'),
    installations: ambil('SELECT * FROM installations')
  };
  db.close();
  return hasil;
}

/** Baca file backup JSON (hasil ekspor bot). */
function bacaJson(file) {
  const isi = JSON.parse(fs.readFileSync(file, 'utf8'));

  // Dukung dua bentuk: {tables:{users:[...]}} dari ekspor lama,
  // dan {users:{...}} dari format store yang baru.
  if (isi.tables) {
    return {
      users: isi.tables.users || [],
      transactions: isi.tables.transactions || [],
      installations: isi.tables.installations || []
    };
  }
  if (isi.users && !Array.isArray(isi.users)) {
    return {
      users: Object.values(isi.users),
      transactions: isi.transactions || [],
      installations: isi.installations || []
    };
  }
  return {
    users: isi.users || [],
    transactions: isi.transactions || [],
    installations: isi.installations || []
  };
}

(async () => {
  console.log('=== Migrasi data lama -> penyimpanan JSON ===\n');

  if (!fs.existsSync(sumber)) {
    console.error(`❌ File sumber tidak ditemukan: ${sumber}`);
    console.error('   Kalau memang belum punya data lama, lewati saja langkah ini —');
    console.error('   bot akan mulai dengan data kosong.');
    process.exit(1);
  }

  const lama = sumber.endsWith('.json') ? bacaJson(sumber) : bacaSqlite(sumber);

  const totalLama = lama.users.reduce((s, u) => s + (Number(u.balance) || 0), 0);
  console.log(`Sumber: ${sumber}`);
  console.log(`  User        : ${lama.users.length}`);
  console.log(`  Total saldo : Rp ${totalLama.toLocaleString('id-ID')}`);
  console.log(`  Transaksi   : ${lama.transactions.length}`);
  console.log(`  Instalasi   : ${lama.installations.length}\n`);

  if (lama.users.length === 0) {
    console.log('Tidak ada user untuk dipindahkan.');
    process.exit(0);
  }

  await store.init();

  let dipindah = 0;
  let dilewati = 0;
  for (const u of lama.users) {
    const id = Number(u.telegram_id);
    if (!Number.isFinite(id)) continue;

    const kunci = String(id);
    if (store.data.users[kunci]) {
      dilewati++;                        // sudah ada — jangan ditimpa
      continue;
    }
    store.data.users[kunci] = {
      telegram_id: id,
      balance: Number(u.balance) || 0,
      created_at: u.created_at || new Date().toISOString()
    };
    dipindah++;
  }

  // Riwayat ikut dipindahkan, tapi tidak memengaruhi saldo.
  const idTrxAda = new Set(store.data.transactions.map((t) => Number(t.id)));
  for (const t of lama.transactions) {
    if (idTrxAda.has(Number(t.id))) continue;
    store.data.transactions.push({
      id: Number(t.id),
      user_id: Number(t.user_id),
      amount: Number(t.amount) || 0,
      type: t.type || 'unknown',
      created_at: t.created_at || new Date().toISOString()
    });
  }

  const idInstAda = new Set(store.data.installations.map((r) => Number(r.id)));
  for (const i of lama.installations) {
    if (idInstAda.has(Number(i.id))) continue;
    store.data.installations.push({
      id: Number(i.id),
      user_id: Number(i.user_id),
      ip: i.ip || null,
      ssh_port: i.ssh_port || null,
      windows_id: i.windows_id || null,
      windows_name: i.windows_name || null,
      cost: Number(i.cost) || 0,
      status: i.status || 'unknown',
      note: i.note || null,
      created_at: i.created_at || new Date().toISOString(),
      finished_at: i.finished_at || null
    });
  }

  store.saveNow();

  const s = store.stats();
  console.log('Hasil:');
  console.log(`  User dipindahkan : ${dipindah} (dilewati karena sudah ada: ${dilewati})`);
  console.log(`  Transaksi        : ${store.data.transactions.length}`);
  console.log(`  Instalasi        : ${store.data.installations.length}`);
  console.log(`\nVerifikasi saldo:`);
  console.log(`  Sumber : Rp ${totalLama.toLocaleString('id-ID')}`);
  console.log(`  Baru   : Rp ${s.totalSaldo.toLocaleString('id-ID')}`);
  console.log(`\nTersimpan di: ${s.file}`);

  if (dilewati === 0 && Math.abs(s.totalSaldo - totalLama) < 0.01) {
    console.log('\n🎉 Cocok. Migrasi berhasil.');
  } else if (dilewati > 0) {
    console.log('\n✅ Selesai. Selisih saldo wajar karena ada user yang sudah tercatat sebelumnya.');
  } else {
    console.log('\n⚠️  Total saldo berbeda. Periksa manual sebelum menjalankan bot.');
  }

  console.log('   File sumber tidak dihapus — simpan sebagai cadangan.');
})();
