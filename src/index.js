const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const fs = require('fs');
require('dotenv').config();

const {
  BUTTON,
  BOT_COMMANDS,
  createMainMenu,
  createPersistentKeyboard
} = require('./utils/keyboard');
const {
  isInstalling,
  INSTALL_STEPS,
  handleInstallRDP,
  handleVPSCredentials,
  handleWindowsSelection,
  showWindowsSelection,
  handlePageNavigation,
  handleCancelInstallation,
  MIN_CPU,
  MIN_RAM,
  MIN_STORAGE
} = require('./handlers/rdpHandler');
const {
  DO_STEPS,
  startDO,
  handleDOText,
  handleDOCallback
} = require('./handlers/doHandler');
const {
  MULTI_STEPS,
  startMultiInstall,
  handleMultiText,
  handleMultiCallback
} = require('./handlers/multiInstallHandler');
const { handleDeposit, handleDepositAmount } = require('./handlers/depositHandler');
const { handleFAQ } = require('./handlers/faqHandler');
const { handleProviders } = require('./handlers/providerHandler');
const broadcastMessage = require('./handlers/broadcastMessage');
const { handleAddBalance, processAddBalance } = require('./handlers/adminHandler');
const { getBalance, isAdmin } = require('./utils/userManager');
const { INSTALLATION_COST } = require('./config/constants');
const { safeEdit, safeSend, safeAnswer } = require('./utils/telegram');
const DatabaseBackup = require('./utils/dbBackup');
const store = require('./utils/store');
const BackupTelegram = require('./utils/backupTelegram');
const qrin = require('./utils/qrin');

/* ============ Validasi environment ============ */
if (!process.env.BOT_TOKEN) {
  console.error('FATAL: BOT_TOKEN belum diatur di .env');
  process.exit(1);
}
if (!process.env.ADMIN_ID) {
  console.warn('PERINGATAN: ADMIN_ID belum diatur — fitur admin tidak akan aktif.');
}

/* ============ Web service (Render butuh port terbuka) ============ */
const port = Number(process.env.PORT) || 3000;
const paymentGateway = 'qrin';

/**
 * Proses satu callback QRIN (dipanggil setelah tanda tangan diverifikasi).
 * QRIN mengirim { no_ref_merchant, status, jumlah_dibayar, ... }.
 * Idempoten: store.creditDeposit menandai depositId permanen, jadi callback
 * ganda/ulang tidak akan menambah saldo dua kali.
 */
async function prosesCallbackQrin(data) {
  const ref = data && data.no_ref_merchant;
  const status = String((data && data.status) || '').toLowerCase();
  console.log(`[QRIN CALLBACK] ref=${ref} status=${status}`);
  if (!ref || status !== 'success') return;

  // Pastikan data saldo sudah dimuat/dipulihkan sebelum mengkredit.
  await dataSiap;

  const pending = store.getPendingDeposit(ref);
  if (!pending) {
    // Ref ini tidak dikenal bot ini. Bisa jadi milik bot lain yang memakai
    // merchant QRIN yang sama. Diabaikan dengan aman.
    console.warn(`[QRIN CALLBACK] ref ${ref} tidak ada di daftar tunggu bot ini — diabaikan.`);
    return;
  }

  const hasil = store.creditDeposit(pending.user_id, pending.amount, ref, 'deposit');
  store.removePendingDeposit(ref);

  if (hasil.ok && !hasil.duplikat) {
    safeSend(bot, pending.user_id,
      `✅ *Pembayaran Berhasil!*\n\nSaldo bertambah *Rp ${Number(pending.amount).toLocaleString('id-ID')}*`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }
}

const webServer = http.createServer((req, res) => {
  // ===== Webhook / Callback QRIN =====
  // QRIN mengirim POST ke URL callback merchant. Terima /callback & /qrin/callback.
  if (req.method === 'POST' && (req.url === '/callback' || req.url === '/qrin/callback')) {
    const chunks = [];
    let tooBig = false;
    req.on('data', (c) => {
      chunks.push(c);
      if (chunks.reduce((n, b) => n + b.length, 0) > 1_000_000) { tooBig = true; req.destroy(); }
    });
    req.on('end', async () => {
      if (tooBig) return;
      const raw = Buffer.concat(chunks);
      try {
        const signature = req.headers['x-callback-signature'];
        if (!qrin.verifyCallbackSignature(raw, signature)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, message: 'Invalid signature' }));
        }
        let data;
        try { data = JSON.parse(raw.toString('utf8')); }
        catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
        }
        await prosesCallbackQrin(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        console.error('[QRIN CALLBACK] Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false }));
      }
    });
    return;
  }

  const isHealthCheck = req.url === '/health';
  const body = isHealthCheck
    ? JSON.stringify({
        status: 'ok',
        service: 'rdp-installation-bot',
        paymentGateway,
        uptime: Math.floor(process.uptime()),
        activeSessions: userSessions.size,
        storage: 'json-file',
        users: store.stats().users,
        autoBackup: Boolean(backupChatId),
        qrinConfigured: Boolean(process.env.QRIN_TOKEN)
      })
    : '<!doctype html><html lang="id"><head><meta charset="utf-8"><title>RDP Installation Bot</title></head><body><h1>RDP Installation Bot aktif</h1><p>Bot Telegram dan layanan deposit QRIS QRIN sedang berjalan.</p></body></html>';

  res.writeHead(200, {
    'Content-Type': isHealthCheck ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8'
  });
  res.end(body);
});

