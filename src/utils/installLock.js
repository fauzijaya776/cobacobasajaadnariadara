/**
 * Kunci instalasi lintas-modul.
 *
 * Dulu daftar "sedang instalasi" hidup sebagai Set privat di dalam rdpHandler.
 * Sekarang ada DUA jalur yang bisa memasang instalasi Windows pada satu user:
 * install satuan (rdpHandler) dan multi-install (multiInstallHandler). Keduanya
 * harus melihat kunci yang SAMA, kalau tidak user bisa menjalankan install
 * satuan dan batch multi bersamaan — dan mendapat beberapa RDP dengan
 * pembayaran yang tidak konsisten.
 *
 * Karena itu kuncinya dipindah ke satu modul bersama. Node hanya punya satu
 * instance modul, jadi rdpHandler dan multiInstallHandler otomatis berbagi Set
 * yang sama.
 */
const active = new Set();

/** Apakah user ini sedang menjalankan instalasi (satuan ATAU batch)? */
function isLocked(chatId) {
  return active.has(chatId);
}

/** Pasang kunci. Panggil TEPAT sebelum instalasi benar-benar dimulai. */
function lock(chatId) {
  active.add(chatId);
}

/** Lepas kunci. Panggil di `finally` setelah instalasi benar-benar selesai. */
function unlock(chatId) {
  active.delete(chatId);
}

module.exports = { isLocked, lock, unlock };
