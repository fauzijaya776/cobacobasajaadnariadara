const QRCode = require("qrcode");

const pakasir = require("../utils/pakasir");
const { createPaymentMessage } = require("../utils/messageFormatter");
const store = require("../utils/store");
const { maintenanceFor } = require("../utils/settings");

/* ================== HELPER ================== */
function generateUniqueCode() {
  // Prefiks RDP- agar mudah dibedakan dari referensi bot/merchant lain yang
  // memakai project Pakasir yang sama.
  return "RDP-" + Math.random().toString(36).substring(2, 10).toUpperCase();
}

/**
 * Cache status per txn_id supaya tidak melanggar batas Pakasir v2
 * (1 permintaan status / 4 detik / transaksi). Webhook, pemantau otomatis, dan
 * tombol "Cek Status" bisa datang berdekatan; ini mencegah error 429.
 */
const statusCache = new Map(); // txn_id -> { at, result }

async function getStatus(pending) {
  // Deposit lama (sebelum migrasi v2) tidak punya txn_id → pakai endpoint v1.
  if (!pending.txn_id) {
    return pakasir.checkStatusLegacy(pending.ref, pending.amount);
  }
  const key = pending.txn_id;
  const cached = statusCache.get(key);
  if (cached && Date.now() - cached.at < pakasir.STATUS_GAP_MS) {
    return cached.result; // masih segar, jangan panggil Pakasir lagi
  }
  const result = await pakasir.checkStatusByTxn(key);
  statusCache.set(key, { at: Date.now(), result });
  // Jaga cache tetap kecil.
  if (statusCache.size > 500) {
    for (const k of statusCache.keys()) { statusCache.delete(k); if (statusCache.size <= 400) break; }
  }
  return result;
}

/** Nominal yang sah untuk dicocokkan dengan "amount" dari Pakasir. */
function amountMatches(pending, trxAmount) {
  if (trxAmount == null) return true; // Pakasir tidak menyertakan amount → percaya status
  const a = Number(trxAmount);
  return a === Number(pending.gateway_amount) ||
         a === Number(pending.amount) ||
         a === Number(pending.total_payment);
}

/**
 * Verifikasi & kreditkan sebuah deposit Pakasir (v2).
 *
 * Dipakai dari TIGA tempat: webhook Pakasir, tombol "Cek Status", dan pemantau
 * otomatis. Selalu memverifikasi ke STATUS API Pakasir sebelum menambah saldo —
 * isi webhook tidak pernah dipercaya mentah. creditDeposit idempoten (dikunci
 * per order_id), jadi ketiga jalur ini tidak akan menambah saldo dua kali.
 *
 * @returns {Promise<{state:string, amount?:number}>}
 *   state: 'credited' | 'already' | 'unpaid' | 'expired' | 'unknown' | 'error'
 */
