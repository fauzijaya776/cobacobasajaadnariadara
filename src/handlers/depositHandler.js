const QRCode = require("qrcode");

const gateway = require("../utils/gateway");
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
 * Cache status per txn_id supaya tidak membanjiri gateway (Pakasir v2: maks.
 * 1 cek / 4 detik / transaksi; AutoGoPay sudah memantau sendiri, cukup 8 detik).
 * Webhook, pemantau otomatis, website, dan tombol "Cek Status" bisa datang
 * berdekatan; ini mencegah error 429.
 */
const statusCache = new Map(); // txn_id -> { at, result }

async function getStatus(pending) {
  // Deposit Pakasir lama (sebelum migrasi v2) tidak punya txn_id → endpoint v1.
  if (!pending.txn_id) return gateway.checkStatus(pending);
  const key = pending.txn_id;
  const gap = gateway.gatewayOf(pending) === "autogopay" ? 8000 : 4000;
  const cached = statusCache.get(key);
  if (cached && Date.now() - cached.at < gap) {
    return cached.result; // masih segar, jangan panggil gateway lagi
  }
  const result = await gateway.checkStatus(pending);
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
    console.error(`[DEPOSIT VERIFY] ref=${ref} gagal cek status: ${error.message}`);
    return { state: "error", amount: pending.amount };
  }

  const status = trx && trx.status;
  if (status === "canceled") {
    // Gugur di gateway (dibatalkan / kedaluwarsa). Berhenti menunggu.
    store.removePendingDeposit(ref);
    gateway.mark(ref, "ended");
    return { state: "expired", amount: pending.amount };
  }
  if (status !== "completed") return { state: "unpaid", amount: pending.amount };

  if (!amountMatches(pending, trx.amount)) {
    console.error(`[DEPOSIT VERIFY] ref=${ref} nominal Pakasir (${trx.amount}) tidak cocok.`);
    return { state: "error", amount: pending.amount };
  }

  // Saldo yang dikreditkan = yang benar-benar dibayar buyer (mode biaya penjual)
  // atau nominal deposit (mode biaya pembeli). Tersimpan di pending.credit.
  const kredit = pending.credit != null ? Number(pending.credit) : Number(pending.amount);
  const qrMsgId = pending.msg_id;

  const hasil = store.creditDeposit(pending.user_id, kredit, ref, "deposit");
  store.removePendingDeposit(ref);
  gateway.mark(ref, "paid");

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
 * Pemantau pembayaran otomatis (jaring pengaman). Menanyakan status ke gateway
 * tiap 20 detik, maksimal 20 menit, lalu berhenti.
 */
const monitored = new Set();
function startPaymentMonitor(bot, ref) {
  if (monitored.has(ref)) return; // satu pemantau per deposit
  monitored.add(ref);
  const POLL_MS = 20000;
  const MAX_MS = 20 * 60 * 1000;
  const startedAt = Date.now();

  const timer = setInterval(async () => {
    const stop = () => { clearInterval(timer); monitored.delete(ref); };
    if (!store.getPendingDeposit(ref)) { stop(); return; }
    if (Date.now() - startedAt > MAX_MS) { stop(); return; }
    try {
      const { state } = await verifyAndCreditDeposit(bot, ref);
      if (state === "credited" || state === "already" || state === "expired" || state === "unknown") {
        stop();
      }
    } catch (_) { /* siklus berikutnya mencoba lagi */ }
  }, POLL_MS);

  if (timer.unref) timer.unref();
}

/**
 * Setelah server restart, pemantau di memori hilang. Jalankan lagi untuk semua
 * deposit yang masih menunggu (maks. 25 jam) supaya saldo tetap masuk walau
 * pembeli menutup halaman / tidak menekan "Cek Status".
 */
function resumePaymentMonitors(bot) {
  const all = (store.data && store.data.pendingDeposits) || {};
  let n = 0;
  for (const [ref, p] of Object.entries(all)) {
    if (Date.now() - new Date(p.at).getTime() > 25 * 3600e3) continue;
    startPaymentMonitor(bot, ref);
    n++;
  }
  if (n) console.log(`[DEPOSIT] ${n} pemantau pembayaran dilanjutkan setelah restart.`);
  return n;
}

