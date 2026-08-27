const { INSTALLATION_COST } = require('../config/constants');
const {
  WINDOWS_VERSIONS,
  getCompatibleVersions,
  isVersionCompatible,
  findVersion
} = require('../config/windows');

const ssh = require('../utils/ssh');
const { checkVPSSupport } = require('../utils/vpsChecker');
const { detectVPSSpecs } = require('../utils/vpsSpecs');
const { installRDP, verifyServices } = require('../utils/rdpInstaller');
const { calculateAllocation } = require('../utils/specFormatter');
const { parseVpsInput, resolveSSHPort, INPUT_ERROR_MESSAGES } = require('../utils/vpsTarget');
const { formatVPSSpecs } = require('../utils/messageFormatter');
const {
  hasSufficientBalance,
  deductBalance,
  refundBalance,
  isAdmin,
  recordInstallation,
  updateInstallation
} = require('../utils/userManager');
const { safeEdit, safeSend, safeDelete, escapeMd } = require('../utils/telegram');

const MIN_CPU = 2;
const MIN_RAM = 4;
const MIN_STORAGE = 25;

/**
 * Daftar user yang instalasinya sedang BENAR-BENAR berjalan.
 *
 * Ini terpisah dari userSessions dengan sengaja. Menghapus session (lewat
 * tombol Batal, sesi kadaluarsa, atau /start) TIDAK menghentikan instalasi
 * yang sudah jalan di VPS — prosesnya hidup di dalam closure dan tetap lanjut.
 * Kalau penjaganya cuma session, user bisa: mulai instalasi A, tekan Batal,
 * lalu mulai instalasi B, dan mendapat dua RDP dengan satu kali bayar
 * (saldo baru dipotong di akhir, dan cek saldo di awal lolos dua-duanya).
 *
 * Set ini hanya dibersihkan di `finally` setelah instalasi benar-benar selesai.
 */
const activeInstalls = new Set();

/** Langkah-langkah yang termasuk alur instalasi (bukan deposit/broadcast). */
const INSTALL_STEPS = new Set([
  'waiting_ip',
  'waiting_password',
  'checking_vps',
  'selecting_windows',
  'waiting_rdp_password',
  'installing'
]);

function isInstalling(chatId) {
  return activeInstalls.has(chatId);
}

const cancelKeyboard = {
  inline_keyboard: [[{ text: '« Batal', callback_data: 'cancel_installation' }]]
};

/* =========================================================================
 * Langkah 1 — mulai instalasi
 *
 * PERUBAHAN PENTING: saldo TIDAK dipotong di sini. Di versi lama, klik tombol
 * ini langsung memotong Rp1.000 — sebelum VPS dicek, sebelum Windows dipilih,
 * dan tanpa jalur refund. Sekarang saldo hanya DICEK, dan baru dipotong setelah
 * instalasi benar-benar berhasil.
 * ========================================================================= */
async function handleInstallRDP(bot, chatId, messageId, userSessions) {
  // Penjaga utama: instalasi yang sedang berjalan tidak bisa dilewati dengan
  // cara apa pun, termasuk menghapus session.
  if (isInstalling(chatId)) {
    await safeEdit(bot,
      '⏳ *Instalasi Anda sedang berjalan*\n\n' +
      'Proses ini tidak bisa dihentikan dan tidak bisa dijalankan dua kali ' +
      'bersamaan. Tunggu sampai selesai — Anda akan diberi tahu di sini.',
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '« Kembali', callback_data: 'back_to_menu' }]]
        }
      }
    );
    return;
  }

  const existing = userSessions.get(chatId);
  if (existing && existing.step && INSTALL_STEPS.has(existing.step)) {
    await safeEdit(bot,
      '⚠️ Anda masih punya proses instalasi yang berjalan.\n\n' +
      'Selesaikan atau batalkan dulu sebelum memulai yang baru.',
      {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ Batalkan proses lama', callback_data: 'cancel_installation' }],
            [{ text: '« Kembali', callback_data: 'back_to_menu' }]
          ]
        }
      }
    );
    return;
  }

  const cukup = await hasSufficientBalance(chatId, INSTALLATION_COST);
  if (!cukup) {
    await safeEdit(bot,
      `❌ Saldo tidak mencukupi.\n\n` +
      `Biaya instalasi: Rp ${INSTALLATION_COST.toLocaleString('id-ID')}\n` +
      `Silakan deposit terlebih dahulu.`,
      {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [[
            { text: '💰 Deposit', callback_data: 'deposit' },
            { text: '« Kembali', callback_data: 'back_to_menu' }
          ]]
        }
      }
    );
    return;
  }

  await safeEdit(bot, buildIpPrompt(), {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: cancelKeyboard
  });

  userSessions.set(chatId, {
    step: 'waiting_ip',
    startTime: Date.now(),
    lastActivity: Date.now(),
    messageId,
    charged: false,
    installationId: null,
    attempt: 0
  });
}

