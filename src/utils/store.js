const fs = require('fs');
const path = require('path');

/**
 * Penyimpanan data berbasis file JSON — tanpa database sama sekali.
 *
 * Cara kerjanya:
 *   - Seluruh data dimuat ke memori sekali saat bot start.
 *   - Semua perubahan dilakukan di memori secara SINKRON (tanpa await di
 *     tengah baca-ubah-tulis). Karena Node hanya menjalankan satu hal pada satu
 *     waktu, ini membuat operasi seperti pemotongan saldo benar-benar atomic.
 *   - Penulisan memakai tulis-ke-sementara lalu rename, sehingga file tidak
 *     pernah rusak separuh walau proses mati di tengah.
 *
 * Bentuk file:
 * {
 *   "version": 1,
 *   "updated_at": "...",
 *   "users": { "12345": { telegram_id, balance, created_at } },
 *   "transactions": [ { id, user_id, amount, type, created_at } ],
 *   "installations": [ { id, user_id, ip, ... } ]
 * }
 */

const DEFAULT_FILE = path.join(__dirname, '../../data/saldo.json');
const SAVE_DEBOUNCE_MS = 1000;
const MAX_TRANSACTIONS = 20000;
const MAX_INSTALLATIONS = 10000;
const MAX_DEPOSITS = 5000;

function dataKosong() {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    users: {},
    transactions: [],
    installations: [],
    // Daftar ID pembayaran yang SUDAH dikreditkan. Disimpan permanen (bukan
    // cuma di memori) supaya satu pembayaran tidak pernah dikreditkan dua kali,
    // bahkan kalau bot restart di tengah proses.
    deposits: {}
  };
}

/** Penanda khusus: pemulihan gagal karena gangguan, BUKAN karena tidak ada cadangan. */
class PemulihanGagal extends Error {}

class Store {
  constructor(filePath) {
    this.filePath = filePath
      ? path.resolve(filePath)
      : (process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : DEFAULT_FILE);
    this.data = dataKosong();
    this.siapPakai = false;

    /**
     * Kalau pemulihan dari cadangan GAGAL karena gangguan (bukan karena memang
     * belum ada cadangan), menulis cadangan baru akan MENGHAPUS satu-satunya
     * salinan saldo buyer. Selama flag ini false, cadangan otomatis dikunci.
     */
    this.bolehCadangkan = true;
    this.alasanKunci = null;

    this._timer = null;
    this._menyimpan = false;
    this._perluSimpanLagi = false;
    this._nextTrxId = 1;
    this._nextInstallId = 1;
    this.onChange = null;       // dipasang dari luar untuk cadangan otomatis
    this.onSaveError = null;    // dipanggil kalau penulisan ke disk gagal
  }

  /* ═══════════════ Muat & simpan ═══════════════ */

  /**
   * Muat data dari file. Kalau file tidak ada, `pemulih` dipanggil.
   *
   * Kontrak `pemulih`:
   *   - mengembalikan objek data  -> berhasil dipulihkan
   *   - mengembalikan null        -> memang belum ada cadangan (aman mulai kosong)
   *   - MELEMPAR error            -> gangguan; cadangan otomatis akan dikunci
   */
  async init(pemulih) {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(this.filePath)) {
      try {
        const isi = fs.readFileSync(this.filePath, 'utf8');
        if (isi.trim()) {
          this.data = this._normalkan(JSON.parse(isi));
          console.log(
            `Data dimuat dari ${this.filePath} — ` +
            `${Object.keys(this.data.users).length} user, ` +
            `total saldo Rp ${this.totalSaldo().toLocaleString('id-ID')}`
          );
          this.siapPakai = true;
          return;
        }
      } catch (error) {
        const rusak = `${this.filePath}.rusak-${Date.now()}`;
        try { fs.renameSync(this.filePath, rusak); } catch (_) {}
        console.error(`File data rusak, diamankan ke ${rusak}:`, error.message);
      }
    }