/* ================== BUAT DEPOSIT (dipakai bot & website) ================== */
let lastBrakeAlert = 0;
function alertBrake(bot) {
  if (Date.now() - lastBrakeAlert < 10 * 60000) return;
  lastBrakeAlert = Date.now();
  const admins = String(process.env.ADMIN_ID || "").split(",").map((x) => x.trim()).filter(Boolean);
  for (const id of admins) {
    bot.sendMessage(id, "🚨 REM DARURAT QRIS AKTIF\nPembuatan QRIS per menit melewati batas (kemungkinan serangan bot). " +
      "Deposit ditolak sementara. Set DEPOSIT_ENABLED=0 di Render untuk menutup deposit.").catch(() => {});
  }
}

/**
 * Aturan anti-blokir + buat QRIS. SATU kali panggil ke gateway, tanpa retry.
 * @returns {Promise<{ref, pending, reused:boolean}>}  pending = data deposit tersimpan
 * @throws  Error dengan .status (HTTP) dan pesan yang aman ditampilkan ke user.
 */
async function startDeposit(bot, userId, amount) {
  const g = gateway.guardNewQris(userId);
  if (g.reuse) return { ref: g.reuse.ref, pending: g.reuse.p, reused: true };
  if (g.error) {
    if (g.brake) alertBrake(bot);
    throw Object.assign(new Error(g.error), { status: g.status, userMessage: true });
  }
  const ref = generateUniqueCode();
  gateway.record(userId, ref); // dihitung walau gagal: klik ulang tidak memicu generate beruntun
  let p;
  try {
    p = await gateway.createPayment(ref, amount);
    if (!p || !p.qr_string) throw new Error("QRIS gagal dibuat");
  } catch (error) {
    gateway.mark(ref, "ended");
    throw error;
  }
  // Catat deposit menunggu SECARA PERMANEN sebelum QR ditampilkan, lengkap
  // dengan txn_id (wajib untuk cek status) dan nominal yang akan dikredit.
  store.addPendingDeposit(ref, userId, amount, {
    txn_id: p.txnId, credit: p.amount, gateway_amount: p.gatewayAmount,
    total_payment: p.totalBayar, fee_payer: p.feePayer, expired_at: p.expired_at,
    gateway: p.gateway, qr_string: p.qr_string, checkout_url: p.checkoutUrl || null,
  });
  startPaymentMonitor(bot, ref);
  return { ref, pending: store.getPendingDeposit(ref), reused: false, sandbox: p.isSandbox };
}

/**
 * Pembeli membatalkan. Cek dulu (mungkin sudah dibayar), lalu batalkan di
 * AutoGoPay. QRIS Pakasir tidak bisa dibatalkan (tetap bisa dibayar sampai
 * gugur), jadi deposit Pakasir TETAP dipantau supaya saldo tidak hilang.
 * @returns {Promise<{state:string}>} credited | already | canceled | kept | unknown
 */
async function cancelDeposit(bot, ref, userId) {
  const pending = store.getPendingDeposit(ref);
  if (!pending || Number(pending.user_id) !== Number(userId)) return { state: "unknown" };
  const r = await verifyAndCreditDeposit(bot, ref);
  if (r.state === "credited" || r.state === "already") return r;
  if (r.state === "expired") return { state: "canceled" };
  if (gateway.gatewayOf(pending) === "autogopay" && await gateway.cancel(pending)) {
    if (pending.msg_id) bot.deleteMessage(pending.user_id, pending.msg_id).catch(() => {});
    store.removePendingDeposit(ref);
    gateway.mark(ref, "ended");
    return { state: "canceled" };
  }
  return { state: "kept" };
}