function buildIpPrompt(errorNote = null) {
  return (
    '📝 *Detail VPS*\n\n' +
    '⚡️ *Spesifikasi Minimal:*\n' +
    `• CPU: ${MIN_CPU} Core\n` +
    `• RAM: ${MIN_RAM} GB\n` +
    `• Storage: ${MIN_STORAGE} GB kosong\n\n` +
    '🌐 *Kirim IP VPS Anda:*\n' +
    '• `123.45.67.89` — port SSH dideteksi otomatis\n' +
    '• `123.45.67.89:2222` — kalau port SSH bukan 22\n\n' +
    '_IP akan dihapus otomatis setelah dikirim_\n' +
    '⚠️ *PENTING:* VPS wajib fresh install Ubuntu 20.04/22.04/24.04' +
    (errorNote ? `\n\n❌ ${errorNote}` : '')
  );
}

/* =========================================================================
 * Langkah 2 — terima IP, password, dan password RDP
 * ========================================================================= */
async function handleVPSCredentials(bot, msg, userSessions) {
  const chatId = msg.chat.id;
  const session = userSessions.get(chatId);

  if (!session || !session.step) {
    return;
  }

  session.lastActivity = Date.now();

  // Hapus pesan user (berisi IP/password) secepatnya.
  await safeDelete(bot, chatId, msg.message_id);

  switch (session.step) {
    case 'waiting_ip':
      return handleIpInput(bot, chatId, msg.text, session, userSessions);
    case 'waiting_password':
      return handlePasswordInput(bot, chatId, msg.text, session, userSessions);
    case 'waiting_rdp_password':
      return handleRdpPasswordInput(bot, chatId, msg.text, session, userSessions);
    default:
      return;
  }
}

async function handleIpInput(bot, chatId, text, session, userSessions) {
  const parsed = parseVpsInput(text);

  if (parsed.error) {
    await safeEdit(bot, buildIpPrompt(INPUT_ERROR_MESSAGES[parsed.error] || 'Format IP tidak valid.'), {
      chat_id: chatId,
      message_id: session.messageId,
      parse_mode: 'Markdown',
      reply_markup: cancelKeyboard
    });
    return;
  }

  await safeEdit(bot, `🔍 Mencari port SSH pada \`${parsed.ip}\`...`, {
    chat_id: chatId,
    message_id: session.messageId,
    parse_mode: 'Markdown'
  });

  const resolved = await resolveSSHPort(parsed.ip, parsed.port);

  if (!resolved.port) {
    const note = parsed.port
      ? `Port ${parsed.port} tidak menjawab, dan tidak ada port SSH lain yang terbuka.`
      : 'Tidak ditemukan port SSH yang terbuka pada IP tersebut.';

    await safeEdit(bot,
      `❌ ${note}\n\n` +
      'Pastikan:\n' +
      '• VPS sudah menyala\n' +
      '• Firewall mengizinkan koneksi SSH\n' +
      '• IP yang dimasukkan benar\n\n' +
      'Kalau port SSH Anda tidak umum, kirim dengan format `IP:PORT`.',
      {
        chat_id: chatId,
        message_id: session.messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🔄 Coba Lagi', callback_data: 'retry_install' },
            { text: '« Batal', callback_data: 'cancel_installation' }
          ]]
        }
      }
    );
    return;
  }

  session.ip = parsed.ip;
  session.sshPort = resolved.port;
  session.sshUser = parsed.username || 'root';
  session.step = 'waiting_password';
  userSessions.set(chatId, session);

  const portNote = resolved.autoDetected
    ? `\n_Port SSH terdeteksi otomatis: ${resolved.port}_`
    : `\n_Port SSH: ${resolved.port}_`;

  await safeEdit(bot,
    `✅ VPS ditemukan di \`${parsed.ip}:${resolved.port}\`${portNote}\n\n` +
    `🔑 *Kirim password untuk user \`${session.sshUser}\`:*\n` +
    '_Password akan dihapus otomatis_',
    {
      chat_id: chatId,
      message_id: session.messageId,
      parse_mode: 'Markdown',
      reply_markup: cancelKeyboard
    }
  );
}