webServer.listen(port, '0.0.0.0', () => {
  console.log(`Web status aktif pada port ${port}; payment gateway: ${paymentGateway}`);
});

/* ============ Bot ============ */
const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 }
  },
  request: {
    timeout: 30000,
    proxy: process.env.HTTPS_PROXY || null
  }
});

const userSessions = new Map();
const dbBackup = new DatabaseBackup(bot);

/* ============ Penyimpanan data ============
 * Data disimpan di file JSON, bukan database. Di hosting yang filesystem-nya
 * sementara (Render free tier), file itu hilang setiap restart — jadi setiap
 * perubahan juga dicadangkan ke Telegram, dan dipulihkan otomatis saat start.
 *
 * Isi BACKUP_CHAT_ID di .env dengan ID chat/channel tempat cadangan disimpan
 * (boleh sama dengan ADMIN_ID). Tanpa itu, cadangan otomatis tidak aktif.
 */
const backupChatId = (process.env.BACKUP_CHAT_ID || process.env.ADMIN_ID || '')
  .split(',')[0].trim();
const cadangan = new BackupTelegram(bot, backupChatId);

async function siapkanData() {
  // Kalau file lokal tidak ada, coba pulihkan dari cadangan Telegram dulu.
  const adaFileLokal = fs.existsSync(store.filePath);
  await store.init(() => cadangan.pulihkan());

  // Kalau data diambil dari file lokal, pulihkan() tidak dijalankan sehingga
  // id cadangan lama tidak diketahui. Catat sekarang supaya file cadangan dari
  // sesi sebelumnya ikut dibersihkan, bukan menumpuk tiap kali bot restart.
  if (adaFileLokal) {
    await cadangan.catatSematanTerakhir();
  }

  // Setiap penyimpanan ke disk memicu cadangan (digabung otomatis, tidak spam).
  store.onChange = (data) => cadangan.jadwalkan(data);

  if (!store.bolehCadangkan) {
    // Pemulihan gagal karena gangguan, BUKAN karena belum ada cadangan.
    // Menulis cadangan baru sekarang akan menghapus satu-satunya salinan
    // saldo buyer, jadi cadangan dikunci sampai bot di-restart.
    const pesan =
      '🚨 *PERHATIAN - DATA BELUM PULIH*\n\n' +
      'Bot gagal memulihkan data dari cadangan:\n' +
      `\`${store.alasanKunci}\`\n\n` +
      'Cadangan otomatis DIKUNCI supaya cadangan lama tidak tertimpa data kosong.\n\n' +
      'Jangan biarkan buyer bertransaksi sekarang. Perbaiki koneksi lalu restart bot.';
    console.error(pesan.replace(/[*`]/g, ''));
    if (backupChatId) {
      safeSend(bot, backupChatId, pesan, { parse_mode: 'Markdown' }).catch(() => {});
    }
  } else if (cadangan.aktif) {
    console.log(`Cadangan otomatis aktif ke chat ${backupChatId}`);
  } else {
    console.warn(
      'PERINGATAN: BACKUP_CHAT_ID belum diatur. Data hanya tersimpan di file lokal\n' +
      '            dan AKAN HILANG kalau hosting me-restart container.'
    );
  }

  // Kalau cadangan gagal berkali-kali, admin harus tahu — bukan diam-diam.
  cadangan.onGagalTerus = (jumlah) => {
    if (!backupChatId) return;
    safeSend(bot, backupChatId,
      `⚠️ Cadangan otomatis gagal ${jumlah}x beruntun.\n` +
      `Perubahan saldo terbaru belum tersimpan permanen dan bisa hilang ` +
      `kalau server restart. Cek koneksi bot.`).catch(() => {});
  };

  store.onSaveError = (error) => {
    if (!backupChatId) return;
    safeSend(bot, backupChatId,
      `⚠️ Gagal menulis data ke disk: ${error.message}\n` +
      `Cadangan Telegram tetap dijalankan sebagai pengaman.`).catch(() => {});
  };

  dbBackup.scheduleBackup();
}

const dataSiap = siapkanData();

/* ============ Menu perintah Telegram ============
 * setMyCommands membuat tombol "Menu" biru muncul di sebelah kolom ketik.
 * Isinya daftar perintah yang bisa DIKLIK — user tidak perlu mengetik /start.
 * Cukup dijalankan sekali saat bot start; Telegram menyimpannya di sisi mereka.
 */
async function registerBotCommands() {
  try {
    await bot.setMyCommands(BOT_COMMANDS);
    // Pastikan tombol menu menampilkan daftar perintah (bukan web app).
    if (typeof bot.setChatMenuButton === 'function') {
      await bot.setChatMenuButton({ menu_button: JSON.stringify({ type: 'commands' }) });
    }
    console.log('Menu perintah Telegram terdaftar:', BOT_COMMANDS.map((c) => '/' + c.command).join(' '));
  } catch (error) {
    console.error('Gagal mendaftarkan menu perintah:', error.message);
  }
}
registerBotCommands();

/* ============ Pembersih sesi ============
 * Sesi yang ditinggalkan user akan menumpuk selamanya di versi lama.
 * Sesi yang sedang menginstal dikecualikan karena memang berjalan lama.
 */
const SESSION_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [chatId, session] of userSessions.entries()) {
    if (session.step === 'installing') continue;
    const last = session.lastActivity || session.startTime || 0;
    if (now - last > SESSION_TTL_MS) {
      userSessions.delete(chatId);
      console.log(`[SESSION] Sesi ${chatId} kadaluarsa dan dibersihkan.`);
    }
  }
}, 5 * 60 * 1000);

/**
 * Sesi instalasi tidak boleh ditimpa oleh menu lain (deposit, broadcast, dsb).
 *
 * Harus dicek terhadap daftar langkah instalasi, bukan sekadar "punya step".
 * Sesi deposit juga punya step ('waiting_amount'), jadi pengecekan longgar
 * membuat user tidak bisa membuka menu Deposit sama sekali.
 */
function hasActiveInstall(chatId) {
  if (isInstalling(chatId)) return true;
  const s = userSessions.get(chatId);
  if (!s || !s.step) return false;
  return INSTALL_STEPS.has(s.step) || DO_STEPS.has(s.step) || MULTI_STEPS.has(s.step);
}

async function buildMenuText(chatId) {
  const balance = await getBalance(chatId);
  const balanceText = isAdmin(chatId)
    ? 'Unlimited'
    : `Rp ${Number(balance).toLocaleString('id-ID')}`;

  return `🚀 *Bot Instalasi RDP*\n\n` +
    `👤 ID: \`${chatId}\`\n` +
    `💰 Saldo: ${balanceText}\n\n` +
    `Ubah VPS Ubuntu jadi RDP Windows. Rp ${INSTALLATION_COST.toLocaleString('id-ID')}/VPS, ` +
    `saldo terpotong hanya kalau instalasi berhasil.\n\n` +
    `⚡️ *Syarat VPS:* ${MIN_CPU} Core · ${MIN_RAM} GB RAM · ${MIN_STORAGE} GB storage kosong\n` +
    `🆘 Bantuan: wa.me/6285173329868\n\n` +
    `Pilih menu di bawah:`;
}

/** Kirim menu utama sebagai pesan baru (dengan tombol inline). */
async function sendMainMenu(chatId) {
  return safeSend(bot, chatId, await buildMenuText(chatId), {
    parse_mode: 'Markdown',
    ...createMainMenu(isAdmin(chatId))
  });
}

/**
 * Pasang keyboard persisten di bawah kolom ketik.
 * Hanya dikirim sekali per chat selama proses bot hidup, supaya tidak spam.
 */
const keyboardInstalled = new Set();
async function ensurePersistentKeyboard(chatId) {
  if (keyboardInstalled.has(chatId)) return;
  keyboardInstalled.add(chatId);
  await safeSend(bot, chatId,
    '⌨️ Menu cepat sudah aktif di bawah — tidak perlu mengetik perintah lagi.',
    createPersistentKeyboard()
  );
}

/**
 * Beberapa aksi butuh sebuah pesan untuk di-edit. Kalau dipicu dari perintah
 * atau tombol keyboard (bukan tombol inline), kita kirim pesan sementara dulu.
 */
async function runOnFreshMessage(chatId, handler) {
  const placeholder = await safeSend(bot, chatId, '⏳ Memuat...');
  if (!placeholder) return;
  await handler(placeholder.message_id);
}

/* ============ /start ============ */
bot.onText(/^\/start\b/, async (msg) => {
  try {
    await dataSiap;
    const chatId = msg.chat.id;
    await ensurePersistentKeyboard(chatId);
    await sendMainMenu(chatId);
  } catch (error) {
    console.error('Error in start command:', error);
    await safeSend(bot, msg.chat.id, '❌ Terjadi kesalahan. Silakan coba lagi.');
  }
});

/* ============ Perintah lain (muncul di tombol Menu Telegram) ============ */
bot.onText(/^\/install\b/, async (msg) => {
  await dataSiap;
  const chatId = msg.chat.id;
  await ensurePersistentKeyboard(chatId);
  await runOnFreshMessage(chatId, (mid) => handleInstallRDP(bot, chatId, mid, userSessions));
});

bot.onText(/^\/multiinstall\b/, async (msg) => {
  await dataSiap;
  const chatId = msg.chat.id;
  await ensurePersistentKeyboard(chatId);
  await runOnFreshMessage(chatId, (mid) => startMultiInstall(bot, chatId, mid, userSessions));
});

bot.onText(/^\/createvps\b/, async (msg) => {
  await dataSiap;
  const chatId = msg.chat.id;
  await ensurePersistentKeyboard(chatId);
  await runOnFreshMessage(chatId, (mid) => startDO(bot, chatId, mid, userSessions));
});

bot.onText(/^\/deposit\b/, async (msg) => {
  await dataSiap;
  const chatId = msg.chat.id;
  if (hasActiveInstall(chatId)) {
    await safeSend(bot, chatId, '⏳ Selesaikan dulu instalasi yang sedang berjalan.');
    return;
  }
  await ensurePersistentKeyboard(chatId);
  await runOnFreshMessage(chatId, async (mid) => {
    const session = await handleDeposit(bot, chatId, mid);
    userSessions.set(chatId, { ...session, lastActivity: Date.now() });
  });
});

bot.onText(/^\/saldo\b/, async (msg) => {
  // Wajib menunggu: selama pemulihan dari Telegram berlangsung, data masih
  // kosong — tanpa ini buyer melihat saldonya Rp 0 tepat setelah restart.
  await dataSiap;
  const chatId = msg.chat.id;
  try {
    const balance = await getBalance(chatId);
    const text = isAdmin(chatId)
      ? '💳 Saldo Anda: *Unlimited* (admin)'
      : `💳 Saldo Anda: *Rp ${Number(balance).toLocaleString('id-ID')}*`;
    await safeSend(bot, chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '💰 Deposit', callback_data: 'deposit' },
          { text: '🏠 Menu', callback_data: 'back_to_menu' }
        ]]
      }
    });
  } catch (error) {
    console.error('Error /saldo:', error);
    await safeSend(bot, chatId, '❌ Gagal membaca saldo. Coba lagi.');
  }
});

