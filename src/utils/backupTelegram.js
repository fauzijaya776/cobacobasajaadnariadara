const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

/**
 * Cadangan data ke Telegram — pengganti persistent disk.
 *
 * Di hosting gratis seperti Render, filesystem bersifat sementara: file JSON
 * apa pun hilang setiap container restart. Solusinya, setiap perubahan saldo
 * dikirim sebagai dokumen ke chat admin lalu DISEMAT. Saat bot start dan file
 * lokalnya tidak ada, bot membaca pesan tersemat itu dan memulihkan datanya.
 *
 * Pesan tersemat dipakai sebagai penanda karena Bot API tidak bisa menelusuri
 * riwayat pesannya sendiri, sedangkan getChat() selalu mengembalikan pesan
 * yang sedang tersemat.
 */

const JEDA_MINIMAL_MS = 20000;   // jangan spam Telegram
const JEDA_ULANG_MS = 15000;     // jeda sebelum mencoba lagi setelah gagal
const MAKS_PERCOBAAN = 5;
const NAMA_FILE = 'saldo-backup.json';

class BackupTelegram {
  /**
   * @param {object} opsi.unduh  Pengganti fungsi pengunduh, dipakai pengujian
   *                             agar logika pemulihan bisa diuji tanpa jaringan.
   */
  constructor(bot, chatId, opsi = {}) {
    this.bot = bot;
    this.chatId = String(chatId || '').trim();
    this.aktif = Boolean(this.chatId);
    this._unduh = opsi.unduh || unduh;
    this._terakhirSukses = 0;
    this._timer = null;
    this._sedangKirim = false;
    this._dataTerbaru = null;
    this._dataTerkirim = null;   // data yang sedang dalam proses pengiriman
    this._gagalBeruntun = 0;
    this.onGagalTerus = null;    // dipanggil kalau cadangan gagal berkali-kali

    // Untuk menjaga chat tetap bersih: id pesan cadangan sebelumnya, dan
    // sidik jari isi yang terakhir benar-benar terkirim.
    this._pesanSebelumnyaId = null;
    this._sidikJariTerkirim = null;

    // Sebagian versi Telegram/library tidak mendukung penyuntingan dokumen.
    // Kalau sekali gagal, jangan dicoba terus — langsung pakai cara kirim biasa.
    this._editDidukung = true;
  }

  /**
   * Sidik jari isi data, TANPA updated_at.
   *
   * Banyak penyimpanan tidak mengubah apa pun yang berarti (mis. status
   * instalasi disimpan ulang). Tanpa perbandingan ini, tiap penyimpanan
   * mengirim file baru dan chat admin penuh oleh cadangan yang isinya sama.
   */
  _sidikJari(data) {
    if (!data) return '';
    return JSON.stringify({
      users: data.users || {},
      deposits: data.deposits || {},
      nTrx: (data.transactions || []).length,
      nInst: (data.installations || []).length
    });
  }

  /** Apakah ada perubahan yang belum sampai ke Telegram. */
  get adaTertunda() {
    return Boolean(this._dataTerbaru);
  }

  /**
   * Jadwalkan pengiriman cadangan.
   * Panggilan beruntun digabung; data terbaru selalu menang.
   */
  jadwalkan(data) {
    if (!this.aktif || !data) return;
    this._dataTerbaru = data;

    // Kalau pengiriman sebelumnya masih berjalan, JANGAN pasang timer baru —
    // pengiriman yang berjalan akan menjadwalkan ulang sendiri saat selesai.
    // Tanpa ini, jadwal hilang begitu saja dan perubahan terakhir tidak pernah
    // sampai ke Telegram.
    if (this._sedangKirim || this._timer) return;

    const sisa = Math.max(0, JEDA_MINIMAL_MS - (Date.now() - this._terakhirSukses));
    this._timer = setTimeout(() => {
      this._timer = null;
      this._prosesAntrian();
    }, sisa);
  }