async function handlePasswordInput(bot, chatId, text, session, userSessions) {
  if (!text || !text.trim()) {
    await safeEdit(bot, '❌ Password kosong. Silakan kirim ulang password VPS.', {
      chat_id: chatId,
      message_id: session.messageId,
      reply_markup: cancelKeyboard
    });
    return;
  }

  session.password = text;
  session.step = 'checking_vps';
  userSessions.set(chatId, session);

  await safeEdit(bot, '🔍 Memeriksa VPS...\n_Menghubungkan dan membaca spesifikasi_', {
    chat_id: chatId,
    message_id: session.messageId,
    parse_mode: 'Markdown'
  });

  const target = {
    host: session.ip,
    port: session.sshPort,
    username: session.sshUser,
    password: session.password
  };

  let conn;
  try {
    conn = await ssh.connect(target);
  } catch (error) {
    return reportConnectionError(bot, chatId, session, userSessions, error);
  }

  try {
    // Satu koneksi, dua perintah berurutan. Versi lama membuka DUA koneksi
    // SSH bersamaan lewat Promise.all, yang sering ditolak VPS ber-fail2ban
    // atau MaxStartups ketat, dan meninggalkan koneksi menggantung saat error.
    const rawSpecs = await detectVPSSpecs(conn);
    const kvm = await checkVPSSupport(conn);

    session.rawSpecs = rawSpecs;
    session.supportsKvm = kvm.supported;
    session.isArm = rawSpecs.isArm;

    const allocation = calculateAllocation(rawSpecs);
    session.vpsConfig = allocation;

    const tooSmall = validateMinimums(rawSpecs, allocation);
    if (tooSmall) {
      await safeEdit(bot,
        `❌ *Spesifikasi VPS belum memenuhi syarat*\n\n${tooSmall}\n\n` +
        formatVPSSpecs(rawSpecs, allocation) +
        '_Tidak ada saldo yang terpotong._',
        {
          chat_id: chatId,
          message_id: session.messageId,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '🔄 Coba VPS Lain', callback_data: 'retry_install' },
              { text: '« Menu', callback_data: 'back_to_menu' }
            ]]
          }
        }
      );
      userSessions.delete(chatId);
      return;
    }

    session.step = 'selecting_windows';
    userSessions.set(chatId, session);

    const header = kvm.supported
      ? '✅ *VPS mendukung KVM* — performa optimal.'
      : '⚠️ *VPS tidak mendukung KVM.*\nInstalasi tetap bisa jalan memakai emulasi, tapi Windows akan terasa lebih lambat.';

    const archNote = rawSpecs.isArm
      ? `\n🏗️ Arsitektur: ARM (${escapeMd(rawSpecs.arch)}) — installer ARM akan dipakai.`
      : '';

    await safeEdit(bot,
      `${header}${archNote}\n\n${formatVPSSpecs(rawSpecs, allocation)}` +
      'Lanjutkan untuk memilih versi Windows:',
      {
        chat_id: chatId,
        message_id: session.messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Lanjutkan', callback_data: 'show_windows_selection' }],
            [{ text: '❌ Batal', callback_data: 'cancel_installation' }]
          ]
        }
      }
    );
  } catch (error) {
    return reportConnectionError(bot, chatId, session, userSessions, error);
  } finally {
    try { conn.end(); } catch (_) {}
  }
}