bot.onText(/^\/faq\b/, async (msg) => {
  await dataSiap;
  const chatId = msg.chat.id;
  await runOnFreshMessage(chatId, (mid) => handleFAQ(bot, chatId, mid));
});

bot.onText(/^\/batal\b/, async (msg) => {
  await dataSiap;
  const chatId = msg.chat.id;

  if (isInstalling(chatId)) {
    await safeSend(bot, chatId,
      '⏳ Instalasi sedang berjalan dan tidak bisa dibatalkan.\n' +
      'Hasilnya akan dikirim ke chat ini setelah selesai.');
    return;
  }

  if (!userSessions.has(chatId)) {
    await safeSend(bot, chatId, 'Tidak ada proses yang sedang berjalan.');
    return;
  }

  userSessions.delete(chatId);
  await safeSend(bot, chatId, '❌ Proses dibatalkan.\n\n💰 Saldo Anda tidak terpotong.');
  await sendMainMenu(chatId);
});

/** Aksi untuk tombol keyboard persisten (mengirim teks, bukan callback). */
async function handleKeyboardButton(chatId, text) {
  await dataSiap;
  switch (text) {
    case BUTTON.INSTALL:
      await runOnFreshMessage(chatId, (mid) => handleInstallRDP(bot, chatId, mid, userSessions));
      break;

    case BUTTON.MULTI:
      await runOnFreshMessage(chatId, (mid) => startMultiInstall(bot, chatId, mid, userSessions));
      break;

    case BUTTON.CREATE_VPS:
      await runOnFreshMessage(chatId, (mid) => startDO(bot, chatId, mid, userSessions));
      break;

    case BUTTON.DEPOSIT:
      if (hasActiveInstall(chatId)) {
        await safeSend(bot, chatId, '⏳ Selesaikan dulu instalasi yang sedang berjalan.');
        break;
      }
      await runOnFreshMessage(chatId, async (mid) => {
        const session = await handleDeposit(bot, chatId, mid);
        userSessions.set(chatId, { ...session, lastActivity: Date.now() });
      });
      break;

    case BUTTON.BALANCE: {
      const balance = await getBalance(chatId);
      await safeSend(bot, chatId,
        isAdmin(chatId)
          ? '💳 Saldo Anda: *Unlimited* (admin)'
          : `💳 Saldo Anda: *Rp ${Number(balance).toLocaleString('id-ID')}*`,
        { parse_mode: 'Markdown' });
      break;
    }

    case BUTTON.FAQ:
      await runOnFreshMessage(chatId, (mid) => handleFAQ(bot, chatId, mid));
      break;

    case BUTTON.PROVIDER:
      await runOnFreshMessage(chatId, (mid) => handleProviders(bot, chatId, mid));
      break;

    case BUTTON.MENU:
      // Jangan hapus sesi instalasi yang sedang jalan.
      if (!isInstalling(chatId)) userSessions.delete(chatId);
      await sendMainMenu(chatId);
      break;

    default:
      break;
  }
}

