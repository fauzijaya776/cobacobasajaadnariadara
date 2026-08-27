const store = require('../utils/store');

/**
 * Pembungkus saldo yang dipakai alur deposit.
 * Sekarang berjalan di atas penyimpanan file JSON, bukan database.
 */
class BalanceManager {
  static async getUserBalance(userId) {
    return store.getBalance(userId);
  }

  /** Tambah saldo dan catat transaksinya. */
  static async updateBalance(userId, amount, type = 'deposit') {
    const hasil = store.credit(userId, amount, type);
    if (!hasil.ok) throw new Error(`Nominal deposit tidak sah: ${amount}`);
    return hasil.balance;
  }

  /**
   * Kreditkan pembayaran, dijamin hanya sekali per depositId.
   *
   * Dipakai alur deposit supaya pembayaran yang sama tidak pernah dikreditkan
   * dua kali walau pemantau mengulang atau bot restart.
   *
   * @returns {{balance:number, duplikat:boolean}}
   */
  static async creditDeposit(userId, amount, depositId) {
    const hasil = store.creditDeposit(userId, amount, depositId);
    if (hasil.duplikat) {
      console.warn(`[DEPOSIT] ${depositId} sudah pernah dikreditkan — dilewati.`);
      return { balance: hasil.balance, duplikat: true };
    }
    if (!hasil.ok) throw new Error(`Nominal deposit tidak sah: ${amount}`);
    return { balance: hasil.balance, duplikat: false };
  }

  static async logTransaction(userId, amount, type) {
    // Pencatatan sudah dilakukan otomatis oleh credit/debit di store.
    // Fungsi ini dipertahankan agar pemanggil lama tidak perlu diubah.
    return true;
  }

  static async getTransactionHistory(userId, limit = 10) {
    return store.transactionsFor(userId, limit);
  }
}

module.exports = BalanceManager;
