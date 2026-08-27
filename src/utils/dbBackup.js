const fs = require('fs');
const os = require('os');
const path = require('path');
const { scheduleJob } = require('node-schedule');
const db = require('../config/database');
const { isAdmin } = require('./userManager');

const TABLES = ['users', 'transactions', 'installations'];

class DatabaseBackup {
  constructor(bot) {
    this.bot = bot;
    this.backupSchedule = '0 0 * * 0'; // tiap Minggu tengah malam
  }

  /** Admin pertama pada ADMIN_ID (mendukung beberapa admin dipisah koma). */
  get adminId() {
    return (process.env.ADMIN_ID || '').split(',')[0].trim();
  }

  /**
   * Ekspor seluruh isi database ke satu file JSON.
   *
   * Dipakai untuk kedua mode. Pada mode Turso tidak ada file .db lokal yang
   * bisa dikirim, dan dump JSON juga lebih mudah diperiksa serta dipulihkan
   * daripada file biner.
   */
  async exportToJson() {
    const dump = {
      exported_at: new Date().toISOString(),
      mode: db.info().isRemote ? 'turso' : 'file',
      tables: {}
    };

    for (const table of TABLES) {
      try {
        dump.tables[table] = await db.all(`SELECT * FROM ${table}`);
      } catch (error) {
        // Tabel bisa saja belum ada pada instalasi baru — bukan alasan gagal.
        console.warn(`Backup: tabel ${table} dilewati (${error.message})`);
        dump.tables[table] = [];
      }
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const filePath = path.join(os.tmpdir(), `rdpbot-backup-${stamp}.json`);
    fs.writeFileSync(filePath, JSON.stringify(dump, null, 2));
    return { filePath, dump };
  }

  /**
   * Kirim backup ke admin.
   * @returns {Promise<boolean>} true kalau benar-benar terkirim.
   *          Pemanggil memakai ini agar tidak melaporkan sukses palsu.
   */
  async sendBackupToAdmin() {
    try {
      if (!this.adminId) {
        console.error('Admin ID belum diatur — backup dilewati');
        return false;
      }

      const { filePath, dump } = await this.exportToJson();
      const users = dump.tables.users || [];
      const totalSaldo = users.reduce((sum, u) => sum + Number(u.balance || 0), 0);
      const sizeKb = (fs.statSync(filePath).size / 1024).toFixed(1);

      await this.bot.sendDocument(this.adminId, filePath, {
        caption:
          `📊 *Backup Database*\n\n` +
          `📅 ${new Date().toLocaleString('id-ID')}\n` +
          `🗄️ Mode: ${dump.mode === 'turso' ? 'Turso (cloud)' : 'File lokal'}\n` +
          `👥 User: ${users.length}\n` +
          `💰 Total saldo: Rp ${totalSaldo.toLocaleString('id-ID')}\n` +
          `🧾 Transaksi: ${(dump.tables.transactions || []).length}\n` +
          `🖥️ Instalasi: ${(dump.tables.installations || []).length}\n` +
          `📦 ${sizeKb} KB`,
        parse_mode: 'Markdown'
      });

      try { fs.unlinkSync(filePath); } catch (_) {}

      console.log('Backup database terkirim');
      return true;
    } catch (error) {
      console.error('Gagal mengirim backup database:', error.message);
      return false;
    }
  }

  scheduleBackup() {
    scheduleJob(this.backupSchedule, () => {
      this.sendBackupToAdmin();
    });
    console.log('Backup database dijadwalkan (tiap Minggu 00:00)');
  }

  async handleManageDatabase(chatId, messageId) {
    if (!isAdmin(chatId)) {
      await this.bot.editMessageText('❌ Akses ditolak. Khusus admin.', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [[{ text: '« Kembali', callback_data: 'back_to_menu' }]]
        }
      }).catch(() => {});
      return;
    }

    const info = db.info();
    const lokasi = info.isRemote
      ? `Turso — ${info.url.replace(/^libsql:\/\//, '')}`
      : `File lokal — ${info.localPath}`;

    let ringkasan = '';
    try {
      const u = await db.get('SELECT COUNT(*) AS n, SUM(balance) AS total FROM users');
      ringkasan =
        `👥 User: ${u.n || 0}\n` +
        `💰 Total saldo: Rp ${Number(u.total || 0).toLocaleString('id-ID')}\n\n`;
    } catch (_) {
      ringkasan = '';
    }

    await this.bot.editMessageText(
      `📊 *Manajemen Database*\n\n` +
      `🗄️ ${lokasi}\n\n` +
      ringkasan +
      `• Backup otomatis tiap Minggu\n` +
      `• Backup manual bisa kapan saja\n\n` +
      `Pilih tindakan:`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📥 Backup Sekarang', callback_data: 'backup_now' }],
            [{ text: '« Kembali ke Menu', callback_data: 'back_to_menu' }]
          ]
        }
      }
    ).catch(() => {});
  }
}

module.exports = DatabaseBackup;