function validateMinimums(rawSpecs, allocation) {
  const problems = [];
  if (rawSpecs.cpu < MIN_CPU) {
    problems.push(`• CPU hanya ${rawSpecs.cpu} core (minimal ${MIN_CPU})`);
  }
  if (allocation.ram < MIN_RAM) {
    problems.push(`• RAM hanya ${allocation.ram} GB (minimal ${MIN_RAM} GB)`);
  }
  if (allocation.storage < MIN_STORAGE) {
    problems.push(
      `• Sisa disk hanya ${allocation.storage} GB setelah dikurangi swap ${allocation.swap} GB ` +
      `(minimal ${MIN_STORAGE} GB). Total kosong: ${rawSpecs.storageAvail} GB`
    );
  }
  return problems.length ? problems.join('\n') : null;
}

/** Terjemahkan error koneksi jadi pesan yang menjelaskan penyebab sebenarnya. */
async function reportConnectionError(bot, chatId, session, userSessions, error) {
  const raw = String(error?.message || '');
  const [code, detail] = raw.includes(':') ? [raw.split(':')[0], raw.slice(raw.indexOf(':') + 1)] : [raw, ''];

  const messages = {
    SSH_AUTH:
      `❌ *Password salah*\n\nUser \`${session.sshUser}\` ditolak VPS.\n\n` +
      'Kalau VPS Anda mematikan login root, kirim ulang IP dengan format ' +
      '`user@IP:PORT` (contoh: `ubuntu@1.2.3.4:22`).',
    SSH_REFUSED: `❌ *Koneksi ditolak*\n\n${escapeMd(detail)}\n\nCek apakah layanan SSH berjalan.`,
    SSH_TIMEOUT: `❌ *VPS tidak merespons*\n\n${escapeMd(detail)}\n\nCek firewall dan status VPS.`,
    SSH_DNS: '❌ *IP tidak ditemukan*\n\nPastikan IP yang dimasukkan benar.',
    KVM_CHECK_INCOMPLETE: '❌ *Gagal memeriksa dukungan KVM*\n\nVPS terhubung tapi perintah pemeriksaan tidak selesai.',
    SPEC_INCOMPLETE: '❌ *Gagal membaca spesifikasi VPS*\n\nVPS terhubung tapi perintah tidak selesai. Pastikan OS-nya Ubuntu/Debian standar.',
    SPEC_PARSE: '❌ *Gagal membaca spesifikasi VPS*\n\nFormat keluaran tidak dikenali. Pastikan OS-nya Ubuntu/Debian standar.',
    EXEC_TIMEOUT: '❌ *VPS terlalu lambat merespons*\n\nPemeriksaan melewati batas waktu.'
  };

  const body = messages[code] || `❌ *Gagal terhubung ke VPS*\n\n${escapeMd(detail || raw)}`;

  console.error(`[VPS CHECK] chat=${chatId} ip=${session.ip}:${session.sshPort} error=${raw}`);

  await safeEdit(bot, `${body}\n\n💰 _Saldo Anda tidak terpotong._`, {
    chat_id: chatId,
    message_id: session.messageId,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '🔄 Coba Lagi', callback_data: 'retry_install' },
        { text: '« Menu', callback_data: 'back_to_menu' }
      ]]
    }
  });

  userSessions.delete(chatId);
}

/* =========================================================================
 * Langkah 3 — pilih versi Windows
 * ========================================================================= */