/* ================== STEP 1 ================== */
const MIN_DEPOSIT = 2000;
const MAX_DEPOSIT = 10000000; // batas QRIS

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
    let dep;
    try {
      dep = await startDeposit(bot, chatId, amount);
    } catch (error) {
      if (!error.userMessage) throw error;
      await bot.editMessageText(`⚠️ ${error.message}`, {
        chat_id: chatId, message_id: session.messageId,
        reply_markup: { inline_keyboard: [[{ text: "« Menu", callback_data: "back_to_menu" }]] },
      }).catch(() => {});
      return true;
    }
    const { ref, pending, reused } = dep;
    const total = Number(pending.total_payment || pending.credit || pending.amount);
    const { messageText } = createPaymentMessage({ totalBayar: total }, Number(pending.amount));
    const catatanBiaya =
      pending.fee_payer === "merchant" || pending.fee_payer === "none"
        ? "\n\n_Tanpa biaya tambahan — kamu membayar persis sesuai nominal._"
        : "";
    const catatanSandbox = dep.sandbox ? "\n\n⚠️ _Mode sandbox — bukan pembayaran sungguhan._" : "";
    const catatanUlang = reused
      ? "⚠️ *Kamu masih punya QRIS yang belum dibayar.* Bayar yang ini, atau tekan ❌ Batal untuk ganti nominal.\n\n"
      : "";

    const qrBuffer = await QRCode.toBuffer(pending.qr_string, { type: "png", width: 500 });
    const keyboard = [
      [{ text: "🔄 Cek Status Pembayaran", callback_data: `paycheck:${ref}` }],
      [{ text: "❌ Batal", callback_data: `paycancel:${ref}` }, { text: "🏠 Menu Utama", callback_data: "back_to_menu" }],
    ];
    if (pending.checkout_url) keyboard.push([{ text: "🌐 Bayar via Browser", url: pending.checkout_url }]);

    // QR lama (kalau ditampilkan ulang) dihapus supaya hanya ada satu di chat.
    if (reused && pending.msg_id) bot.deleteMessage(chatId, pending.msg_id).catch(() => {});
    bot.deleteMessage(chatId, session.messageId).catch(() => {});
    const qrMsg = await bot.sendPhoto(chatId, qrBuffer, {
      caption:
        catatanUlang +
        messageText +
        catatanBiaya +
        catatanSandbox +
        "\n\n_Saldo bertambah otomatis setelah pembayaran diterima. Pesan QR ini " +
        "akan hilang sendiri begitu pembayaran masuk. Bila sudah bayar tapi saldo " +
        "belum masuk dalam 1-2 menit, tekan tombol *Cek Status Pembayaran* di bawah._",
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });

    if (qrMsg && qrMsg.message_id) {
      store.attachPendingMessage(ref, qrMsg.message_id);
    }

    return true;
  } catch (error) {
    console.error("Payment Error:", error.message);
    // Pesan validasi nominal (mis. terlalu kecil untuk QRIS) ditampilkan apa adanya.
    const ramah = /QRIS|Nominal|minimal|maksimal/i.test(error.message) && !/gagal \(/i.test(error.message)
      ? error.message
      : "Server pembayaran sedang sibuk atau konfigurasi gateway belum benar. Coba lagi beberapa menit lagi.";
    await bot.editMessageText(
      "❌ Gagal membuat pembayaran QRIS.\n\n" + ramah,
      { chat_id: chatId, message_id: session.messageId }
    ).catch(() => {});
    return true;
  }
}

/* ================== TOMBOL "BATAL" ================== */
async function handleDepositCancel(bot, chatId, ref, query) {
  const answer = (text) => {
    if (query && bot.answerCallbackQuery) bot.answerCallbackQuery(query.id, { text, show_alert: true }).catch(() => {});
  };
  const r = await cancelDeposit(bot, ref, chatId);
  const text = {
    credited: "✅ Ternyata sudah dibayar — saldo sudah ditambahkan.",
    already: "✅ Pembayaran ini sudah lunas dan saldonya sudah masuk.",
    canceled: "❌ Tagihan dibatalkan. Kamu bisa membuat deposit baru setelah jeda singkat.",
    kept: "ℹ️ QRIS ini tidak bisa dibatalkan di server pembayaran dan akan gugur sendiri. Kalau terlanjur dibayar, saldo tetap masuk otomatis.",
    unknown: "ℹ️ Tagihan sudah tidak aktif.",
  }[r.state] || "ℹ️ Tagihan sudah tidak aktif.";
  answer(text);
  if (r.state === "canceled" && query && query.message) bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
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
  handleDepositCancel,
  startDeposit,
  cancelDeposit,
  resumePaymentMonitors,
  verifyAndCreditDeposit,
  startPaymentMonitor,
  generateUniqueCode,
  MIN_DEPOSIT,
  MAX_DEPOSIT,
};