/* ============ Pesan biasa ============ */
bot.on('message', async (msg) => {
  try {
    if (!msg.text || msg.text.startsWith('/')) return;
    await dataSiap;

    const chatId = msg.chat.id;
    const text = msg.text.trim();

    /* --- Tombol keyboard persisten ---
     * Tombol ini mengirim teks biasa, jadi harus dikenali di sini.
     * Diproses SEBELUM sesi, supaya user yang tersangkut di tengah alur
     * tetap bisa keluar lewat tombol (mis. menekan "🏠 Menu Utama").
     */
    if (Object.values(BUTTON).includes(text)) {
      await handleKeyboardButton(chatId, text);
      return;
    }

    const session = userSessions.get(chatId);
    if (!session) return;

    if (session.addingBalance && isAdmin(chatId)) {
      await processAddBalance(bot, msg);
      userSessions.delete(chatId);
      return;
    }

    if (session.broadcasting && isAdmin(chatId)) {
      userSessions.delete(chatId);
      await safeSend(bot, chatId, `🚀 Memulai broadcast...\n\nPesan: ${msg.text}`);
      await broadcastMessage(bot, msg.text, chatId);
      return;
    }

    if (session.step === 'waiting_amount') {
      // handleDepositAmount mengembalikan false kalau nominalnya ditolak —
      // sesi harus dipertahankan supaya user bisa mengirim ulang. Dulu sesi
      // selalu dihapus, sehingga user yang salah ketik jadi buntu total.
      const selesai = await handleDepositAmount(bot, msg, session);
      if (selesai !== false) userSessions.delete(chatId);
      return;
    }

    // Alur "Buat VPS" dan "Multi Install" punya penanganan teks sendiri
    // (token DO, password root, daftar VPS, password RDP).
    if (session.flow === 'do') {
      await handleDOText(bot, msg, userSessions);
      return;
    }
    if (session.flow === 'multi') {
      await handleMultiText(bot, msg, userSessions);
      return;
    }

    await handleVPSCredentials(bot, msg, userSessions);
  } catch (error) {
    console.error('Error handling message:', error);
    await safeSend(bot, msg.chat.id, '❌ Terjadi kesalahan. Silakan coba lagi.');
  }
});

