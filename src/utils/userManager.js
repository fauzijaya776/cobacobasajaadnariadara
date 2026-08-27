const db = require('../config/database');

async function getUser(userId) {
  try {
    let user = await db.get('SELECT * FROM users WHERE telegram_id = ?', [userId]);

    if (!user) {
      await db.run(
        'INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (?, 0)',
        [userId]
      );
      user = await db.get('SELECT * FROM users WHERE telegram_id = ?', [userId]);
    }

    return user || { telegram_id: userId, balance: 0 };
  } catch (error) {
    console.error('Error getting user:', error);
    throw error;
  }
}

function isAdmin(userId) {
  const adminId = process.env.ADMIN_ID;
  if (!adminId) return false;
  // Dukung beberapa admin, dipisah koma.
  return adminId
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(String(userId));
}

async function addBalance(userId, amount, type = 'deposit') {
  try {
    await getUser(userId);

    await db.run(
      'UPDATE users SET balance = balance + ? WHERE telegram_id = ?',
      [amount, userId]
    );

    try {
      await db.run(
        'INSERT INTO transactions (user_id, amount, type) VALUES (?, ?, ?)',
        [userId, amount, type]
      );
    } catch (logError) {
      console.error(`[BILLING] Gagal mencatat penambahan saldo user ${userId}:`, logError.message);
    }

    return await getBalance(userId);
  } catch (error) {
    console.error('Error adding balance:', error);
    throw error;
  }
}

/**
 * Potong saldo secara ATOMIC.
 *
 * Versi lama membaca saldo lalu meng-UPDATE dalam dua langkah terpisah, sehingga
 * dua klik cepat bisa lolos dua-duanya dan membuat saldo minus. Di sini syarat
 * "saldo cukup" dijadikan bagian dari UPDATE, lalu hasilnya diverifikasi lewat
 * jumlah baris yang berubah.
 */
async function deductBalance(userId, amount) {
  if (isAdmin(userId)) return true;

  try {
    await getUser(userId);

    const result = await db.run(
      'UPDATE users SET balance = balance - ? WHERE telegram_id = ? AND balance >= ?',
      [amount, userId, amount]
    );

    if (!result || result.changes !== 1) {
      return false; // saldo tidak cukup — tidak ada yang terpotong
    }

    // Saldo SUDAH berkurang di titik ini. Pencatatan transaksi tidak boleh
    // melempar keluar: kalau INSERT gagal (mis. SQLITE_BUSY), pemanggil akan
    // menyangka pemotongan gagal dan tidak me-refund, sehingga user kehilangan
    // saldo tanpa jejak. Kegagalan pencatatan cukup dilog.
    try {
      await db.run(
        'INSERT INTO transactions (user_id, amount, type) VALUES (?, ?, ?)',
        [userId, -amount, 'deduct']
      );
    } catch (logError) {
      console.error(
        `[BILLING] Saldo user ${userId} terpotong ${amount} tapi gagal dicatat:`,
        logError.message
      );
    }

    return true;
  } catch (error) {
    console.error('Error deducting balance:', error);
    // Jangan melempar: pemanggil harus bisa membedakan "tidak terpotong"
    // dari "error", dan tidak boleh salah menganggapnya sebagai gagal instalasi.
    return false;
  }
}

/**
 * Kembalikan saldo yang sudah terpotong.
 * Dipakai kalau instalasi gagal SETELAH pemotongan terjadi.
 */
async function refundBalance(userId, amount, reason = 'refund') {
  if (isAdmin(userId)) return true;

  try {
    await db.run(
      'UPDATE users SET balance = balance + ? WHERE telegram_id = ?',
      [amount, userId]
    );
    await db.run(
      'INSERT INTO transactions (user_id, amount, type) VALUES (?, ?, ?)',
      [userId, amount, reason]
    );
    console.log(`[REFUND] user=${userId} amount=${amount} reason=${reason}`);
    return true;
  } catch (error) {
    console.error('Error refunding balance:', error);
    return false;
  }
}

/** Cek saldo cukup TANPA memotong. Dipakai di awal alur instalasi. */
async function hasSufficientBalance(userId, amount) {
  if (isAdmin(userId)) return true;
  const user = await getUser(userId);
  return Number(user.balance || 0) >= amount;
}

async function getBalance(userId) {
  if (isAdmin(userId)) return 'Unlimited';

  try {
    const user = await getUser(userId);
    return Number(user.balance || 0);
  } catch (error) {
    console.error('Error getting balance:', error);
    throw error;
  }
}

/** Saldo dalam bentuk angka (admin tetap dapat angka, bukan "Unlimited"). */
async function getBalanceNumeric(userId) {
  const user = await getUser(userId);
  return Number(user.balance || 0);
}

/* ============ Audit instalasi ============ */

async function recordInstallation(userId, data) {
  try {
    const result = await db.run(
      `INSERT INTO installations (user_id, ip, ssh_port, windows_id, windows_name, cost, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        data.ip,
        data.sshPort,
        data.windowsId,
        data.windowsName,
        data.cost,
        data.status || 'pending'
      ]
    );
    return result.id;
  } catch (error) {
    console.error('Error recording installation:', error);
    return null;
  }
}

async function updateInstallation(installationId, status, note = null) {
  if (!installationId) return;
  try {
    await db.run(
      'UPDATE installations SET status = ?, note = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, note, installationId]
    );
  } catch (error) {
    console.error('Error updating installation:', error);
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
