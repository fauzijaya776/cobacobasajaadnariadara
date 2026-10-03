const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const fs = require('fs');
require('dotenv').config();

const {
  BUTTON,
  BOT_COMMANDS,
  BOT_SHORT_DESCRIPTION,
  BOT_DESCRIPTION,
  resolveButton,
  isLegacyButton,
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
const {
  handleDeposit,
  handleDepositAmount,
  handleDepositCheck,
  verifyAndCreditDeposit
} = require('./handlers/depositHandler');
const { handleFAQ } = require('./handlers/faqHandler');
const { handleProviders } = require('./handlers/providerHandler');
const broadcastMessage = require('./handlers/broadcastMessage');
const { handleAddBalance, processAddBalance } = require('./handlers/adminHandler');
const { getBalance, isAdmin } = require('./utils/userManager');
const { VPS_CREATE_COST } = require('./config/constants');
const { INSTALLATION_COST } = require('./config/constants');
const { safeEdit, safeSend, safeAnswer, escapeMd } = require('./utils/telegram');
const DatabaseBackup = require('./utils/dbBackup');
const store = require('./utils/store');
const BackupTelegram = require('./utils/backupTelegram');
const pakasir = require('./utils/pakasir');
const { createWebApi } = require('./webApi');

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
const paymentGateway = 'pakasir';

/**
 * Proses satu callback Pakasir.
 *
 * Pakasir mengirim POST ke URL callback merchant saat status berubah, dengan
 * body { amount, order_id, project, status, payment_method, completed_at }.
 *
 * PENTING: webhook Pakasir TIDAK bertanda tangan, jadi isinya tidak boleh
 * dipercaya mentah-mentah. Yang dipakai dari body hanyalah `order_id` untuk
 * menemukan deposit yang menunggu — status LUNAS-nya diverifikasi ulang ke
 * STATUS API Pakasir di dalam verifyAndCreditDeposit sebelum saldo ditambah.
 *
 * Idempoten: store.creditDeposit menandai order_id permanen, jadi callback
 * ganda/ulang tidak akan menambah saldo dua kali.
 */
async function prosesCallbackPakasir(data) {
  const ref = data && data.order_id;
  const status = String((data && data.status) || '').toLowerCase();
  console.log(`[PAKASIR CALLBACK] order_id=${ref} status=${status}`);
  if (!ref) return;

  // Pastikan data saldo sudah dimuat/dipulihkan sebelum mengkredit.
  await dataSiap;

  const hasil = await verifyAndCreditDeposit(bot, ref);
  if (hasil.state === 'unknown') {
    console.warn(`[PAKASIR CALLBACK] order_id ${ref} tidak ada di daftar tunggu bot ini — diabaikan.`);
  }
}

const webServer = http.createServer((req, res) => {
  // ===== API website (web/ di Vercel meneruskan /api/* ke sini) =====
  if (req.url.startsWith('/api/')) return webApi(req, res);

  // ===== Webhook / Callback Pakasir =====
  // Pakasir mengirim POST ke URL callback merchant (mis. https://domain/callback).
  // Terima /callback & /pakasir/callback.
  if (req.method === 'POST' && (req.url === '/callback' || req.url === '/pakasir/callback')) {
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
        let data;
        try { data = JSON.parse(raw.toString('utf8')); }
        catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
        }
        // Balas 200 dulu supaya Pakasir tidak menganggap webhook gagal; kredit
        // saldo diverifikasi ulang ke API Pakasir di latar belakang.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        await prosesCallbackPakasir(data);
      } catch (e) {
        console.error('[PAKASIR CALLBACK] Error:', e.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false }));
        }
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
        pakasirConfigured: pakasir.isConfigured()
      })
    : '<!doctype html><html lang="id"><head><meta charset="utf-8"><title>RDP Installation Bot</title></head><body><h1>RDP Installation Bot aktif</h1><p>Bot Telegram dan layanan deposit QRIS (Pakasir) sedang berjalan.</p></body></html>';

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
const webApi = createWebApi({ bot, dataSiap });

/* ============ Menu perintah Telegram ============
 * setMyCommands membuat tombol "Menu" biru muncul di sebelah kolom ketik.
 * Isinya daftar perintah yang bisa DIKLIK — user tidak perlu mengetik /start.
 * Cukup dijalankan sekali saat bot start; Telegram menyimpannya di sisi mereka.
 */
