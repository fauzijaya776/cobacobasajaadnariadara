const store = require('../utils/store');

async function broadcastMessage(bot, message, adminChatId) {
  try {
    // Ambil semua telegram_id dari database
    const userIds = store.listUserIds();

    let successCount = 0; // Jumlah pesan yang berhasil dikirim
    let failedCount = 0;  // Jumlah pesan yang gagal dikirim

    console.log(`Mengirim pesan ke ${userIds.length} pengguna...`);

    // Kirim pesan ke setiap pengguna
    for (const userId of userIds) {
      try {
        // Cek apakah bot bisa mengakses chat dengan pengguna
        await bot.getChat(userId);

        // Kirim pesan
        await bot.sendMessage(userId, message, { parse_mode: "Markdown" });
        successCount++;
        console.log(`Pesan berhasil dikirim ke ${userId}`);
      } catch (error) {
        if (error.response?.body?.error_code === 403) {
          console.log(`Pengguna ${userId} memblokir bot atau tidak dapat dijangkau.`);
        } else {
          console.error(`Gagal mengirim pesan ke ${userId}:`, error.message);
        }
        failedCount++;
      }
    }

    console.log('Broadcast selesai!');

    // Kirim laporan ke admin
    const report = `📊 *Laporan Broadcast*\n\n` +
                  `✅ Berhasil dikirim: ${successCount}\n` +
                  `❌ Gagal dikirim: ${failedCount}`;

    await bot.sendMessage(adminChatId, report, { parse_mode: "Markdown" });
  } catch (error) {
    console.error('Error during broadcast:', error);
    throw error;
  }
}

module.exports = broadcastMessage;