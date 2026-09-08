const QRCode = require("qrcode");

const pakasir = require("../utils/pakasir");
const { createPaymentMessage } = require("../utils/messageFormatter");
const store = require("../utils/store");

/* ================== HELPER ================== */
function generateUniqueCode() {
  // Prefiks RDP- agar mudah dibedakan dari referensi bot/merchant lain yang
  // memakai project Pakasir yang sama.
  return "RDP-" + Math.random().toString(36).substring(2, 10).toUpperCase();
}

/**
 * Verifikasi & kreditkan sebuah deposit Pakasir.
 *
 * Dipakai dari TIGA tempat sekaligus, semuanya lewat fungsi ini supaya logika
 * (dan pesan sukses) tidak terduplikasi:
 *   1. Webhook/callback Pakasir (di index.js)
 *   2. Tombol "Cek Status Pembayaran" yang ditekan user
 *   3. Pemantau otomatis di latar belakang
 *
 * Selalu memverifikasi ulang ke STATUS API Pakasir sebelum menambah saldo —
 * isi webhook TIDAK pernah dipercaya mentah-mentah. creditDeposit bersifat
 * idempoten (dikunci per order_id), jadi tiga jalur ini tidak akan pernah
 * menambah saldo dua kali untuk satu pembayaran.
 *
 * @returns {Promise<{state:string, amount?:number}>}
 *   state: 'credited' | 'already' | 'unpaid' | 'unknown' | 'error'
 */
