const fs = require("fs");
const QRCode = require("qrcode");

const { createPayment, checkPaymentStatus } = require("../utils/dompetx");
const { createPaymentMessage } = require("../utils/messageFormatter");
const BalanceManager = require("./balanceHandler");

const filePath = "user_data.json";

/* ================== UTIL JSON ================== */
function readData() {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  return raw ? JSON.parse(raw) : [];
}

function saveData(data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function saveBalanceToJson(chatId, amount) {
  const users = readData();
  const index = users.findIndex(u => u.chat_id === chatId);

  if (index !== -1) {
    users[index].amount += amount;
  } else {
    users.push({ chat_id: chatId, amount });
  }

  saveData(users);
}

/* ================== HELPER ================== */
function generateUniqueCode() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

/* ================== STEP 1 ================== */
async function handleDeposit(bot, chatId, messageId) {
  const msg = await bot.editMessageText(
    "💰 *Deposit Saldo*\n\nMasukkan jumlah deposit:\n_(minimal Rp 2.000)_",
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
      "❌ Jumlah tidak valid.\n\nMasukkan jumlah deposit (min Rp 2.000)",
      {
        chat_id: chatId,
        message_id: session.messageId,
        parse_mode: "Markdown",
      }
    );
    return;
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

    const { messageText, keyboard } = createPaymentMessage(paymentData, amount);

    /* 🔥 BUAT QR BUFFER (AMAN) */
    const qrBuffer = await QRCode.toBuffer(paymentData.qr_string, {
      type: "png",
      width: 500,
    });

    /* 🔥 KIRIM QR LANGSUNG (TANPA URL) */
    await bot.sendPhoto(chatId, qrBuffer, {
      caption: messageText,
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });

    /* 🔥 MONITOR STATUS */
    monitorPaymentStatus(bot, chatId, amount, paymentData.id, paymentData.expired_at);

  } catch (error) {
    console.error("Payment Error:", error.message);
    await bot.editMessageText("❌ Gagal membuat pembayaran. Coba lagi.", {
      chat_id: chatId,
      message_id: session.messageId,
    });
  }
}

/* ================== MONITOR PAYMENT ================== */
function monitorPaymentStatus(bot, chatId, amount, depositId, expiredAt) {
  const expiresAtMs = Date.parse(expiredAt);
  const timeoutMs = Number.isFinite(expiresAtMs) ? Math.max(expiresAtMs - Date.now(), 0) : 15 * 60 * 1000;
  const interval = setInterval(async () => {
    try {
      const statusRes = await checkPaymentStatus(depositId);
      const status = String(statusRes?.status || '').toUpperCase();

      if (["PAID", "SUCCESS", "COMPLETED"].includes(status)) {
        clearInterval(interval);

        await BalanceManager.updateBalance(chatId, amount);
        saveBalanceToJson(chatId, amount);

        await bot.sendMessage(
          chatId,
          `✅ *Pembayaran Berhasil!*\n\nSaldo bertambah *Rp ${amount.toLocaleString()}*`,
          { parse_mode: "Markdown" }
        );
      }
    } catch (err) {
      console.log("Cek status gagal:", err.message);
    }
  }, 10000);

  setTimeout(() => clearInterval(interval), timeoutMs);
}

module.exports = {
  handleDeposit,
  handleDepositAmount,
};