async function showWindowsSelection(bot, chatId, messageId, page = 0, userSessions = null) {
  const session = userSessions ? userSessions.get(chatId) : null;
  const allocation = session?.vpsConfig;

  const available = allocation ? getCompatibleVersions(allocation) : WINDOWS_VERSIONS;

  if (available.length === 0) {
    await safeEdit(bot,
      '❌ Tidak ada versi Windows yang muat di spesifikasi VPS ini.\n\n' +
      '💰 _Saldo Anda tidak terpotong._',
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '« Menu', callback_data: 'back_to_menu' }]] }
      }
    );
    return;
  }

  const itemsPerPage = 6;
  const totalPages = Math.ceil(available.length / itemsPerPage);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * itemsPerPage;
  const pageItems = available.slice(start, start + itemsPerPage);

  let text = '🪟 *Pilih Versi Windows*\n';
  if (allocation) {
    text += `_Alokasi VPS Anda: ${allocation.cpu} Core · ${allocation.ram} GB RAM · ${allocation.storage} GB_\n`;
  }
  // Hanya tampilkan item halaman ini — dulu seluruh daftar dicetak di setiap
  // halaman, sehingga halaman 1/2/3 isinya identik dan tombol navigasi terasa rusak.
  const desktopOnPage = pageItems.filter((v) => v.category === 'desktop');
  const serverOnPage = pageItems.filter((v) => v.category === 'server');

  if (desktopOnPage.length) {
    text += `\n📱 *Desktop:*\n`;
    desktopOnPage.forEach((v) => {
      text += `${v.id}. ${v.name} (Rp ${v.price.toLocaleString('id-ID')})\n`;
    });
  }
  if (serverOnPage.length) {
    text += `\n🖥️ *Server:*\n`;
    serverOnPage.forEach((v) => {
      text += `${v.id}. ${v.name} (Rp ${v.price.toLocaleString('id-ID')})\n`;
    });
  }

  const hidden = WINDOWS_VERSIONS.length - available.length;
  if (hidden > 0) {
    text += `\n_${hidden} versi disembunyikan karena butuh RAM/disk lebih besar._`;
  }
  text += `\n\nHalaman ${safePage + 1}/${totalPages}`;

  const keyboard = [];
  for (let i = 0; i < pageItems.length; i += 2) {
    const row = [{
      text: `${pageItems[i].id}. ${pageItems[i].name}`,
      callback_data: `windows_${pageItems[i].id}`
    }];
    if (pageItems[i + 1]) {
      row.push({
        text: `${pageItems[i + 1].id}. ${pageItems[i + 1].name}`,
        callback_data: `windows_${pageItems[i + 1].id}`
      });
    }
    keyboard.push(row);
  }

  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️ Sebelumnya', callback_data: `page_${safePage - 1}` });
  if (start + itemsPerPage < available.length) nav.push({ text: 'Selanjutnya ➡️', callback_data: `page_${safePage + 1}` });
  if (nav.length) keyboard.push(nav);

  keyboard.push([{ text: '« Batal', callback_data: 'cancel_installation' }]);

  await safeEdit(bot, text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function handleWindowsSelection(bot, query, userSessions) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const session = userSessions.get(chatId);

  if (!session || !session.vpsConfig) {
    await safeEdit(bot, '❌ Sesi telah kadaluarsa. Silakan mulai dari awal.\n\n💰 _Saldo Anda tidak terpotong._', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Menu', callback_data: 'back_to_menu' }]] }
    });
    return;
  }

  const selected = findVersion(query.data.split('_')[1]);
  if (!selected) return;

  if (!isVersionCompatible(selected, session.vpsConfig)) {
    await safeEdit(bot,
      `❌ *${escapeMd(selected.name)}* butuh minimal ${selected.minRam} GB RAM dan ${selected.minDisk} GB disk.\n\n` +
      `VPS Anda: ${session.vpsConfig.ram} GB RAM, ${session.vpsConfig.storage} GB disk.\n\n` +
      'Silakan pilih versi yang lebih ringan.',
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '« Pilih Ulang', callback_data: 'back_to_windows' }]] }
      }
    );
    return;
  }

  session.windowsVersion = selected;
  session.step = 'waiting_rdp_password';
  session.messageId = messageId;
  userSessions.set(chatId, session);

  await safeEdit(bot, buildRdpPasswordPrompt(session), {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'back_to_windows' }]] }
  });
}