  async _prosesAntrian() {
    if (!this._dataTerbaru || this._sedangKirim) return;

    const data = this._dataTerbaru;
    this._dataTerbaru = null;

    // Isinya sama persis dengan yang sudah tersimpan di Telegram — tidak perlu
    // mengirim file lagi. Ini yang mencegah chat penuh oleh cadangan kembar.
    if (this._sidikJari(data) === this._sidikJariTerkirim) {
      this._gagalBeruntun = 0;
      return;
    }

    this._dataTerkirim = data;
    const berhasil = await this.kirimSekarang(data);

    if (berhasil) {
      this._gagalBeruntun = 0;
      this._dataTerkirim = null;
    } else {
      // Kembalikan ke antrian supaya dicoba lagi — kecuali sudah ada data
      // yang lebih baru menunggu (data terbaru lebih berharga).
      this._gagalBeruntun++;
      if (!this._dataTerbaru) this._dataTerbaru = data;
      this._dataTerkirim = null;

      if (this._gagalBeruntun >= MAKS_PERCOBAAN) {
        console.error(
          `Cadangan Telegram gagal ${this._gagalBeruntun}x beruntun. ` +
          `Data terbaru BELUM tersimpan permanen.`
        );
        if (this.onGagalTerus) {
          try { this.onGagalTerus(this._gagalBeruntun); } catch (_) {}
        }
      }
    }

    // Masih ada yang menunggu? Jadwalkan putaran berikutnya.
    if (this._dataTerbaru && !this._timer) {
      const jeda = berhasil ? JEDA_MINIMAL_MS : JEDA_ULANG_MS;
      this._timer = setTimeout(() => {
        this._timer = null;
        this._prosesAntrian();
      }, jeda);
    }
  }

  /**
   * Kirim sekarang juga, tanpa menunggu jadwal.
   * @returns {Promise<boolean>}
   */
  async kirimSekarang(data) {
    if (!this.aktif || !data) return false;
    if (this._sedangKirim) return false;
    this._sedangKirim = true;

    const berkas = path.join(os.tmpdir(), NAMA_FILE);
    try {
      fs.writeFileSync(berkas, JSON.stringify(data, null, 2));

      const jumlahUser = Object.keys(data.users || {}).length;
      const total = Object.values(data.users || {})
        .reduce((s, u) => s + (Number(u && u.balance) || 0), 0);

      const caption =
        `💾 Cadangan otomatis\n` +
        `${new Date().toLocaleString('id-ID')}\n` +
        `${jumlahUser} user · Rp ${total.toLocaleString('id-ID')}\n\n` +
        `Jangan hapus atau lepas sematan pesan ini — ` +
        `dari sinilah data dipulihkan kalau server restart.`;

      /*
       * Kalau sudah ada pesan cadangan, PERBARUI pesan itu — jangan kirim yang
       * baru. Mengirim pesan baru berarti: muncul notifikasi, chat melompat ke
       * bawah, dan pesan penting lain (mis. progres instalasi) terdorong ke atas.
       * Menyunting membuat file cadangan tetap di tempatnya dan sematannya utuh.
       */
      if (this._editDidukung && this._pesanSebelumnyaId) {
        try {
          await this.bot.editMessageMedia(
            { type: 'document', media: berkas, caption },
            { chat_id: this.chatId, message_id: this._pesanSebelumnyaId }
          );
          this._terakhirSukses = Date.now();
          this._sidikJariTerkirim = this._sidikJari(data);
          return true;
        } catch (errEdit) {
          // Tidak didukung / pesan sudah hilang -> pakai cara biasa mulai sekarang.
          this._editDidukung = false;
          console.warn('Menyunting cadangan tidak berhasil, beralih ke kirim ulang:',
            errEdit.message);
        }
      }

      const pesan = await this.bot.sendDocument(this.chatId, berkas, {
        caption,
        // Tanpa ini, tiap cadangan membunyikan notifikasi di HP admin.
        disable_notification: true
      });

      if (pesan && pesan.message_id) {
        try {
          await this.bot.pinChatMessage(this.chatId, pesan.message_id, {
            disable_notification: true
          });
        } catch (errPin) {
          // Dokumen sudah terkirim tapi tidak tersemat = tidak bisa dipulihkan.
          // Ini harus dianggap GAGAL supaya dicoba lagi.
          console.error('Cadangan terkirim tapi gagal disemat:', errPin.message);
          return false;
        }

        // Cadangan baru sudah aman tersemat, jadi yang lama boleh dibuang.
        // Tanpa ini chat admin penuh oleh file cadangan dan notifikasi
        // penting ikut terkubur. Dihapus SETELAH yang baru tersemat, supaya
        // tidak pernah ada momen tanpa cadangan sama sekali.
        if (this._pesanSebelumnyaId && this._pesanSebelumnyaId !== pesan.message_id) {
          try {
            await this.bot.deleteMessage(this.chatId, this._pesanSebelumnyaId);
          } catch (_) {
            // Telegram melarang bot menghapus pesan yang lebih tua dari 48 jam.
            // Itu bukan masalah — cukup dilewati.
          }
        }
        this._pesanSebelumnyaId = pesan.message_id;
      }

      this._terakhirSukses = Date.now();
      this._sidikJariTerkirim = this._sidikJari(data);
      return true;
    } catch (error) {
      console.error('Cadangan ke Telegram gagal:', error.message);
      return false;
    } finally {
      try { fs.unlinkSync(berkas); } catch (_) {}
      this._sedangKirim = false;
    }
  }