async function verifyAndCreditDeposit(bot, ref) {
  if (!ref) return { state: "unknown" };

  const pending = store.getPendingDeposit(ref);
  if (!pending) {
    // Ref tidak ada di daftar tunggu: sudah pernah dikreditkan lalu dibersihkan,
    // atau milik bot/merchant lain di project Pakasir yang sama. Aman diabaikan.
    return { state: "unknown" };
  }

  // Sumber kebenaran: tanyakan langsung ke Pakasir.
  let completed = false;
  try {
    const trx = await pakasir.checkStatus(ref, pending.amount);
    completed = trx && pakasir.isCompletedStatus(trx.status);
  } catch (error) {
    console.error(`[PAKASIR VERIFY] ref=${ref} gagal cek status: ${error.message}`);
    return { state: "error" };
  }

  if (!completed) return { state: "unpaid", amount: pending.amount };

  const hasil = store.creditDeposit(pending.user_id, pending.amount, ref, "deposit");
  store.removePendingDeposit(ref);

  if (hasil.duplikat) return { state: "already", amount: pending.amount };

  if (hasil.ok) {
    bot.sendMessage(
      pending.user_id,
      `✅ *Pembayaran Berhasil!*\n\n` +
        `💰 Saldo bertambah *Rp ${Number(pending.amount).toLocaleString("id-ID")}*\n` +
        `💳 Saldo sekarang *Rp ${Number(hasil.balance).toLocaleString("id-ID")}*\n\n` +
        `Silakan lanjut Install RDP dari menu utama.`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
    return { state: "credited", amount: pending.amount };
  }

  return { state: "error", amount: pending.amount };
}

/**
 * Pemantau pembayaran otomatis (jaring pengaman kalau webhook telat/tidak
 * sampai). Menanyakan status ke Pakasir tiap 20 detik, maksimal 20 menit, lalu
 * berhenti sendiri. Berhenti lebih awal begitu deposit sudah lunas / dibersihkan.
 */
function startPaymentMonitor(bot, ref, amount) {
  const POLL_MS = 20000;
  const MAX_MS = 20 * 60 * 1000;
  const startedAt = Date.now();

  const timer = setInterval(async () => {
    // Sudah tidak menunggu lagi (lunas / kadaluarsa / dibersihkan) → stop.
    if (!store.getPendingDeposit(ref)) {
      clearInterval(timer);
      return;
    }
    if (Date.now() - startedAt > MAX_MS) {
      clearInterval(timer);
      return;
    }
    try {
      const { state } = await verifyAndCreditDeposit(bot, ref);
      if (state === "credited" || state === "already" || state === "unknown") {
        clearInterval(timer);
      }
    } catch (_) {
      // Error sementara diabaikan; siklus berikutnya mencoba lagi.
    }
  }, POLL_MS);

  // Jangan menahan proses Node tetap hidup hanya karena timer ini.
  if (timer.unref) timer.unref();
}

/* ================== STEP 1 ================== */
async function handleDeposit(bot, chatId, messageId) {
  const msg = await bot.editMessageText(
    "💰 *Deposit Saldo*\n\n" +
      "Ketik jumlah deposit yang diinginkan (minimal *Rp 2.000*).\n\n" +
      "Contoh: ketik `10000` untuk deposit Rp 10.000.\n\n" +
      "Setelah itu bot membuat QRIS yang bisa dibayar lewat GoPay, OVO, DANA, " +
      "ShopeePay, atau m-banking apa pun. Saldo masuk otomatis setelah pembayaran diterima.",
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
  const amount = parseInt(msg.text.replace(/\D/g, ""), 10);

  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch {}

  if (!amount || amount < 2000) {
    await bot.editMessageText(
      `❌ Jumlah tidak valid. Ketik nominal deposit berupa angka (minimal Rp 2.000).`,
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
  }).catch(() => {});

  try {
    const reffId = generateUniqueCode();

    const paymentData = await pakasir.createPayment(reffId, amount);
    if (!paymentData?.qr_string) {
      throw new Error("QRIS gagal dibuat");
    }

    // Catat deposit menunggu SECARA PERMANEN sebelum QR ditampilkan. Dengan
    // begitu, saat callback Pakasir masuk (bahkan setelah bot restart), bot tahu
    // saldo siapa yang harus ditambah — dan berapa nominalnya untuk verifikasi.
    store.addPendingDeposit(reffId, chatId, amount);

    const { messageText } = createPaymentMessage(paymentData, amount);

    const qrBuffer = await QRCode.toBuffer(paymentData.qr_string, {
      type: "png",
      width: 500,
    });

    // Tombol "Cek Status" memakai order_id sebagai kunci — nominalnya sudah
    // tersimpan di daftar tunggu, jadi tidak perlu ikut dititipkan di tombol.
    await bot.sendPhoto(chatId, qrBuffer, {
      caption:
        messageText +
        "\n\n_Saldo bertambah otomatis setelah pembayaran diterima. " +
        "Bila sudah bayar tapi saldo belum masuk dalam 1-2 menit, tekan " +
        "tombol *Cek Status Pembayaran* di bawah._",
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Cek Status Pembayaran", callback_data: `paycheck:${reffId}` }],
          [{ text: "🏠 Menu Utama", callback_data: "back_to_menu" }],
        ],
      },
    });

    // Pemantau otomatis sebagai cadangan kalau webhook telat/tidak sampai.
    startPaymentMonitor(bot, reffId, amount);

    return true;
  } catch (error) {
    console.error("Payment Error:", error.message);
    await bot.editMessageText(
      "❌ Gagal membuat pembayaran QRIS.\n\n" +
        "Kemungkinan konfigurasi Pakasir (PAKASIR_PROJECT / PAKASIR_API_KEY) belum benar, " +
        "atau layanan sedang sibuk. Coba lagi beberapa saat.",
      {
        chat_id: chatId,
        message_id: session.messageId,
      }
    ).catch(() => {});
    return true;
  }
}

/* ================== TOMBOL "CEK STATUS" ================== */
async function handleDepositCheck(bot, chatId, ref, query) {
  const answer = (text, alert = false) => {
    if (query && bot.answerCallbackQuery) {
      bot.answerCallbackQuery(query.id, { text, show_alert: alert }).catch(() => {});
    }
  };

  const { state } = await verifyAndCreditDeposit(bot, ref);

  switch (state) {
    case "credited":
      // Pesan sukses lengkap sudah dikirim verifyAndCreditDeposit.
      answer("✅ Pembayaran diterima! Saldo sudah ditambahkan.", true);
      break;
    case "already":
      answer("✅ Pembayaran ini sudah lunas dan saldonya sudah masuk.", true);
      break;
    case "unpaid":
      answer(
        "⌛ Pembayaran belum kami terima. Selesaikan pembayaran QRIS dulu, " +
          "lalu tekan tombol ini lagi.",
        true
      );
      break;
    case "error":
      answer("⚠️ Gagal menghubungi server pembayaran. Coba lagi sebentar.", true);
      break;
    default:
      answer(
        "ℹ️ Transaksi tidak ditemukan / sudah kadaluarsa. Silakan buat deposit baru.",
        true
      );
      break;
  }
}

module.exports = {
  handleDeposit,
  handleDepositAmount,
  handleDepositCheck,
  verifyAndCreditDeposit,
};
