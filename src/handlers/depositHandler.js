const fs = require("fs");
const QRCode = require("qrcode");

const { createPayment, checkPaymentStatus, confirmInstantDeposit } = require("../utils/atl");
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
    const apiKey = "15xyWfE4x76sm4Q1yIfadFg7wvQwlyNna8sL8nM77UuUNXJsDpK283ISQqEMRb1C5ArKyoQ16qSXz4LgeJC8iTnhU1kRY3wcIjiy";
    const reffId = generateUniqueCode();

    const paymentRes = await createPayment(apiKey, reffId, amount);
    if (!paymentRes?.status || !paymentRes?.data?.qr_string) {
      throw new Error("QRIS gagal dibuat");
    }

    const paymentData = paymentRes.data;
    const { messageText, keyboard } = createPaymentMessage(paymentData, amount, 0);

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
    monitorPaymentStatus(bot, chatId, amount, paymentData.id, apiKey);

  } catch (error) {
    console.error("Payment Error:", error.message);
    await bot.editMessageText("❌ Gagal membuat pembayaran. Coba lagi.", {
      chat_id: chatId,
      message_id: session.messageId,
    });
  }
}

/* ================== MONITOR PAYMENT ================== */
function monitorPaymentStatus(bot, chatId, amount, depositId, apiKey) {
  const interval = setInterval(async () => {
    try {
      const statusRes = await checkPaymentStatus(apiKey, depositId);
      const status = statusRes?.data?.status;

      if (status === "success" || status === "processing") {
        clearInterval(interval);

        try {
          await confirmInstantDeposit(apiKey, depositId);
        } catch {}

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
  }, 60000);
}

module.exports = {
  handleDeposit,
  handleDepositAmount,
};
