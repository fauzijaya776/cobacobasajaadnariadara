const { addBalance } = require('../utils/userManager');
const { safeEdit, safeSend } = require('../utils/telegram');

async function handleAddBalance(bot, chatId, messageId) {
  await safeEdit(bot,
    '➕ *Tambah Saldo User*\n\n' +
    'Kirim ID pengguna dan jumlah saldo dalam format:\n\n`<user_id> <jumlah>`\n\n' +
    'Contoh: `123456789 50000`\n\n' +
    '_ID pengguna bisa dilihat user di menu utama bot._',
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '« Batal', callback_data: 'back_to_menu' }]]
      }
    }
  );
}

/**
 * @returns {Promise<boolean>} false kalau formatnya salah (sesi dipertahankan
 *   supaya admin cukup kirim ulang), true kalau selesai diproses.
 */
async function processAddBalance(bot, msg) {
  // Toleran terhadap spasi ganda, titik ribuan, dan "Rp".
  const parts = String(msg.text || '').trim().split(/\s+/);
  if (parts.length !== 2) {
    await safeSend(bot, msg.chat.id,
      '❌ Format tidak valid. Kirim: `<user_id> <jumlah>`\nContoh: `123456789 50000`',
      { parse_mode: 'Markdown' });
    return false;
  }

  const userId = parseInt(parts[0], 10);
  const amount = parseInt(parts[1].replace(/[^\d]/g, ''), 10);

  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(amount) || amount <= 0) {
    await safeSend(bot, msg.chat.id, '❌ ID pengguna atau jumlah tidak valid. Kirim ulang, contoh: `123456789 50000`',
      { parse_mode: 'Markdown' });
    return false;
  }

  try {
    const newBalance = await addBalance(userId, amount, 'admin');
    await safeSend(bot, msg.chat.id,
      `✅ Saldo berhasil ditambahkan\n\n` +
      `👤 User ID: \`${userId}\`\n` +
      `💰 Jumlah: Rp ${amount.toLocaleString('id-ID')}\n` +
      `💳 Saldo baru: Rp ${Number(newBalance).toLocaleString('id-ID')}`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🏠 Menu Utama', callback_data: 'back_to_menu' }]] }
      }
    );
    // Beri tahu user yang saldonya ditambah (abaikan kalau user memblokir bot).
    safeSend(bot, userId,
      `💰 Saldo Anda ditambah admin sebesar Rp ${amount.toLocaleString('id-ID')}.\n` +
      `💳 Saldo sekarang: Rp ${Number(newBalance).toLocaleString('id-ID')}`).catch(() => {});
  } catch (error) {
    console.error('Error adding balance:', error);
    await safeSend(bot, msg.chat.id, '❌ Gagal menambahkan saldo. Coba lagi.');
  }
  return true;
}

module.exports = {
  handleAddBalance,
  processAddBalance
};
