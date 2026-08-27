const fs = require('fs');
const os = require('os');
const path = require('path');
const { scheduleJob } = require('node-schedule');
const store = require('./store');
const { isAdmin } = require('./userManager');

/**
 * Backup manual & terjadwal ke admin.
 *
 * Berbeda dari backupTelegram.js yang berjalan otomatis di latar belakang,
 * yang ini dipicu admin lewat tombol atau jadwal mingguan, dan hasilnya
 * bisa disimpan sendiri oleh admin sebagai arsip.
 */
class DatabaseBackup {
  constructor(bot) {
    this.bot = bot;
    this.backupSchedule = '0 0 * * 0'; // tiap Minggu tengah malam
  }

  get adminId() {
    return (process.env.ADMIN_ID || '').split(',')[0].trim();
  }

  /** Tulis seluruh data ke satu file JSON sementara. */
  exportToFile() {
    const data = store.exportAll();
    const stamp = new Date().toISOString().slice(0, 10);
    const filePath = path.join(os.tmpdir(), `rdpbot-backup-${stamp}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return { filePath, data };
  }

  /**
   * @returns {Promise<boolean>} true kalau benar-benar terkirim.
   *          Pemanggil memakai ini agar tidak melaporkan sukses palsu.
   */
  async sendBackupToAdmin() {
    try {
      if (!this.adminId) {
        console.error('Admin ID belum diatur — backup dilewati');
        return false;
      }

      const { filePath } = this.exportToFile();
      const s = store.stats();
      const sizeKb = (fs.statSync(filePath).size / 1024).toFixed(1);

      await this.bot.sendDocument(this.adminId, filePath, {
        caption:
          `📊 *Backup Data*\n\n` +
          `📅 ${new Date().toLocaleString('id-ID')}\n` +
          `👥 User: ${s.users}\n` +
          `💰 Total saldo: Rp ${s.totalSaldo.toLocaleString('id-ID')}\n` +
          `🧾 Transaksi: ${s.transactions}\n` +
          `🖥️ Instalasi: ${s.installations}\n` +
          `📦 ${sizeKb} KB`,
        parse_mode: 'Markdown'
      });

      try { fs.unlinkSync(filePath); } catch (_) {}
      console.log('Backup terkirim ke admin');
      return true;
    } catch (error) {
      console.error('Gagal mengirim backup:', error.message);
      return false;
    }
  }

  scheduleBackup() {
    scheduleJob(this.backupSchedule, () => this.sendBackupToAdmin());
    console.log('Backup mingguan dijadwalkan (tiap Minggu 00:00)');
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

    const s = store.stats();
    const autoAktif = Boolean((process.env.BACKUP_CHAT_ID || '').trim());

    await this.bot.editMessageText(
      `📊 *Manajemen Data*\n\n` +
      `🗄️ Penyimpanan: file JSON\n` +
      `📁 ${s.file}\n\n` +
      `👥 User: ${s.users}\n` +
      `💰 Total saldo: Rp ${s.totalSaldo.toLocaleString('id-ID')}\n` +
      `🧾 Transaksi: ${s.transactions}\n` +
      `🖥️ Instalasi: ${s.installations}\n` +
      `🕒 Terakhir berubah: ${s.updated_at ? new Date(s.updated_at).toLocaleString('id-ID') : '-'}\n\n` +
      `🔄 Cadangan otomatis: ${autoAktif ? '✅ aktif' : '⚠️ nonaktif (BACKUP_CHAT_ID belum diisi)'}\n` +
      `📆 Backup mingguan: tiap Minggu 00:00\n\n` +
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