    if (typeof pemulih === 'function') {
      try {
        const pulih = await pemulih();
        if (pulih && pulih.users) {
          this.data = this._normalkan(pulih);
          this.siapPakai = true;
          this.saveNow();
          console.log(
            `Data dipulihkan dari cadangan — ` +
            `${Object.keys(this.data.users).length} user, ` +
            `total saldo Rp ${this.totalSaldo().toLocaleString('id-ID')}`
          );
          return;
        }
        // null = memang belum ada cadangan. Aman mulai dari kosong.
      } catch (error) {
        // Gangguan saat memulihkan. Data lama kemungkinan MASIH ADA di cadangan,
        // jadi jangan sampai bot menimpanya dengan data kosong.
        this.bolehCadangkan = false;
        this.alasanKunci = error.message;
        console.error('════════════════════════════════════════════════════════');
        console.error('PEMULIHAN DATA GAGAL:', error.message);
        console.error('Cadangan otomatis DIKUNCI agar cadangan lama tidak tertimpa.');
        console.error('Perbaiki koneksi/izin lalu RESTART bot untuk mencoba lagi.');
        console.error('════════════════════════════════════════════════════════');
      }
    }

    console.log(`Mulai dengan data kosong (${this.filePath})`);
    this.data = dataKosong();
    this.siapPakai = true;
    this.saveNow();
  }

  /** Rapikan data yang dimuat; entri rusak dilewati, bukan membatalkan semuanya. */
  _normalkan(obj) {
    const d = dataKosong();
    if (!obj || typeof obj !== 'object') return d;
    d.version = obj.version || 1;

    const sumberUsers = (obj.users && typeof obj.users === 'object') ? obj.users : {};
    let dilewati = 0;
    for (const key of Object.keys(sumberUsers)) {
      const u = sumberUsers[key];
      // Satu entri rusak tidak boleh membuang SELURUH cadangan.
      if (!u || typeof u !== 'object') { dilewati++; continue; }

      const id = Number(u.telegram_id ?? key);
      if (!Number.isFinite(id)) { dilewati++; continue; }

      let saldo = Number(u.balance);
      if (!Number.isFinite(saldo) || saldo < 0) saldo = 0;

      d.users[String(id)] = {
        telegram_id: id,
        balance: saldo,
        created_at: u.created_at || new Date().toISOString()
      };
    }
    if (dilewati > 0) {
      console.warn(`${dilewati} entri user rusak dilewati saat memuat data.`);
    }

    d.transactions = (Array.isArray(obj.transactions) ? obj.transactions : [])
      .filter((t) => t && typeof t === 'object')
      .slice(-MAX_TRANSACTIONS);
    d.installations = (Array.isArray(obj.installations) ? obj.installations : [])
      .filter((r) => r && typeof r === 'object')
      .slice(-MAX_INSTALLATIONS);

    // Penanda deposit yang sudah dikreditkan. Wajib ikut dipulihkan dari
    // cadangan, kalau tidak pembayaran lama bisa dikreditkan ulang.
    d.deposits = (obj.deposits && typeof obj.deposits === 'object') ? obj.deposits : {};

    // Nomor urut dihitung sekali di sini. Memakai Math.max(...array) tiap kali
    // menambah data akan melempar RangeError begitu riwayat melewati ~126.000
    // entri — dan itu terjadi persis setelah saldo diubah.
    this._nextTrxId = this._maxId(d.transactions) + 1;
    this._nextInstallId = this._maxId(d.installations) + 1;

    return d;
  }

  _maxId(arr) {
    let max = 0;
    for (const item of arr) {
      const n = Number(item && item.id);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max;
  }

  /**
   * Jadwalkan penyimpanan (digabung supaya tidak menulis tiap perubahan kecil).
   * HANYA untuk data non-kritis. Perubahan saldo memakai saveNow().
   */
  save() {
    this.data.updated_at = new Date().toISOString();
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Tulis sekarang juga.
   * @returns {boolean} true kalau berhasil ditulis ke disk.
   */
  saveNow() {
    if (this._menyimpan) { this._perluSimpanLagi = true; return true; }
    this._menyimpan = true;

    let tersimpan = false;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const sementara = `${this.filePath}.tmp`;
      fs.writeFileSync(sementara, JSON.stringify(this.data, null, 2));
      fs.renameSync(sementara, this.filePath);   // atomic
      tersimpan = true;
    } catch (error) {
      console.error('Gagal menyimpan data ke disk:', error.message);
      if (this.onSaveError) {
        try { this.onSaveError(error); } catch (_) {}
      }
    } finally {
      this._menyimpan = false;
    }

    // Cadangan tetap dipicu WALAU penulisan ke disk gagal. Justru saat disk
    // bermasalah, cadangan Telegram adalah satu-satunya tempat data selamat.
    if (this.onChange && this.bolehCadangkan) {
      try { this.onChange(this.data); } catch (_) {}
    }

    if (this._perluSimpanLagi) {
      this._perluSimpanLagi = false;
      this.saveNow();
    }
    return tersimpan;
  }

  /* ═══════════════ User & saldo ═══════════════ */

  getUser(userId) {
    const key = String(userId);
    if (!this.data.users[key]) {
      this.data.users[key] = {
        telegram_id: Number(userId),
        balance: 0,
        created_at: new Date().toISOString()
      };
      this.save();
    }
    return this.data.users[key];
  }

  getBalance(userId) {
    const u = this.data.users[String(userId)];
    if (!u) return 0;
    const n = Number(u.balance);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Tambah saldo.
   * @returns {{ok: boolean, balance: number, tersimpan: boolean}}
   */
  credit(userId, amount, type = 'deposit') {
    const jumlah = Number(amount);
    if (!Number.isFinite(jumlah) || jumlah <= 0) {
      return { ok: false, balance: this.getBalance(userId), tersimpan: true };
    }

    const u = this.getUser(userId);
    // Catatan disiapkan lebih dulu; tidak ada operasi yang bisa melempar
    // setelah saldo diubah, sehingga saldo tidak pernah berubah tanpa tercatat.
    const catatan = this._buatCatatan(userId, jumlah, type);
    u.balance = Number(u.balance) + jumlah;
    this.data.transactions.push(catatan);
    this._pangkasRiwayat();

    const tersimpan = this.saveNow();
    return { ok: true, balance: u.balance, tersimpan };
  }

  /**
   * Potong saldo.
   *
   * Pengecekan dan pengurangan terjadi dalam satu blok sinkron, jadi tidak
   * mungkin dua permintaan lolos bersamaan dan membuat saldo minus.
   *
   * @returns {{ok: boolean, balance: number, tersimpan: boolean}}
   */
  debit(userId, amount) {
    const jumlah = Number(amount);
    if (!Number.isFinite(jumlah) || jumlah <= 0) {
      return { ok: false, balance: this.getBalance(userId), tersimpan: true };
    }

    const u = this.getUser(userId);
    const saldo = Number(u.balance);
    if (!Number.isFinite(saldo) || saldo < jumlah) {
      return { ok: false, balance: Number.isFinite(saldo) ? saldo : 0, tersimpan: true };
    }

    const catatan = this._buatCatatan(userId, -jumlah, 'deduct');
    u.balance = saldo - jumlah;
    this.data.transactions.push(catatan);
    this._pangkasRiwayat();

    const tersimpan = this.saveNow();
    return { ok: true, balance: u.balance, tersimpan };
  }

  cukup(userId, amount) {
    return this.getBalance(userId) >= Number(amount);
  }

  /* ═══════════════ Idempotensi deposit ═══════════════ */

  /** Apakah pembayaran ini sudah pernah dikreditkan. */
  sudahDikredit(depositId) {
    if (!depositId) return false;
    return Boolean(this.data.deposits && this.data.deposits[String(depositId)]);
  }

  /**
   * Kreditkan pembayaran SEKALI SAJA.
   *
   * Penanda dan penambahan saldo terjadi dalam satu blok sinkron, lalu
   * disimpan bersama-sama. Jadi mustahil saldo bertambah tanpa penandanya
   * ikut tersimpan — dan percobaan ulang berikutnya pasti tertolak.
   *
   * Ini pengaman terhadap kejadian nyata: pemantau pembayaran mengulang tiap
   * 10 detik, dan kalau pengkreditan dianggap gagal padahal saldo sudah
   * bertambah, user bisa dikreditkan berkali-kali untuk satu pembayaran.
   *
   * @returns {{ok, balance, tersimpan, duplikat}}
   */
  creditDeposit(userId, amount, depositId, type = 'deposit') {
    if (depositId && this.sudahDikredit(depositId)) {
      return {
        ok: false,
        duplikat: true,
        balance: this.getBalance(userId),
        tersimpan: true
      };
    }

    const jumlah = Number(amount);
    if (!Number.isFinite(jumlah) || jumlah <= 0) {
      return { ok: false, duplikat: false, balance: this.getBalance(userId), tersimpan: true };
    }

    const u = this.getUser(userId);
    const catatan = this._buatCatatan(userId, jumlah, type);
    u.balance = Number(u.balance) + jumlah;
    this.data.transactions.push(catatan);

    if (depositId) {
      if (!this.data.deposits) this.data.deposits = {};
      this.data.deposits[String(depositId)] = {
        user_id: Number(userId),
        amount: jumlah,
        at: new Date().toISOString()
      };
      this._pangkasDeposits();
    }
    this._pangkasRiwayat();

    const tersimpan = this.saveNow();
    return { ok: true, duplikat: false, balance: u.balance, tersimpan };
  }

  _pangkasDeposits() {
    const kunci = Object.keys(this.data.deposits);
    if (kunci.length <= MAX_DEPOSITS) return;
    // Buang yang paling lama; urutkan berdasarkan waktu kredit.
    kunci
      .sort((a, b) => String(this.data.deposits[a].at).localeCompare(String(this.data.deposits[b].at)))
      .slice(0, kunci.length - Math.floor(MAX_DEPOSITS * 0.8))
      .forEach((k) => delete this.data.deposits[k]);
  }

  _buatCatatan(userId, amount, type) {
    return {
      id: this._nextTrxId++,
      user_id: Number(userId),
      amount: Number(amount),
      type,
      created_at: new Date().toISOString()
    };
  }

  _pangkasRiwayat() {
    if (this.data.transactions.length > MAX_TRANSACTIONS) {
      this.data.transactions = this.data.transactions.slice(-Math.floor(MAX_TRANSACTIONS * 0.75));
    }
  }

  listUserIds() {
    return Object.values(this.data.users).map((u) => u.telegram_id);
  }

  totalSaldo() {
    return Object.values(this.data.users)
      .reduce((s, u) => s + (Number(u.balance) || 0), 0);
  }

  transactionsFor(userId, limit = 10) {
    return this.data.transactions
      .filter((t) => Number(t.user_id) === Number(userId))
      .slice(-limit)
      .reverse();
  }

  /* ═══════════════ Riwayat instalasi ═══════════════ */

  addInstallation(userId, data) {
    const id = this._nextInstallId++;
    this.data.installations.push({
      id,
      user_id: Number(userId),
      ip: data.ip || null,
      ssh_port: data.sshPort || null,
      windows_id: data.windowsId || null,
      windows_name: data.windowsName || null,
      cost: Number(data.cost) || 0,
      status: data.status || 'pending',
      note: null,
      created_at: new Date().toISOString(),
      finished_at: null
    });
    if (this.data.installations.length > MAX_INSTALLATIONS) {
      this.data.installations = this.data.installations.slice(-Math.floor(MAX_INSTALLATIONS * 0.8));
    }
    this.save();
    return id;
  }

  updateInstallation(id, status, note = null) {
    if (!id) return;
    const row = this.data.installations.find((r) => Number(r.id) === Number(id));
    if (!row) return;
    row.status = status;
    row.note = note;
    row.finished_at = new Date().toISOString();
    this.save();
  }

  /* ═══════════════ Ekspor & info ═══════════════ */

  exportAll() {
    return JSON.parse(JSON.stringify(this.data));
  }

  stats() {
    return {
      users: Object.keys(this.data.users).length,
      totalSaldo: this.totalSaldo(),
      transactions: this.data.transactions.length,
      installations: this.data.installations.length,
      deposits: Object.keys(this.data.deposits || {}).length,
      updated_at: this.data.updated_at,
      file: this.filePath,
      bolehCadangkan: this.bolehCadangkan,
      alasanKunci: this.alasanKunci
    };
  }
}

const store = new Store();

/**
 * Simpan perubahan terakhir sebelum proses berhenti.
 *
 * Penjaga `siapPakai` WAJIB ada: modul ini ikut ter-import oleh skrip apa pun
 * yang memakai userManager/balanceHandler. Tanpa penjaga, skrip yang tidak
 * pernah memanggil init() akan menulis data KOSONG menimpa file saldo asli
 * saat ia selesai.
 *
 * Modul ini SENGAJA tidak memasang handler SIGINT/SIGTERM sendiri. Dulu ia
 * melakukannya lalu memanggil process.exit(0) — yang mematikan proses sebelum
 * index.js sempat mengirim cadangan terakhir ke Telegram. Sekarang urusan
 * berhenti dipegang satu tempat saja: index.js.
 */
function simpanSebelumKeluar() {
  if (!store.siapPakai) return false;
  try { return store.saveNow(); } catch (_) { return false; }
}

module.exports = store;
module.exports.Store = Store;
module.exports.PemulihanGagal = PemulihanGagal;
module.exports.simpanSebelumKeluar = simpanSebelumKeluar;