function buildRdpPasswordPrompt(session, errorNote = null) {
  const c = session.vpsConfig;
  return (
    `📝 *Konfigurasi yang dipilih*\n\n` +
    `🪟 Windows: ${escapeMd(session.windowsVersion.name)}\n` +
    `💰 Harga: Rp ${session.windowsVersion.price.toLocaleString('id-ID')}\n\n` +
    `⚙️ *Spesifikasi RDP:*\n` +
    `• CPU: ${c.cpu} Core\n` +
    `• RAM: ${c.ram} GB\n` +
    `• Storage: ${c.storage} GB\n\n` +
    `🔑 *Masukkan password untuk RDP Windows:*\n` +
    `_Minimal 8 karakter, harus ada huruf dan angka_\n` +
    `Contoh: \`Fauzi2024\`` +
    (errorNote ? `\n\n❌ ${errorNote}` : '')
  );
}

/* =========================================================================
 * Langkah 4 — jalankan instalasi
 * ========================================================================= */
async function handleRdpPasswordInput(bot, chatId, text, session, userSessions) {
  const password = String(text || '');

  if (password.length < 8 || !/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/.test(password)) {
    await safeEdit(bot,
      buildRdpPasswordPrompt(session, 'Password harus minimal 8 karakter, hanya huruf dan angka, dan mengandung keduanya.'),
      {
        chat_id: chatId,
        message_id: session.messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'back_to_windows' }]] }
      }
    );
    return;
  }

  session.rdpPassword = password;
  session.step = 'installing';
  session.installStartedAt = Date.now();
  userSessions.set(chatId, session);

  // Kunci instalasi. Dari titik ini sampai `finally`, user tidak bisa memulai
  // instalasi kedua — bahkan kalau session-nya dihapus.
  activeInstalls.add(chatId);

  const installationId = await recordInstallation(chatId, {
    ip: session.ip,
    sshPort: session.sshPort,
    windowsId: session.windowsVersion.id,
    windowsName: session.windowsVersion.name,
    cost: INSTALLATION_COST,
    status: 'running'
  });
  session.installationId = installationId;

  await safeEdit(bot,
    '🔄 *Memulai instalasi Windows*\n\n' +
    '⏳ Estimasi 15-45 menit.\n' +
    '📝 Progres akan diperbarui di pesan ini.\n\n' +
    '💰 _Saldo baru dipotong setelah instalasi berhasil._',
    {
      chat_id: chatId,
      message_id: session.messageId,
      parse_mode: 'Markdown'
    }
  );

  const target = {
    host: session.ip,
    port: session.sshPort,
    username: session.sshUser,
    password: session.password
  };

  const config = {
    windowsId: session.windowsVersion.id,
    cpu: session.vpsConfig.cpu,
    ram: session.vpsConfig.ram,
    storage: session.vpsConfig.storage,
    swap: session.vpsConfig.swap,
    password: session.rdpPassword,
    isArm: session.isArm,
    supportsKvm: session.supportsKvm
  };

  // Batasi frekuensi update agar tidak kena rate limit Telegram.
  let lastUpdate = 0;
  const onProgress = async (p) => {
    const now = Date.now();
    if (now - lastUpdate < 30000) return;
    lastUpdate = now;

    const filled = Math.round(p.percent / 5);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);

    await safeEdit(bot,
      `🔄 *Instalasi sedang berjalan*\n\n` +
      `\`${bar}\` ${p.percent}%\n\n` +
      `🖥️ ${escapeMd(session.windowsVersion.name)}\n` +
      `🌐 ${session.ip}\n` +
      `📊 ${escapeMd(p.note || '')}\n\n` +
      `_Jangan matikan VPS. Anda boleh menutup chat ini._`,
      {
        chat_id: chatId,
        message_id: session.messageId,
        parse_mode: 'Markdown'
      }
    );
  };

  /* Instalasi dan penagihan sengaja DIPISAH ke dua try berbeda.
   * Kalau digabung, error saat memotong saldo akan salah dilaporkan sebagai
   * "instalasi gagal" — padahal RDP-nya sudah jadi dan saldo mungkin sudah
   * berkurang, sehingga user diberi tahu "saldo tidak terpotong" secara keliru. */
  let installSucceeded = false;
  try {
    await installRDP(target, config, { onProgress });
    installSucceeded = true;
  } catch (error) {
    await handleInstallFailure(bot, chatId, session, error);
  }

  if (!installSucceeded) {
    activeInstalls.delete(chatId);
    session.step = 'done';
    userSessions.delete(chatId);
    return;
  }

  try {
    /* --- Instalasi berhasil: BARU sekarang saldo dipotong --- */
    let charged = false;
    if (!isAdmin(chatId)) {
      charged = await deductBalance(chatId, INSTALLATION_COST);
      session.charged = charged;
      if (!charged) {
        // Saldo habis dipakai di tempat lain saat instalasi berjalan.
        // RDP sudah terlanjur jadi, jadi tetap diserahkan dan admin diberi tahu.
        console.error(`[BILLING] Gagal memotong saldo user ${chatId} setelah instalasi sukses.`);
        await notifyAdmin(bot,
          `⚠️ Instalasi user ${chatId} (${session.ip}) berhasil tapi saldo tidak bisa dipotong.\n` +
          `Nominal: Rp ${INSTALLATION_COST.toLocaleString('id-ID')}`);
      }
    }

    await updateInstallation(
      installationId,
      charged || isAdmin(chatId) ? 'success' : 'success_uncharged'
    );

    const durationMin = Math.max(1, Math.floor((Date.now() - session.installStartedAt) / 60000));
    const services = await verifyServices(session.ip, [8006, 3389]);
    const viewerUp = services.find((s) => s.port === 8006)?.open;

    await safeEdit(bot,
      `✅ *Instalasi Windows dimulai dengan sukses!*\n\n` +
      `📝 *Detail RDP:*\n` +
      `🖥️ Windows: ${escapeMd(session.windowsVersion.name)}\n` +
      `🌐 IP: \`${session.ip}\`\n` +
      `👤 Username: \`admin\`\n` +
      `🔑 Password: \`${escapeMd(session.rdpPassword)}\`\n\n` +
      `⚙️ *Spesifikasi:*\n` +
      `• CPU: ${session.vpsConfig.cpu} Core\n` +
      `• RAM: ${session.vpsConfig.ram} GB\n` +
      `• Storage: ${session.vpsConfig.storage} GB\n\n` +
      `⏱️ Persiapan selesai dalam ${durationMin} menit.\n` +
      (viewerUp
        ? '🖥️ Monitor sudah aktif — klik tombol di bawah untuk melihat proses Windows Setup.\n\n'
        : '⏳ Monitor sedang disiapkan, coba buka 2-3 menit lagi.\n\n') +
      `⚠️ *Windows Setup masih berjalan di dalam VPS.* Tunggu sampai selesai ` +
      `(10 menit - 1 jam) sebelum connect via RDP. Baca FAQ di menu utama.`,
      {
        chat_id: chatId,
        message_id: session.messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🖥️ Monitor Installation', url: `http://${session.ip}:8006` }],
            [{ text: '« Kembali ke Menu', callback_data: 'back_to_menu' }]
          ]
        }
      }
    );
  } catch (error) {
    // Instalasi SUDAH sukses; yang gagal cuma penagihan/penyampaian pesan.
    // Jangan pernah bilang "instalasi gagal" di sini.
    console.error(`[POST-INSTALL] chat=${chatId} ip=${session.ip} error=${error.message}`);
    await safeSend(bot, chatId,
      `✅ Instalasi Windows berhasil dimulai di ${session.ip}.\n\n` +
      `Username: admin\nPassword: ${session.rdpPassword}\n` +
      `Monitor: http://${session.ip}:8006\n\n` +
      `Terjadi kendala saat menampilkan detail lengkap. Hubungi admin bila perlu.`);
  } finally {
    activeInstalls.delete(chatId);
    session.step = 'done';
    userSessions.delete(chatId);
  }
}

