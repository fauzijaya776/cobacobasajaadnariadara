const QRCode = require("qrcode");

const { createPayment, checkPaymentStatus } = require("../utils/dompetx");
const { createPaymentMessage } = require("../utils/messageFormatter");
const BalanceManager = require("./balanceHandler");

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
      `❌ Jumlah tidak valid.\n\nMasukkan jumlah deposit (min Rp 2.000)\n\n_Percobaan ${new Date().toLocaleTimeString("id-ID")}_`,
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

/* ================== MONITOR PAYMENT ================== */
// Melacak deposit yang sedang dipantau supaya satu pembayaran tidak pernah
// dikreditkan dua kali (mis. user menekan Deposit dua kali dengan nominal sama).
const creditedDeposits = new Set();   // sudah berhasil dikreditkan
const sedangKredit = new Set();       // sedang dalam proses dikreditkan
const activeMonitors = new Set();

function monitorPaymentStatus(bot, chatId, amount, depositId, expiredAt) {
  if (activeMonitors.has(depositId)) return;
  activeMonitors.add(depositId);

  let creditFailures = 0;
  let sedangCek = false;
  const expiresAtMs = Date.parse(expiredAt);
  const timeoutMs = Number.isFinite(expiresAtMs) ? Math.max(expiresAtMs - Date.now(), 0) : 15 * 60 * 1000;
  const interval = setInterval(async () => {
    // setInterval tidak menunggu callback sebelumnya selesai, sedangkan satu
    // pengecekan status bisa memakan puluhan detik. Tanpa penjaga ini, beberapa
    // pengecekan menumpuk dan bisa mengkredit pembayaran yang sama berkali-kali.
    if (sedangCek) return;
    sedangCek = true;

    try {
      const statusRes = await checkPaymentStatus(depositId);
      const status = String(statusRes?.status || '').toUpperCase();

      if (["PAID", "SUCCESS", "COMPLETED"].includes(status)) {
        if (creditedDeposits.has(depositId) || sedangKredit.has(depositId)) {
          clearInterval(interval);
          activeMonitors.delete(depositId);
          return;
        }

        // Klaim dipasang SINKRON sebelum await supaya panggilan bersamaan
        // langsung terpental. Pengaman sesungguhnya ada di store: penanda
        // depositId disimpan PERMANEN bersama saldo dalam satu operasi, jadi
        // satu pembayaran tidak mungkin dikreditkan dua kali — bahkan kalau
        // pemantau mengulang atau bot restart di tengah proses.
        sedangKredit.add(depositId);
        let hasilKredit;
        try {
          hasilKredit = await BalanceManager.creditDeposit(chatId, amount, depositId);
        } catch (errKredit) {
          sedangKredit.delete(depositId);
          throw errKredit;
        }

        creditedDeposits.add(depositId);
        sedangKredit.delete(depositId);
        clearInterval(interval);
        activeMonitors.delete(depositId);

        // Kalau ternyata duplikat, jangan kirim notifikasi "berhasil" lagi.
        if (!hasilKredit.duplikat) {
          await bot.sendMessage(
            chatId,
            `✅ *Pembayaran Berhasil!*\n\nSaldo bertambah *Rp ${amount.toLocaleString()}*`,
            { parse_mode: "Markdown" }
          );
        }
      }
    } catch (err) {
      creditFailures++;
      console.error(`Cek/kredit deposit ${depositId} gagal (${creditFailures}x):`, err.message);

      // Kalau pengkreditan gagal berulang kali, jangan diamkan — uang user
      // sudah masuk tapi saldonya belum bertambah.
      if (creditFailures === 5) {
        const adminId = (process.env.ADMIN_ID || "").split(",")[0].trim();
        if (adminId) {
          bot.sendMessage(adminId,
            `⚠️ Deposit butuh perhatian manual\n\n` +
            `User: ${chatId}\nNominal: Rp ${amount.toLocaleString("id-ID")}\n` +
            `Deposit ID: ${depositId}\nError: ${err.message}`
          ).catch(() => {});
        }
      }
    } finally {
      sedangCek = false;
    }
  }, 10000);

  setTimeout(() => {
    clearInterval(interval);
    activeMonitors.delete(depositId);
  }, timeoutMs);
}

module.exports = {
  handleDeposit,
  handleDepositAmount,
};
