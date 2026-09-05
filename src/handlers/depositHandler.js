const QRCode = require("qrcode");

const { createPayment } = require("../utils/qrin");
const { createPaymentMessage } = require("../utils/messageFormatter");
const store = require("../utils/store");

/* ================== HELPER ================== */
function generateUniqueCode() {
  // Prefiks RDP- agar mudah dibedakan dari referensi bot lain yang memakai
  // merchant QRIN yang sama.
  return "RDP-" + Math.random().toString(36).substring(2, 10).toUpperCase();
}

/* ================== STEP 1 ================== */
async function handleDeposit(bot, chatId, messageId) {
  const msg = await bot.editMessageText(
    "💰 *Deposit Saldo*\n\nKetik jumlah deposit (min Rp 2.000):",
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "« Kembali", callback_data: "back_to_menu" }]],
      },
    }
  );

  return { step: "waiting_amount", messageId: msg.message_id };
}

/* ================== STEP 2 ================== */
async function handleDepositAmount(bot, msg, session) {
  const chatId = msg.chat.id;
  const amount = parseInt(msg.text.replace(/\D/g, ""));

  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch {}

  if (!amount || amount < 2000) {
    await bot.editMessageText(
      `❌ Jumlah tidak valid. Ketik nominal deposit (min Rp 2.000).`,
      {
        chat_id: chatId,
        message_id: session.messageId,
        parse_mode: "Markdown",
      }
    ).catch(() => {});
    // false = sesi JANGAN dihapus, user masih diminta mengirim nominal lagi.
    return false;
  }

  await bot.editMessageText("🔄 Membuat QRIS pembayaran...", {
    chat_id: chatId,
    message_id: session.messageId,
  });

  try {
    const reffId = generateUniqueCode();

    const paymentData = await createPayment(reffId, amount);
    if (!paymentData?.qr_string) {
      throw new Error("QRIS gagal dibuat");
    }

    // Catat deposit menunggu SECARA PERMANEN sebelum QR ditampilkan. Dengan
    // begitu, saat callback QRIN masuk (bahkan setelah bot restart), bot tahu
    // saldo siapa yang harus ditambah.
    store.addPendingDeposit(reffId, chatId, amount);

    const { messageText, keyboard } = createPaymentMessage(paymentData, amount);

    const qrBuffer = await QRCode.toBuffer(paymentData.qr_string, {
      type: "png",
      width: 500,
    });

    await bot.sendPhoto(chatId, qrBuffer, {
      caption:
        messageText +
        "\n\n_Saldo bertambah otomatis setelah pembayaran diterima._",
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });

    return true;
  } catch (error) {
    console.error("Payment Error:", error.message);
    await bot.editMessageText("❌ Gagal membuat pembayaran. Coba lagi.", {
      chat_id: chatId,
      message_id: session.messageId,
    }).catch(() => {});
    return true;
  }
}

module.exports = {
  handleDeposit,
  handleDepositAmount,
};