/** Panggil method Bot API; pakai _request kalau versi library belum punya helper-nya. */
async function callBotApi(method, form) {
  if (typeof bot[method] === 'function') return bot[method](form);
  return bot._request(method, { form });
}

async function registerBotCommands() {
  // Deskripsi bot: teks yang tampil di chat KOSONG sebelum user menekan START
  // ("Apa yang bisa dilakukan bot ini?") dan di profil bot. Dulu tidak pernah
  // diisi, sehingga user baru hanya melihat layar kosong.
  try {
    await callBotApi('setMyDescription', { description: BOT_DESCRIPTION });
    await callBotApi('setMyShortDescription', { short_description: BOT_SHORT_DESCRIPTION });
    console.log('Deskripsi bot Telegram diperbarui.');
  } catch (error) {
    console.error('Gagal memperbarui deskripsi bot:', error.message);
  }

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
 * Deposit boleh dibuka kapan saja.
 *
 * Dulu deposit diblokir selama ada sesi alur apa pun ("Selesaikan dulu
 * instalasi yang sedang berjalan"), termasuk saat user baru di layar
 * "saldo tidak cukup" pada Multi Install — padahal tombol di layar itu justru
 * "💰 Deposit". Hasilnya user buntu. Instalasi yang benar-benar berjalan
 * dijaga oleh installLock (bukan oleh sesi), jadi membuka deposit tidak
 * mengganggu instalasi apa pun.
 */
async function openDeposit(chatId, messageId) {
  const session = await handleDeposit(bot, chatId, messageId);
  userSessions.set(chatId, { ...session, lastActivity: Date.now() });
}

/** Teks saldo + 5 transaksi terakhir. */
function buildBalanceText(chatId) {
  const adminUser = isAdmin(chatId);
  const saldo = store.getBalance(chatId);
  const label = { deposit: 'Deposit', deduct: 'Pemakaian', refund_install_failed: 'Refund',
    refund_cancelled: 'Refund', refund: 'Refund', admin: 'Tambah admin',
    install: 'Install RDP (web)', admin_deduct: 'Dikurangi admin' };
  const riwayat = store.transactionsFor(chatId, 5);
  const baris = riwayat.map((t) => {
    const tgl = t.created_at ? new Date(t.created_at).toLocaleDateString('id-ID') : '-';
    const n = Number(t.amount) || 0;
    const tanda = n >= 0 ? '+' : '−';
    return `• ${tgl} · ${label[t.type] || escapeMd(t.type || '-')} · ${tanda}Rp ${Math.abs(n).toLocaleString('id-ID')}`;
  });
  return (
    `💳 *Saldo Anda:* ${adminUser ? '*Unlimited* (admin)' : `*Rp ${saldo.toLocaleString('id-ID')}*`}\n\n` +
    `🧾 *5 transaksi terakhir:*\n` +
    (baris.length ? baris.join('\n') : '_Belum ada transaksi._') +
    `\n\n_Instalasi RDP: Rp ${INSTALLATION_COST.toLocaleString('id-ID')}/VPS, dipotong hanya kalau berhasil._`
  );
}

const balanceKeyboard = {
  inline_keyboard: [[
    { text: '💰 Deposit Saldo', callback_data: 'deposit' },
    { text: '🏠 Menu Utama', callback_data: 'back_to_menu' }
  ]]
};

async function buildMenuText(chatId) {
  const balance = await getBalance(chatId);
  const balanceText = isAdmin(chatId)
    ? 'Unlimited (admin)'
    : `Rp ${Number(balance).toLocaleString('id-ID')}`;

  return `🚀 *Bot Instalasi RDP*\n\n` +
    `👤 ID: \`${chatId}\`\n` +
    `💰 Saldo: *${balanceText}*\n\n` +
    `🖥️ Install RDP Windows: Rp ${INSTALLATION_COST.toLocaleString('id-ID')}/VPS, ` +
    `dipotong hanya kalau berhasil.\n` +
    `☁️ Control DO via API: gratis (buat droplet Rp ${VPS_CREATE_COST.toLocaleString('id-ID')}/batch).\n` +
    `⚡️ Syarat VPS RDP: ${MIN_CPU} Core · ${MIN_RAM} GB RAM · ${MIN_STORAGE} GB disk kosong\n\n` +
    `Pilih menu di bawah:`;
}

/**
 * Teks sambutan /start — sengaja dibuat lengkap supaya user yang BARU pertama
 * kali memakai bot langsung paham: apa yang bot lakukan, cara pakainya, biaya,
 * syarat VPS, dan berapa lama prosesnya. Menu ringkas (buildMenuText) tetap
 * dipakai untuk navigasi "kembali" agar tidak bertele-tele tiap kali.
 */
async function buildWelcomeText(chatId, firstName = '') {
  const balance = await getBalance(chatId);
  const balanceText = isAdmin(chatId)
    ? 'Unlimited (admin)'
    : `Rp ${Number(balance).toLocaleString('id-ID')}`;
  const sapa = firstName ? `, ${escapeMd(String(firstName).slice(0, 40))}` : '';

  return (
    `👋 *Selamat datang${sapa}!*\n` +
    `Ini *Bot Instalasi RDP Windows*.\n\n` +
    `Bot ini mengubah *VPS Ubuntu* Anda menjadi *RDP Windows* siap pakai — ` +
    `otomatis, tanpa perlu paham teknis. Butuh VPS? Buat langsung di akun ` +
    `*DigitalOcean* Anda lewat menu *Control DO via API*.\n\n` +
    `👤 ID Anda: \`${chatId}\`\n` +
    `💰 Saldo: *${balanceText}*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📋 *Fitur*\n\n` +
    `🖥️ *Install RDP* — pasang Windows ke 1 VPS. Kirim IP & password VPS, ` +
    `pilih Windows (XP, 7, 8.1, 10, 11, Server 2003–2025), selesai.\n` +
    `📦 *Multi Install RDP* — pasang ke banyak VPS sekaligus (maks 10 per batch).\n` +
    `☁️ *Control DO via API* — pakai token DigitalOcean Anda: buat droplet 1–10 ` +
    `sekaligus, lihat daftar, nyalakan/matikan/reboot, reset password, snapshot, ` +
    `hapus, dan cek tagihan.\n` +
    `💰 *Deposit Saldo* — isi saldo via QRIS (semua e-wallet & m-banking), masuk otomatis.\n` +
    `💳 *Saldo & Riwayat* · ❓ *FAQ & Bantuan* · 🏢 *Rekomendasi VPS*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💵 *Biaya*\n` +
    `• Install RDP: *Rp ${INSTALLATION_COST.toLocaleString('id-ID')} per VPS* — saldo ` +
    `*hanya dipotong kalau instalasi BERHASIL*.\n` +
    `• Control DO: *gratis*; buat droplet Rp ${VPS_CREATE_COST.toLocaleString('id-ID')} ` +
    `flat per batch (sewa droplet ditagih DO ke akun Anda).\n` +
    `• Deposit QRIS: tanpa biaya tambahan, bayar sesuai nominal.\n\n` +
    `⚡️ *Syarat VPS untuk RDP*\n` +
    `• Minimal ${MIN_CPU} Core · ${MIN_RAM} GB RAM · ${MIN_STORAGE} GB disk kosong\n` +
    `• OS *fresh install* Ubuntu 20.04 / 22.04 / 24.04, akses root\n` +
    `• Disarankan VPS yang mendukung KVM (lihat 🏢 Rekomendasi VPS)\n\n` +
    `⏳ *Lama instalasi:* ±15–45 menit. Progres tampil di chat ini; Anda boleh ` +
    `menutup Telegram — proses tetap jalan dan hasilnya dikirim ke sini.\n\n` +
    `🆕 *Cara mulai:*\n` +
    `1. Tekan *💰 Deposit Saldo* → scan QRIS\n` +
    `2. Tekan *🖥️ Install RDP* → kirim IP & password VPS\n` +
    `3. Pilih versi Windows & buat password RDP → tunggu selesai\n\n` +
    `🆘 Bantuan admin: wa.me/6285173329868\n\n` +
    `Pilih menu di bawah untuk mulai 👇`
  );
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
async function ensurePersistentKeyboard(chatId, force = false) {
  if (keyboardInstalled.has(chatId) && !force) return;
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
    // Catat user sejak /start pertama, supaya ikut menerima broadcast walau
    // belum pernah deposit (dulu user baru tercatat hanya saat saldo berubah).
    if (chatId > 0) store.getUser(chatId);
    await ensurePersistentKeyboard(chatId, true);
    await safeSend(bot, chatId, await buildWelcomeText(chatId, msg.from && msg.from.first_name), {
      parse_mode: 'Markdown',
      ...createMainMenu(isAdmin(chatId))
    });
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

// /do (baru) dan /createvps (lama) sama-sama membuka Control DO via API.
bot.onText(/^\/(do|createvps)\b/, async (msg) => {
  await dataSiap;
  const chatId = msg.chat.id;
  await ensurePersistentKeyboard(chatId);
  await runOnFreshMessage(chatId, (mid) => startDO(bot, chatId, mid, userSessions));
});

bot.onText(/^\/deposit\b/, async (msg) => {
  await dataSiap;
  const chatId = msg.chat.id;
  await ensurePersistentKeyboard(chatId);
  await runOnFreshMessage(chatId, (mid) => openDeposit(chatId, mid));
});

bot.onText(/^\/saldo\b/, async (msg) => {
  // Wajib menunggu: selama pemulihan dari Telegram berlangsung, data masih
  // kosong — tanpa ini buyer melihat saldonya Rp 0 tepat setelah restart.
  await dataSiap;
  const chatId = msg.chat.id;
  try {
    await safeSend(bot, chatId, buildBalanceText(chatId), {
      parse_mode: 'Markdown',
      reply_markup: balanceKeyboard
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
async function handleKeyboardButton(chatId, rawText) {
  await dataSiap;
  const text = resolveButton(rawText);
  // Tombol dari keyboard versi lama → pasang keyboard baru sekali.
  if (isLegacyButton(rawText)) await ensurePersistentKeyboard(chatId, true);
  switch (text) {
    case BUTTON.INSTALL:
      await runOnFreshMessage(chatId, (mid) => handleInstallRDP(bot, chatId, mid, userSessions));
      break;

    case BUTTON.MULTI:
      await runOnFreshMessage(chatId, (mid) => startMultiInstall(bot, chatId, mid, userSessions));
      break;

    case BUTTON.DO_CONTROL:
      await runOnFreshMessage(chatId, (mid) => startDO(bot, chatId, mid, userSessions));
      break;

    case BUTTON.DEPOSIT:
      await runOnFreshMessage(chatId, (mid) => openDeposit(chatId, mid));
      break;

    case BUTTON.BALANCE:
      await safeSend(bot, chatId, buildBalanceText(chatId), {
        parse_mode: 'Markdown',
        reply_markup: balanceKeyboard
      });
      break;

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
    if (resolveButton(text)) {
      await handleKeyboardButton(chatId, text);
      return;
    }

    const session = userSessions.get(chatId);
    if (!session) return;

    if (session.addingBalance && isAdmin(chatId)) {
      // processAddBalance mengembalikan false kalau formatnya salah — sesi
      // dipertahankan supaya admin cukup mengirim ulang.
      const ok = await processAddBalance(bot, msg);
      if (ok !== false) userSessions.delete(chatId);
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

    // Tombol "Cek Status Pembayaran" di pesan QRIS deposit.
    // Formatnya paycheck:<order_id>. Jawaban ke user dikirim lewat alert
    // callback (di dalam handleDepositCheck), jadi tidak perlu safeAnswer lagi.
    if (data.startsWith('paycheck:')) {
      const ref = data.slice('paycheck:'.length);
      await handleDepositCheck(bot, chatId, ref, query);
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

      case 'deposit':
        await openDeposit(chatId, messageId);
        break;

      case 'my_balance':
        await safeEdit(bot, buildBalanceText(chatId), {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: balanceKeyboard
        });
        break;

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

      case 'backup_now': {
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
      }

      case 'show_windows_selection': {
        const rdpSession = userSessions.get(chatId);
        if (isInstalling(chatId)) {
          await safeAnswer(bot, query.id, {
            text: 'Instalasi sedang berjalan. Tunggu sampai selesai ya.',
            show_alert: true
          });
          break;
        }
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
