/**
 * Pembungkus aman untuk pengiriman/penyuntingan pesan Telegram.
 *
 * Dua sumber kegagalan paling sering di bot ini:
 *  1. "message is not modified" — terjadi kalau teks baru identik dengan teks lama
 *     (mis. user salah ketik IP dua kali berturut-turut). Telegram membalas 400 dan
 *     melempar exception, yang lalu muncul ke user sebagai "Terjadi kesalahan".
 *  2. "can't parse entities" — data dinamis (pesan error, nama versi) mengandung
 *     karakter Markdown yang tidak berpasangan, sehingga seluruh pesan ditolak.
 *
 * Semua helper di sini menelan kasus (1) dan otomatis mencoba ulang tanpa
 * parse_mode untuk kasus (2).
 */

/** Escape karakter yang bermakna khusus di Markdown (legacy) Telegram. */
function escapeMd(text) {
  return String(text == null ? '' : text).replace(/([_*`\[\]])/g, '\\$1');
}

// Di Markdown lama Telegram, backslash TIDAK diproses di dalam entitas
// (`code`, *bold*, _italic_) — "\_" akan tampil apa adanya. Jadi isi entitas
// cukup dibersihkan dari karakter penutup entitas itu sendiri.
// Penting untuk password: escapeMd di dalam backtick dulu membuat password
// yang mengandung _ atau * tampil dengan backslash (salah salin).
function mdCode(text) {
  return String(text == null ? '' : text).replace(/`/g, "'");
}
function mdBold(text) {
  return String(text == null ? '' : text).replace(/\*/g, '');
}
function mdItalic(text) {
  return String(text == null ? '' : text).replace(/_/g, ' ');
}

function isNotModified(error) {
  const desc = error?.response?.body?.description || error?.message || '';
  return /message is not modified/i.test(desc);
}

function isParseError(error) {
  const desc = error?.response?.body?.description || error?.message || '';
  return /can't parse entities|can't find end|unsupported start tag/i.test(desc);
}

/**
 * Pesan tidak bisa di-edit menjadi teks → kirim pesan baru saja.
 *
 * Termasuk "there is no text in the message to edit": terjadi kalau tombol
 * ditekan dari pesan FOTO (mis. tombol "Menu Utama" di bawah gambar QRIS).
 * Dulu kasus ini hanya tercatat di log dan user melihat tombolnya tidak
 * bereaksi sama sekali.
 */
function isGone(error) {
  const desc = error?.response?.body?.description || error?.message || '';
  return /message to edit not found|message can't be edited|MESSAGE_ID_INVALID|no text in the message to edit/i.test(desc);
}

/**
 * Edit pesan dengan penanganan error yang lengkap.
 * @returns {Promise<boolean>} true kalau pesan berhasil diubah atau memang sudah sama.
 */
async function safeEdit(bot, text, options = {}) {
  try {
    await bot.editMessageText(text, options);
    return true;
  } catch (error) {
    if (isNotModified(error)) {
      // Teks sudah sama persis — bukan kegagalan.
      return true;
    }

    if (isParseError(error) && options.parse_mode) {
      // Coba ulang tanpa format supaya isi pesan tetap sampai ke user.
      try {
        const { parse_mode, ...rest } = options;
        await bot.editMessageText(text, rest);
        return true;
      } catch (retryError) {
        if (isNotModified(retryError)) return true;
        console.error('safeEdit retry gagal:', retryError.message);
        return false;
      }
    }

    if (isGone(error)) {
      // Pesan aslinya sudah dihapus user — kirim pesan baru sebagai gantinya.
      try {
        const { chat_id, message_id, ...rest } = options;
        await bot.sendMessage(chat_id, text, rest);
        return true;
      } catch (sendError) {
        console.error('safeEdit fallback sendMessage gagal:', sendError.message);
        return false;
      }
    }

    console.error('safeEdit gagal:', error.message);
    return false;
  }
}

/** Kirim pesan dengan fallback tanpa parse_mode. */
async function safeSend(bot, chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (error) {
    if (isParseError(error) && options.parse_mode) {
      try {
        const { parse_mode, ...rest } = options;
        return await bot.sendMessage(chatId, text, rest);
      } catch (retryError) {
        console.error('safeSend retry gagal:', retryError.message);
        return null;
      }
    }
    console.error('safeSend gagal:', error.message);
    return null;
  }
}

/** Jawab callback query tanpa pernah melempar (query kedaluwarsa itu normal). */
async function safeAnswer(bot, queryId, options = {}) {
  try {
    await bot.answerCallbackQuery(queryId, options);
  } catch (_) {
    // Callback query hanya valid ~15 detik. Kedaluwarsa bukan masalah.
  }
}

/** Hapus pesan tanpa pernah melempar. */
async function safeDelete(bot, chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  escapeMd,
  mdCode,
  mdBold,
  mdItalic,
  safeEdit,
  safeSend,
  safeAnswer,
  safeDelete,
  isNotModified,
  isParseError
};