/**
 * Kegagalan instalasi.
 * Saldo belum dipotong pada titik ini, tapi refund tetap dipanggil sebagai
 * jaring pengaman kalau alur berubah di kemudian hari.
 */
async function handleInstallFailure(bot, chatId, session, error) {
  const raw = String(error?.message || 'Unknown error');
  const code = raw.includes(':') ? raw.split(':')[0] : raw;
  const detail = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : '';

  console.error(`[INSTALL FAIL] chat=${chatId} ip=${session.ip} code=${code} detail=${detail}`);

  if (session.charged) {
    await refundBalance(chatId, INSTALLATION_COST, 'refund_install_failed');
    session.charged = false;
  }

  await updateInstallation(session.installationId, 'failed', `${code}: ${detail}`.slice(0, 500));

  const hints = {
    PREP_DOWNLOAD_FAILED: 'VPS tidak bisa mengunduh script installer. Cek koneksi internet VPS.',
    PREP_DOWNLOAD_HTML: 'Server script sedang bermasalah. Coba lagi beberapa saat lagi atau hubungi admin.',
    PREP_SCRIPT_TOO_SMALL: 'Script installer yang terunduh rusak. Hubungi admin.',
    PREP_INCOMPLETE: 'Persiapan VPS terputus di tengah jalan.',
    LAUNCH_FAILED: 'Installer tidak bisa dijalankan di VPS.',
    INSTALL_VANISHED: 'Proses berhenti mendadak — biasanya VPS kehabisan RAM atau disk.',
    INSTALL_TIMEOUT: 'Instalasi melewati 90 menit. Kemungkinan VPS terlalu lambat.',
    VPS_UNREACHABLE: 'VPS tidak bisa dihubungi terlalu lama saat instalasi.',
    INSTALL_FAILED: 'Script installer berhenti dengan error.',
    EXEC_TIMEOUT: 'VPS berhenti merespons perintah.'
  };

  const hint = hints[code] || detail || raw;

  await safeEdit(bot,
    `❌ *Instalasi gagal*\n\n` +
    `${escapeMd(String(hint).slice(0, 600))}\n\n` +
    `💰 *Saldo Anda TIDAK terpotong.*\n\n` +
    `Kalau terus gagal, hubungi admin di wa.me/6285173329868`,
    {
      chat_id: chatId,
      message_id: session.messageId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🔄 Coba Lagi', callback_data: 'retry_install' },
          { text: '« Menu', callback_data: 'back_to_menu' }
        ]]
      }
    }
  );
}

