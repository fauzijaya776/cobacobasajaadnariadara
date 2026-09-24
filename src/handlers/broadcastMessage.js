const store = require('../utils/store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isParseError(error) {
  const desc = error?.response?.body?.description || error?.message || '';
  return /can't parse entities|can't find end/i.test(desc);
}

/**
 * Kirim pesan admin ke semua user.
 *
 * Perbaikan:
 *  - Pesan dengan karakter Markdown tak berpasangan (mis. "_" di username)
 *    dulu GAGAL ke semua user. Sekarang otomatis dikirim ulang tanpa format.
 *  - Jeda 60 ms antar pesan agar tidak melewati batas Telegram (~30 pesan/detik).
 *  - Tidak lagi memanggil getChat per user (setengah jumlah panggilan API).
 */
async function broadcastMessage(bot, message, adminChatId) {
  const userIds = store.listUserIds().filter((id) => Number(id) > 0);
  let successCount = 0;
  let failedCount = 0;
  let blockedCount = 0;
  // Sekali Telegram menolak format Markdown-nya, sisa pesan langsung dikirim
  // tanpa format (hemat 1 panggilan API per user).
  let plain = false;

  console.log(`Mengirim broadcast ke ${userIds.length} pengguna...`);

  for (const userId of userIds) {
    try {
      if (plain) {
        await bot.sendMessage(userId, message);
      } else {
        try {
          await bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
        } catch (error) {
          if (!isParseError(error)) throw error;
          plain = true;
          await bot.sendMessage(userId, message);
        }
      }
      successCount++;
    } catch (error) {
      const code = error?.response?.body?.error_code;
      if (code === 403) blockedCount++;
      else console.error(`Gagal broadcast ke ${userId}:`, error.message);
      failedCount++;
      // Kena rate limit → tunggu sesuai saran Telegram lalu lanjut.
      const retry = error?.response?.body?.parameters?.retry_after;
      if (retry) await sleep((Number(retry) + 1) * 1000);
    }
    await sleep(60);
  }

  const report =
    `📊 *Laporan Broadcast*\n\n` +
    `👥 Target: ${userIds.length}\n` +
    `✅ Berhasil: ${successCount}\n` +
    `❌ Gagal: ${failedCount}` +
    (blockedCount ? ` (${blockedCount} memblokir bot)` : '');

  try {
    await bot.sendMessage(adminChatId, report, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Gagal mengirim laporan broadcast:', error.message);
  }
}

module.exports = broadcastMessage;
