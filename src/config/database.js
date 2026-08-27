const path = require('path');
const { createClient } = require('@libsql/client');

/**
 * Lapisan database.
 *
 * Mendukung dua mode dengan API yang sama persis, sehingga tidak ada file lain
 * yang perlu tahu sedang memakai yang mana:
 *
 *   1. TURSO  — kalau TURSO_DATABASE_URL diisi. Data disimpan di server Turso,
 *               bukan di dalam container. Ini yang membuat saldo user selamat
 *               walau hosting-nya restart, redeploy, atau filesystem-nya dihapus
 *               (mis. free tier Render yang tidak punya persistent disk).
 *
 *   2. FILE   — kalau tidak diisi. Memakai file SQLite lokal seperti sebelumnya.
 *               Cocok untuk menjalankan bot di PC sendiri atau di VPS.
 *
 * @libsql/client memakai dialek SQLite yang sama, jadi seluruh query di project
 * ini tidak berubah sedikit pun.
 */

const TURSO_URL = (process.env.TURSO_DATABASE_URL || '').trim();
const TURSO_TOKEN = (process.env.TURSO_AUTH_TOKEN || '').trim();

const LOCAL_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '../rdp.db');

const isRemote = TURSO_URL.length > 0;

if (isRemote && !TURSO_TOKEN) {
  console.error(
    'FATAL: TURSO_DATABASE_URL sudah diisi tapi TURSO_AUTH_TOKEN kosong.\n' +
    '       Turso menolak koneksi tanpa token. Buat token di dashboard Turso\n' +
    '       (tombol "Create Token"), lalu isi TURSO_AUTH_TOKEN di .env.'
  );
  process.exit(1);
}

const client = isRemote
  ? createClient({ url: TURSO_URL, authToken: TURSO_TOKEN })
  : createClient({ url: `file:${LOCAL_PATH}` });

console.log(
  isRemote
    ? `Database: Turso (${TURSO_URL.replace(/^libsql:\/\//, '')})`
    : `Database: file lokal (${LOCAL_PATH})`
);

/**
 * Ubah baris hasil libsql menjadi objek biasa.
 *
 * Baris dari libsql adalah objek khusus, dan kolom INTEGER besar bisa datang
 * sebagai BigInt. BigInt akan meledak kalau dipakai di aritmatika biasa
 * ("Cannot mix BigInt and other types") atau di JSON.stringify, jadi dikonversi
 * di satu tempat ini saja.
 */
function normalizeRow(row) {
  if (!row) return undefined;
  const out = {};
  for (const key of Object.keys(row)) {
    const value = row[key];
    out[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return out;
}

const dbAsync = {
  /**
   * Jalankan INSERT/UPDATE/DELETE.
   * @returns {{id: number, changes: number}} bentuknya dipertahankan sama
   *          seperti versi sqlite3 agar pemanggil tidak perlu diubah.
   */
  async run(sql, params = []) {
    const result = await client.execute({ sql, args: params });
    return {
      // lastInsertRowid bertipe BigInt di libsql — wajib dikonversi.
      id: result.lastInsertRowid == null ? 0 : Number(result.lastInsertRowid),
      changes: Number(result.rowsAffected || 0)
    };
  },

  /** Ambil satu baris, atau undefined kalau tidak ada. */
  async get(sql, params = []) {
    const result = await client.execute({ sql, args: params });
    return normalizeRow(result.rows[0]);
  },

  /** Ambil semua baris. */
  async all(sql, params = []) {
    const result = await client.execute({ sql, args: params });
    return result.rows.map(normalizeRow);
  },

  /** Jalankan satu atau beberapa pernyataan DDL sekaligus. */
  async exec(sql) {
    await client.executeMultiple(sql);
  },

  /** Info mode yang sedang dipakai — dipakai fitur backup. */
  info() {
    return { isRemote, localPath: LOCAL_PATH, url: TURSO_URL };
  },

  /** Akses langsung ke client libsql, untuk keperluan khusus. */
  raw: client
};

async function initDatabase() {
  try {
    await dbAsync.exec(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        balance REAL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbAsync.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        type TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Riwayat instalasi: untuk audit "siapa gagal kapan" dan memastikan
    // tidak ada saldo terpotong tanpa jejak.
    await dbAsync.exec(`
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
      )
    `);

    await dbAsync.exec(
      'CREATE INDEX IF NOT EXISTS idx_installations_user ON installations(user_id)'
    );
    await dbAsync.exec(
      'CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id)'
    );

    // Pengaturan khusus file lokal. Tidak relevan (dan tidak didukung) untuk
    // koneksi remote, jadi hanya dijalankan pada mode file dan dibuat
    // best-effort supaya kegagalan tidak mematikan bot.
    if (!isRemote) {
      try {
        await client.execute('PRAGMA journal_mode = WAL');
        await client.execute('PRAGMA busy_timeout = 5000');
      } catch (pragmaError) {
        console.warn('PRAGMA gagal diterapkan:', pragmaError.message);
      }
    }

    console.log('Database tables initialized successfully');
  } catch (error) {
    console.error('Error initializing database tables:', error.message);
    if (isRemote) {
      console.error(
        'Cek kembali TURSO_DATABASE_URL dan TURSO_AUTH_TOKEN di .env.\n' +
        'Token yang sudah kedaluwarsa juga menghasilkan error ini.'
      );
    }
    process.exit(1);
  }
}

const ready = initDatabase();
dbAsync.ready = ready;

process.on('SIGINT', () => {
  try { client.close(); } catch (_) {}
  console.log('Database connection closed');
  process.exit(0);
});

module.exports = dbAsync;