/* ============ Tombol inline ============ */
bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const data = query.data;

  try {
    if (!chatId || !data) return;
    await dataSiap;

    if (data.startsWith('page_')) {
      await handlePageNavigation(bot, query, userSessions);
      return await safeAnswer(bot, query.id);
    }

    if (data.startsWith('windows_')) {
      await handleWindowsSelection(bot, query, userSessions);
      return await safeAnswer(bot, query.id);
    }

    // Semua tombol alur "Buat VPS" (termasuk 'do_start' dari menu).
    // Callback dijawab DULU: sebagian aksi (menunggu droplet siap) bisa makan
    // waktu menit, dan Telegram menganggap callback kadaluarsa setelah ~15 detik.
    if (data.startsWith('do_')) {
      await safeAnswer(bot, query.id);
      await handleDOCallback(bot, query, userSessions);
      return;
    }

    // Semua tombol alur "Multi Install" (termasuk 'multi_start' dari menu,
    // 'multi_win_*', dan 'multi_page_*').
    if (data.startsWith('multi_')) {
      await safeAnswer(bot, query.id);
      await handleMultiCallback(bot, query, userSessions);
      return;
    }

    switch (data) {
      case 'install_rdp':
        await handleInstallRDP(bot, chatId, messageId, userSessions);
        break;

      // Tombol "Coba Lagi" punya callback sendiri. Di versi lama tombol ini
      // memakai 'install_rdp', yang berarti setiap klik memotong saldo lagi.
      case 'retry_install':
        if (!isInstalling(chatId)) userSessions.delete(chatId);
        await handleInstallRDP(bot, chatId, messageId, userSessions);
        break;

      case 'deposit': {
        if (hasActiveInstall(chatId)) {
          await safeAnswer(bot, query.id, {
            text: 'Selesaikan atau batalkan instalasi yang sedang berjalan dulu.',
            show_alert: true
          });
          return;
        }
        const depositSession = await handleDeposit(bot, chatId, messageId);
        userSessions.set(chatId, { ...depositSession, lastActivity: Date.now() });
        break;
      }

      case 'faq':
        await handleFAQ(bot, chatId, messageId);
        break;

      case 'providers':
        await handleProviders(bot, chatId, messageId);
        break;

      case 'add_balance':
        if (!isAdmin(chatId)) break;
        userSessions.set(chatId, { addingBalance: true, lastActivity: Date.now() });
        await handleAddBalance(bot, chatId, messageId);
        break;

      // Broadcast sekarang memakai session, bukan bot.once('message').
      // bot.once menangkap pesan dari SIAPA SAJA, sehingga listener bisa
      // terlepas oleh pesan user lain dan broadcast tidak pernah jalan.
      case 'boardcast':
        if (!isAdmin(chatId)) break;
        userSessions.set(chatId, { broadcasting: true, lastActivity: Date.now() });
        await safeEdit(bot, '🚀 Kirim pesan yang ingin di-broadcast:', {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [[{ text: '« Batal', callback_data: 'back_to_menu' }]]
          }
        });
        break;

      case 'manage_db':
        await dbBackup.handleManageDatabase(chatId, messageId);
        break;

      case 'backup_now':
        if (!isAdmin(chatId)) break;
        await safeEdit(bot, '📤 Mengirim backup database...', {
          chat_id: chatId,
          message_id: messageId
        });
        const backupOk = await dbBackup.sendBackupToAdmin();
        await safeEdit(bot,
          backupOk
            ? '✅ Backup database terkirim!'
            : '❌ Backup gagal. Cek log server — file database mungkin tidak ditemukan.',
          {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
              inline_keyboard: [[{ text: '« Kembali ke Menu', callback_data: 'back_to_menu' }]]
            }
          });
        break;

      case 'show_windows_selection': {
        const rdpSession = userSessions.get(chatId);
        if (!rdpSession || !rdpSession.vpsConfig) {
          await safeAnswer(bot, query.id, {
            text: 'Sesi kadaluarsa. Mulai dari awal ya.',
            show_alert: true
          });
          break;
        }
        rdpSession.step = 'selecting_windows';
        rdpSession.lastActivity = Date.now();
        rdpSession.messageId = messageId;
        userSessions.set(chatId, rdpSession);
        await showWindowsSelection(bot, chatId, messageId, 0, userSessions);
        break;
      }

      case 'back_to_windows':
        await showWindowsSelection(bot, chatId, messageId, 0, userSessions);
        break;

      case 'back_to_menu':
        // Sesi instalasi yang sedang berjalan tidak dihapus di sini —
        // menghapusnya hanya membuat bot lupa, prosesnya tetap jalan.
        if (!isInstalling(chatId)) userSessions.delete(chatId);
        await safeEdit(bot, await buildMenuText(chatId), {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          ...createMainMenu(isAdmin(chatId))
        });
        break;

      case 'cancel_installation':
        await handleCancelInstallation(bot, query, userSessions);
        break;

      default:
        break;
    }

    await safeAnswer(bot, query.id);
  } catch (error) {
    console.error('Error handling callback query:', error);
    await safeAnswer(bot, query.id, {
      text: '❌ Terjadi kesalahan. Silakan coba lagi.',
      show_alert: true
    });
  }
});