async function notifyAdmin(bot, text) {
  const adminId = (process.env.ADMIN_ID || '').split(',')[0].trim();
  if (!adminId) return;
  await safeSend(bot, adminId, text);
}

/* =========================================================================
 * Navigasi & pembatalan
 * ========================================================================= */
async function handlePageNavigation(bot, query, userSessions) {
  const chatId = query.message.chat.id;
  const page = parseInt(query.data.split('_')[1], 10) || 0;
  await showWindowsSelection(bot, chatId, query.message.message_id, page, userSessions);
}

async function handleCancelInstallation(bot, query, userSessions) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const session = userSessions.get(chatId);

  // Instalasi yang sudah berjalan di VPS tidak bisa dibatalkan dari sini.
  // Menghapus session hanya akan membuat bot "lupa", sementara prosesnya jalan
  // terus — dan itu dulu bisa dipakai untuk mendapat RDP kedua secara gratis.
  if (isInstalling(chatId)) {
    await safeEdit(bot,
      '⏳ *Instalasi sedang berjalan dan tidak bisa dibatalkan.*\n\n' +
      'Tunggu sampai selesai — hasilnya akan dikirim ke chat ini.',
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '« Kembali', callback_data: 'back_to_menu' }]]
        }
      }
    );
    return;
  }

  // Kalau saldo sudah sempat terpotong (alur lama / kasus tepi), kembalikan.
  if (session?.charged) {
    await refundBalance(chatId, INSTALLATION_COST, 'refund_cancelled');
  }
  if (session?.installationId) {
    await updateInstallation(session.installationId, 'cancelled');
  }

  userSessions.delete(chatId);

  await safeEdit(bot, '❌ Instalasi dibatalkan.\n\n💰 _Saldo Anda tidak terpotong._', {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: '« Kembali ke Menu', callback_data: 'back_to_menu' }]]
    }
  });
}

module.exports = {
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
};
