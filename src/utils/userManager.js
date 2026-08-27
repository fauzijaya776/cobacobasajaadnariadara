const store = require('./store');

/**
 * Semua fungsi tetap `async` walau penyimpanannya kini sinkron (file JSON),
 * supaya seluruh pemanggil di project ini tidak perlu diubah sama sekali.
 */

async function getUser(userId) {
  return store.getUser(userId);
}

function isAdmin(userId) {
  const adminId = process.env.ADMIN_ID;
  if (!adminId) return false;
  // Mendukung beberapa admin, dipisah koma.
  return adminId
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(String(userId));
}

async function addBalance(userId, amount, type = 'deposit') {
  const hasil = store.credit(userId, amount, type);
  if (!hasil.tersimpan) {
    // Saldo sudah bertambah di memori tapi gagal ditulis ke disk. Cadangan
    // Telegram tetap dipicu, jadi belum tentu hilang — tapi harus terlihat
    // di log, bukan lewat begitu saja.
    console.error(`[BILLING] Penambahan saldo user ${userId} belum tersimpan ke disk.`);
  }
  return hasil.balance;
}

/**
 * Potong saldo.
 *
 * Pengecekan "saldo cukup" dan pengurangannya terjadi dalam satu blok sinkron
 * di dalam store, tanpa await di tengah. Karena Node menjalankan satu hal pada
 * satu waktu, dua klik cepat tidak mungkin lolos bersamaan — jadi saldo tidak
 * bisa menjadi minus.
 */
async function deductBalance(userId, amount) {
  if (isAdmin(userId)) return true;
  try {
    const hasil = store.debit(userId, amount);
    if (hasil.ok && !hasil.tersimpan) {
      console.error(`[BILLING] Pemotongan saldo user ${userId} belum tersimpan ke disk.`);
    }
    return hasil.ok;
  } catch (error) {
    console.error('Error deducting balance:', error.message);
    return false;
  }
}

/** Kembalikan saldo yang sudah terpotong. */
async function refundBalance(userId, amount, reason = 'refund') {
  if (isAdmin(userId)) return true;
  try {
    const hasil = store.credit(userId, amount, reason);
    console.log(`[REFUND] user=${userId} amount=${amount} reason=${reason}`);
    return hasil.ok;
  } catch (error) {
    console.error('Error refunding balance:', error.message);
    return false;
  }
}

/** Cek saldo cukup TANPA memotong. Dipakai di awal alur instalasi. */
async function hasSufficientBalance(userId, amount) {
  if (isAdmin(userId)) return true;
  return store.cukup(userId, amount);
}

async function getBalance(userId) {
  if (isAdmin(userId)) return 'Unlimited';
  return store.getBalance(userId);
}

/** Saldo dalam bentuk angka (admin pun dapat angka, bukan "Unlimited"). */
async function getBalanceNumeric(userId) {
  return store.getBalance(userId);
}

/* ============ Audit instalasi ============ */

async function recordInstallation(userId, data) {
  try {
    return store.addInstallation(userId, data);
  } catch (error) {
    console.error('Error recording installation:', error.message);
    return null;
  }
}

async function updateInstallation(installationId, status, note = null) {
  try {
    store.updateInstallation(installationId, status, note);
  } catch (error) {
    console.error('Error updating installation:', error.message);
  }
}

module.exports = {
  getUser,
  isAdmin,
  addBalance,
  deductBalance,
  refundBalance,
  hasSufficientBalance,
  getBalance,
  getBalanceNumeric,
  recordInstallation,
  updateInstallation
};