async function verifyAndCreditDeposit(bot, ref) {
  if (!ref) return { state: "unknown" };

  const pending = store.getPendingDeposit(ref);
  if (!pending) {
    // Sudah pernah dikreditkan lalu dibersihkan, atau milik bot lain di project
    // Pakasir yang sama. Aman diabaikan.
    return { state: "unknown" };
  }
  pending.ref = ref;

  // Sumber kebenaran: tanyakan langsung ke Pakasir.
  let trx = null;
  try {
    trx = await getStatus(pending);
  } catch (error) {
    console.error(`[PAKASIR VERIFY] ref=${ref} gagal cek status: ${error.message}`);
    return { state: "error", amount: pending.amount };
  }

  const status = trx && trx.status;
  if (status === "canceled") {
    // Gugur di Pakasir (dibatalkan di dasbor / lewat 24 jam). Berhenti menunggu.
    store.removePendingDeposit(ref);
    return { state: "expired", amount: pending.amount };
  }
  if (status !== "completed") return { state: "unpaid", amount: pending.amount };

  if (!amountMatches(pending, trx.amount)) {
    console.error(`[PAKASIR VERIFY] ref=${ref} nominal Pakasir (${trx.amount}) tidak cocok.`);
    return { state: "error", amount: pending.amount };
  }

  // Saldo yang dikreditkan = yang benar-benar dibayar buyer (mode biaya penjual)
  // atau nominal deposit (mode biaya pembeli). Tersimpan di pending.credit.
  const kredit = pending.credit != null ? Number(pending.credit) : Number(pending.amount);
  const qrMsgId = pending.msg_id;

  const hasil = store.creditDeposit(pending.user_id, kredit, ref, "deposit");
  store.removePendingDeposit(ref);

  if (qrMsgId) bot.deleteMessage(pending.user_id, qrMsgId).catch(() => {});

  if (hasil.duplikat) return { state: "already", amount: kredit };

  // ID negatif = akun website tanpa Telegram; tidak ada chat untuk dikabari.
  if (hasil.ok && Number(pending.user_id) > 0) {
    bot.sendMessage(
      pending.user_id,
      `✅ *Pembayaran Berhasil!*\n\n` +
        `💰 Saldo bertambah *Rp ${Number(kredit).toLocaleString("id-ID")}*\n` +
        `💳 Saldo sekarang *Rp ${Number(hasil.balance).toLocaleString("id-ID")}*\n\n` +
        `Silakan lanjut Install RDP dari menu utama.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🖥️ Install RDP", callback_data: "install_rdp" }],
            [{ text: "🏠 Menu Utama", callback_data: "back_to_menu" }],
          ],
        },
      }
    ).catch(() => {});
  }
  if (hasil.ok) return { state: "credited", amount: kredit };

  return { state: "error", amount: kredit };
}

/**
 * Pemantau pembayaran otomatis (jaring pengaman). Menanyakan status ke Pakasir
 * tiap 20 detik (aman dari batas 4 detik), maksimal 20 menit, lalu berhenti.
 */
function startPaymentMonitor(bot, ref) {
  const POLL_MS = 20000;
  const MAX_MS = 20 * 60 * 1000;
  const startedAt = Date.now();

  const timer = setInterval(async () => {
    if (!store.getPendingDeposit(ref)) { clearInterval(timer); return; }
    if (Date.now() - startedAt > MAX_MS) { clearInterval(timer); return; }
    try {
      const { state } = await verifyAndCreditDeposit(bot, ref);
      if (state === "credited" || state === "already" || state === "expired" || state === "unknown") {
        clearInterval(timer);
      }
    } catch (_) { /* siklus berikutnya mencoba lagi */ }
  }, POLL_MS);

  if (timer.unref) timer.unref();
}

/* ================== STEP 1 ================== */
const MIN_DEPOSIT = 2000;
const MAX_DEPOSIT = 10000000; // batas QRIS Pakasir

async function handleDeposit(bot, chatId, messageId) {
  const text =
    "💰 *Deposit Saldo*\n\n" +
    `Ketik jumlah deposit yang diinginkan (minimal *Rp ${MIN_DEPOSIT.toLocaleString("id-ID")}*).\n\n` +
    "Contoh: ketik `10000` untuk deposit Rp 10.000.\n\n" +
    "Bot akan membuat QRIS yang bisa dibayar lewat GoPay, OVO, DANA, ShopeePay, " +
    "atau m-banking apa pun. Bayar *persis sesuai nominal* (tanpa biaya tambahan), " +
    "saldo masuk otomatis.";
  const options = {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[{ text: "« Kembali", callback_data: "back_to_menu" }]],
    },
  };

  // Edit pesan yang ada; kalau tidak bisa (pesan foto, terlalu lama, sudah
  // dihapus), kirim pesan baru — dulu error di sini membuat tombol Deposit
  // hanya memunculkan "Terjadi kesalahan".
  try {
    const msg = await bot.editMessageText(text, options);
    if (msg && msg.message_id) return { step: "waiting_amount", messageId: msg.message_id };
    return { step: "waiting_amount", messageId };
  } catch (error) {
    const desc = error?.response?.body?.description || error?.message || "";
    if (/message is not modified/i.test(desc)) return { step: "waiting_amount", messageId };
    const { chat_id, message_id, ...rest } = options;
    const sent = await bot.sendMessage(chatId, text, rest);
    return { step: "waiting_amount", messageId: sent.message_id };
  }
}

/* ================== STEP 2 ================== */
async function handleDepositAmount(bot, msg, session) {
  const chatId = msg.chat.id;
  const amount = parseInt(msg.text.replace(/\D/g, ""), 10);

  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch {}

  if (!amount || amount < MIN_DEPOSIT || amount > MAX_DEPOSIT) {
    await bot.editMessageText(
      `❌ Jumlah tidak valid. Ketik nominal deposit berupa angka ` +
        `(Rp ${MIN_DEPOSIT.toLocaleString("id-ID")} – Rp ${MAX_DEPOSIT.toLocaleString("id-ID")}).`,
      {
        chat_id: chatId,
        message_id: session.messageId,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "« Kembali", callback_data: "back_to_menu" }]] },
      }
    ).catch(() => {});
    return false; // sesi JANGAN dihapus, user diminta kirim nominal lagi
  }

  await bot.editMessageText("🔄 Membuat QRIS pembayaran...", {
    chat_id: chatId,
    message_id: session.messageId,
  }).catch(() => {});

  try {
    const mt = maintenanceFor(chatId);
    if (mt) {
      await bot.editMessageText(`🛠️ Sedang maintenance

${mt}`, {
        chat_id: chatId, message_id: session.messageId,
        reply_markup: { inline_keyboard: [[{ text: '« Menu', callback_data: 'back_to_menu' }]] }
      }).catch(() => {});
      return true;
    }
    const reffId = generateUniqueCode();

    const paymentData = await pakasir.createPayment(reffId, amount);
    if (!paymentData?.qr_string) throw new Error("QRIS gagal dibuat");

    // Catat deposit menunggu SECARA PERMANEN sebelum QR ditampilkan, lengkap
    // dengan txn_id (wajib untuk cek status v2) dan nominal yang akan dikredit.
    store.addPendingDeposit(reffId, chatId, amount, {
      txn_id: paymentData.txnId,
      credit: paymentData.amount,
      gateway_amount: paymentData.gatewayAmount,
      total_payment: paymentData.totalBayar,
      fee_payer: paymentData.feePayer,
      expired_at: paymentData.expired_at,
    });

    const { messageText } = createPaymentMessage(paymentData, amount);
    const catatanBiaya =
      paymentData.feePayer === "merchant"
        ? "\n\n_Biaya QRIS ditanggung penjual — kamu membayar persis sesuai nominal._"
        : "";
    const catatanSandbox = paymentData.isSandbox
      ? "\n\n⚠️ _Mode sandbox — bukan pembayaran sungguhan._"
      : "";

    const qrBuffer = await QRCode.toBuffer(paymentData.qr_string, {
      type: "png",
      width: 500,
    });

    const qrMsg = await bot.sendPhoto(chatId, qrBuffer, {
      caption:
        messageText +
        catatanBiaya +
        catatanSandbox +
        "\n\n_Saldo bertambah otomatis setelah pembayaran diterima. Pesan QR ini " +
        "akan hilang sendiri begitu pembayaran masuk. Bila sudah bayar tapi saldo " +
        "belum masuk dalam 1-2 menit, tekan tombol *Cek Status Pembayaran* di bawah._",
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Cek Status Pembayaran", callback_data: `paycheck:${reffId}` }],
          [{ text: "🏠 Menu Utama", callback_data: "back_to_menu" }],
        ],
      },
    });

    if (qrMsg && qrMsg.message_id) {
      store.attachPendingMessage(reffId, qrMsg.message_id);
    }

    startPaymentMonitor(bot, reffId);

    return true;
  } catch (error) {
    console.error("Payment Error:", error.message);
    // Pesan validasi nominal (mis. terlalu kecil untuk QRIS) ditampilkan apa adanya.
    const ramah = /QRIS|Nominal|minimal|maksimal/i.test(error.message)
      ? error.message
      : "Kemungkinan konfigurasi Pakasir (PAKASIR_PROJECT / PAKASIR_API_KEY) belum benar, " +
        "atau layanan sedang sibuk. Coba lagi beberapa saat.";
    await bot.editMessageText(
      "❌ Gagal membuat pembayaran QRIS.\n\n" + ramah,
      { chat_id: chatId, message_id: session.messageId }
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
      answer("✅ Pembayaran diterima! Saldo sudah ditambahkan.", true);
      break;
    case "already":
      answer("✅ Pembayaran ini sudah lunas dan saldonya sudah masuk.", true);
      break;
    case "unpaid":
      answer(
        "⌛ Pembayaran belum kami terima. Selesaikan pembayaran QRIS dulu, " +
          "lalu tekan tombol ini lagi (beri jeda beberapa detik).",
        true
      );
      break;
    case "expired":
      answer("⏰ Tagihan ini sudah kadaluarsa. Silakan buat deposit baru.", true);
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
  startPaymentMonitor,
  generateUniqueCode,
  MIN_DEPOSIT,
  MAX_DEPOSIT,
};