/* ============ Error handling ============ */
let restarting = false;
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code || '', error.message);

  if ((error.code === 'EFATAL' || error.code === 'ETIMEDOUT') && !restarting) {
    restarting = true;
    bot.stopPolling()
      .then(() => new Promise((r) => setTimeout(r, 5000)))
      .then(() => bot.startPolling())
      .then(() => { restarting = false; })
      .catch((err) => {
        console.error('Gagal restart polling:', err.message);
        restarting = false;
      });
  }
});

bot.on('error', (error) => console.error('Bot error:', error));

/* ============ Berhenti dengan rapi ============
 * Render mengirim SIGTERM di setiap deploy dan restart. Tanpa penanganan ini,
 * perubahan saldo yang masih menunggu jadwal cadangan (sampai 20 detik) ikut
 * hilang bersama container — dan di filesystem sementara, itu berarti hilang
 * permanen.
 */
let sedangMatikan = false;
async function matikanDenganRapi(sinyal) {
  if (sedangMatikan) return;
  sedangMatikan = true;
  console.log(`${sinyal} diterima — menyimpan data dan mengirim cadangan terakhir...`);

  try { store.simpanSebelumKeluar(); } catch (_) {}

  try {
    const ok = await cadangan.flush(8000);
    console.log(ok ? 'Cadangan terakhir terkirim.' : 'Cadangan terakhir TIDAK terkirim.');
  } catch (error) {
    console.error('Gagal mengirim cadangan terakhir:', error.message);
  }

  process.exit(0);
}

for (const sinyal of ['SIGTERM', 'SIGINT']) {
  process.on(sinyal, () => { matikanDenganRapi(sinyal); });
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});