  /**
   * Pastikan perubahan terakhir sampai ke Telegram sebelum proses berhenti.
   * Dipanggil saat SIGTERM (Render mengirimnya di setiap deploy/restart).
   */
  async flush(batasMs = 8000) {
    if (!this.aktif) return true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }

    const data = this._dataTerbaru || this._dataTerkirim;
    if (!data) return true;

    // Tunggu pengiriman yang sedang berjalan supaya tidak bentrok.
    const mulai = Date.now();
    while (this._sedangKirim && Date.now() - mulai < batasMs) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const sisa = Math.max(1000, batasMs - (Date.now() - mulai));
    return Promise.race([
      this.kirimSekarang(data),
      new Promise((r) => setTimeout(() => r(false), sisa))
    ]);
  }

  /**
   * Ambil kembali data dari pesan tersemat.
   *
   * @returns {Promise<object|null>} isi cadangan, atau null kalau MEMANG
   *          belum ada cadangan.
   * @throws  kalau terjadi gangguan (jaringan, izin, file rusak). Bedanya
   *          penting: null berarti aman mulai dari kosong, sedangkan error
   *          berarti data lama mungkin masih ada dan TIDAK BOLEH ditimpa.
   */
  /**
   * Catat id pesan cadangan yang sedang tersemat, tanpa mengunduh isinya.
   *
   * Dipanggil saat bot start ketika data diambil dari file lokal (jadi
   * pulihkan() tidak dijalankan). Tanpa ini, cadangan dari sesi sebelumnya
   * tidak pernah dihapus dan file menumpuk di chat setiap kali bot restart.
   */
  async catatSematanTerakhir() {
    if (!this.aktif) return;
    try {
      const chat = await this.bot.getChat(this.chatId);
      const tersemat = chat && chat.pinned_message;
      if (tersemat && tersemat.document &&
          String(tersemat.document.file_name || '').endsWith('.json')) {
        this._pesanSebelumnyaId = tersemat.message_id;
      }
    } catch (_) {
      // Tidak apa-apa: hanya berarti cadangan lama tidak ikut dibersihkan.
    }
  }

  async pulihkan() {
    if (!this.aktif) return null;

    let chat;
    try {
      chat = await this.bot.getChat(this.chatId);
    } catch (error) {
      throw new Error(`tidak bisa membaca chat cadangan: ${error.message}`);
    }

    const tersemat = chat && chat.pinned_message;
    if (!tersemat || !tersemat.document) {
      console.log('Tidak ada cadangan tersemat di Telegram.');
      return null;                       // memang belum ada — aman
    }

    const namaDoc = tersemat.document.file_name || '';
    if (!namaDoc.endsWith('.json')) {
      console.log(`Pesan tersemat bukan cadangan JSON (${namaDoc}).`);
      return null;
    }

    let isi;
    try {
      const tautan = await this.bot.getFileLink(tersemat.document.file_id);
      isi = await this._unduh(tautan);
    } catch (error) {
      throw new Error(`gagal mengunduh cadangan: ${error.message}`);
    }

    let data;
    try {
      data = JSON.parse(isi);
    } catch (error) {
      throw new Error(`isi cadangan bukan JSON yang sah: ${error.message}`);
    }

    if (!data || typeof data !== 'object' || !data.users) {
      throw new Error('bentuk isi cadangan tidak dikenali');
    }

    // Data ini sudah ada di Telegram, jadi jangan kirim ulang isi yang sama.
    // Id-nya juga dicatat supaya file lama bisa dihapus saat cadangan berikutnya.
    this._sidikJariTerkirim = this._sidikJari(data);
    this._pesanSebelumnyaId = tersemat.message_id;

    return data;
  }
}

function unduh(url, sisaRedirect = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && sisaRedirect > 0) {
        res.resume();
        return resolve(unduh(res.headers.location, sisaRedirect - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve(buf));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('waktu unduh habis'));
    });
  });
}

module.exports = BackupTelegram;
