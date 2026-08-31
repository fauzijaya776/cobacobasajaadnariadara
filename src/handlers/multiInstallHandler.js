/**
 * Multi-install RDP: pasang Windows ke BEBERAPA VPS sekaligus dalam satu batch.
 *
 * Alur:
 *   daftar VPS (banyak baris)  ->  pilih 1 versi Windows  ->  password RDP
 *                              ->  semua VPS dipasang PARALEL
 *
 * Biaya: Rp1.000 PER VPS yang berhasil (bukan flat). Saldo dicek di depan untuk
 * seluruh batch, lalu dipotong satu per satu tiap VPS sukses — VPS yang gagal
 * atau spesifikasinya kurang tidak menambah potongan.
 *
 * Tiap baris VPS ditulis: `IP[:PORT] PASSWORD` atau `user@IP:PORT PASSWORD`
 * (target dulu, spasi, lalu password SSH-nya).
 */
const { INSTALLATION_COST } = require('../config/constants');
const {
  WINDOWS_VERSIONS,
  isVersionCompatible,
  findVersion
} = require('../config/windows');

const ssh = require('../utils/ssh');
const { checkVPSSupport } = require('../utils/vpsChecker');
const { detectVPSSpecs } = require('../utils/vpsSpecs');
const { installRDP } = require('../utils/rdpInstaller');
const { calculateAllocation } = require('../utils/specFormatter');
const { parseVpsInput, resolveSSHPort } = require('../utils/vpsTarget');
const {
  hasSufficientBalance,
  deductBalance,
  isAdmin,
  recordInstallation,
  updateInstallation
} = require('../utils/userManager');
const installLock = require('../utils/installLock');
const { isValidRdpPassword, RDP_PASSWORD_RULE } = require('../utils/password');
const { safeEdit, safeDelete, escapeMd } = require('../utils/telegram');

// Batas minimal VPS (samakan dengan install satuan).
const MIN_CPU = 2;
const MIN_RAM = 4;
const MIN_STORAGE = 25;
const MAX_TARGETS = 10;

/** Langkah-langkah alur ini (dipakai index untuk mengenali sesi). */
const MULTI_STEPS = new Set([
  'multi_waiting_targets',
  'multi_selecting_windows',
  'multi_waiting_rdp_password',
  'multi_installing'
]);

const cancelRow = [{ text: '« Batal', callback_data: 'multi_cancel' }];

/* ========================================================================= */
/* Mulai                                                                      */
/* ========================================================================= */
async function startMultiInstall(bot, chatId, messageId, userSessions) {
  if (installLock.isLocked(chatId)) {
    await safeEdit(bot,
      '⏳ Masih ada instalasi Anda yang berjalan. Tunggu selesai dulu ya.',
      {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'back_to_menu' }]] }
      });
    return;
  }

  // Minimal cukup untuk 1 VPS; total per-batch dicek setelah tahu jumlahnya.
  const cukup = await hasSufficientBalance(chatId, INSTALLATION_COST);
  if (!cukup) {
    await safeEdit(bot,
      `❌ Saldo tidak mencukupi.\n\n` +
      `Biaya multi-install: Rp ${INSTALLATION_COST.toLocaleString('id-ID')} per VPS.\n` +
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
      });
    return;
  }

  await safeEdit(bot, buildTargetsPrompt(), {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [cancelRow] }
  });

  userSessions.set(chatId, {
    flow: 'multi',
    step: 'multi_waiting_targets',
    messageId,
    startTime: Date.now(),
    lastActivity: Date.now()
  });
}

function buildTargetsPrompt(errorNote = null) {
  return (
    '🖥️ *Multi Install RDP*\n\n' +
    `Biaya: *Rp ${INSTALLATION_COST.toLocaleString('id-ID')} per VPS* yang berhasil (maks ${MAX_TARGETS} VPS/batch).\n\n` +
    '📋 *Kirim daftar VPS, satu per baris:*\n' +
    '```\n' +
    'IP:PORT PASSWORD\n' +
    '```\n' +
    'Contoh:\n' +
    '`123.45.67.89 RahasiaVPS1`\n' +
    '`98.76.54.32:2222 Passwordku22`\n' +
    '`ubuntu@1.2.3.4:22 SandiUbuntu`\n\n' +
    '_Format tiap baris: target lalu spasi lalu password SSH-nya. ' +
    'Port boleh dikosongkan (dideteksi otomatis). Pesan Anda dihapus otomatis._' +
    (errorNote ? `\n\n❌ ${errorNote}` : '')
  );
}

/* ========================================================================= */
/* Input teks (daftar VPS & password RDP)                                    */
/* ========================================================================= */
async function handleMultiText(bot, msg, userSessions) {
  const chatId = msg.chat.id;
  const session = userSessions.get(chatId);
  if (!session || session.flow !== 'multi') return;

  session.lastActivity = Date.now();
  // Berisi kredensial VPS — hapus secepatnya.
  await safeDelete(bot, chatId, msg.message_id);

  if (session.step === 'multi_waiting_targets') {
    return handleTargetsInput(bot, chatId, msg.text, session, userSessions);
  }
  if (session.step === 'multi_waiting_rdp_password') {
    return handleRdpPasswordInput(bot, chatId, msg.text, session, userSessions);
  }
}

function parseTargetLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null; // baris kosong diabaikan

  const spaceIdx = trimmed.search(/\s/);
  if (spaceIdx === -1) return { error: 'Tidak ada password', raw: trimmed };

  const targetPart = trimmed.slice(0, spaceIdx).trim();
  const password = trimmed.slice(spaceIdx + 1).trim();
  if (!password) return { error: 'Password kosong', raw: trimmed };

  const parsed = parseVpsInput(targetPart);
  if (parsed.error) return { error: `Format target salah (${parsed.error})`, raw: trimmed };

  return {
    ip: parsed.ip,
    port: parsed.port,
    username: parsed.username || 'root',
    password,
    raw: targetPart
  };
}

async function handleTargetsInput(bot, chatId, text, session, userSessions) {
  const lines = String(text || '').split('\n');
  const valid = [];
  const errors = [];

  for (const line of lines) {
    const parsed = parseTargetLine(line);
    if (parsed === null) continue;
    if (parsed.error) { errors.push(`• \`${escapeMd(parsed.raw)}\` — ${parsed.error}`); continue; }
    valid.push(parsed);
  }

  if (valid.length === 0) {
    await safeEdit(bot, buildTargetsPrompt('Tidak ada baris VPS yang valid. Cek formatnya.'), {
      chat_id: chatId,
      message_id: session.messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [cancelRow] }
    });
    return;
  }

  if (valid.length > MAX_TARGETS) {
    await safeEdit(bot, buildTargetsPrompt(`Maksimal ${MAX_TARGETS} VPS per batch. Anda mengirim ${valid.length}.`), {
      chat_id: chatId,
      message_id: session.messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [cancelRow] }
    });
    return;
  }

  // Cek saldo untuk SELURUH batch di depan, supaya tidak ada VPS yang terlanjur
  // terpasang tapi tak bisa ditagih.
  const needed = valid.length * INSTALLATION_COST;
  const cukup = await hasSufficientBalance(chatId, needed);
  if (!cukup && !isAdmin(chatId)) {
    await safeEdit(bot,
      `❌ Saldo tidak cukup untuk ${valid.length} VPS.\n\n` +
      `Butuh: Rp ${needed.toLocaleString('id-ID')} (Rp ${INSTALLATION_COST.toLocaleString('id-ID')} × ${valid.length})\n` +
      `Kurangi jumlah VPS atau deposit dulu.`,
      {
        chat_id: chatId,
        message_id: session.messageId,
        reply_markup: {
          inline_keyboard: [[
            { text: '💰 Deposit', callback_data: 'deposit' },
            { text: '« Batal', callback_data: 'multi_cancel' }
          ]]
        }
      });
    return;
  }

  session.targets = valid;
  session.step = 'multi_selecting_windows';
  userSessions.set(chatId, session);

  const warn = errors.length
    ? `\n\n⚠️ ${errors.length} baris dilewati:\n${errors.slice(0, 5).join('\n')}`
    : '';

  await showMultiWindows(bot, chatId, session, 0, warn);
}

/* ========================================================================= */
/* Pemilihan Windows (semua versi; kecocokan dicek per-VPS saat instalasi)    */
/* ========================================================================= */
async function showMultiWindows(bot, chatId, session, page = 0, extraNote = '') {
  const itemsPerPage = 6;
  const totalPages = Math.ceil(WINDOWS_VERSIONS.length / itemsPerPage);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * itemsPerPage;
  const pageItems = WINDOWS_VERSIONS.slice(start, start + itemsPerPage);

  let text = `🪟 *Pilih Versi Windows* (dipasang ke ${session.targets.length} VPS)\n`;
  const desktop = pageItems.filter((v) => v.category === 'desktop');
  const server = pageItems.filter((v) => v.category === 'server');
  if (desktop.length) {
    text += '\n📱 *Desktop:*\n';
    desktop.forEach((v) => { text += `${v.id}. ${v.name}\n`; });
  }
  if (server.length) {
    text += '\n🖥️ *Server:*\n';
    server.forEach((v) => { text += `${v.id}. ${v.name}\n`; });
  }
  text += `\nHalaman ${safePage + 1}/${totalPages}`;
  text += '\n_VPS yang spesifikasinya tidak muat untuk versi ini akan dilewati otomatis (tidak ditagih)._';
  text += extraNote;

  const keyboard = [];
  for (let i = 0; i < pageItems.length; i += 2) {
    const row = [{ text: `${pageItems[i].id}. ${pageItems[i].name}`, callback_data: `multi_win_${pageItems[i].id}` }];
    if (pageItems[i + 1]) {
      row.push({ text: `${pageItems[i + 1].id}. ${pageItems[i + 1].name}`, callback_data: `multi_win_${pageItems[i + 1].id}` });
    }
    keyboard.push(row);
  }
  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️ Sebelumnya', callback_data: `multi_page_${safePage - 1}` });
  if (start + itemsPerPage < WINDOWS_VERSIONS.length) nav.push({ text: 'Selanjutnya ➡️', callback_data: `multi_page_${safePage + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push(cancelRow);

  await safeEdit(bot, text, {
    chat_id: chatId,
    message_id: session.messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

/* ========================================================================= */
/* Callback                                                                   */
/* ========================================================================= */
async function handleMultiCallback(bot, query, userSessions) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data; // diawali 'multi_'
  const action = data.slice(6);

  if (action === 'start') {
    return startMultiInstall(bot, chatId, messageId, userSessions);
  }
  if (action === 'cancel') {
    // Batch yang sudah berjalan tidak bisa dibatalkan (proses hidup di VPS).
    if (installLock.isLocked(chatId)) {
      await safeEdit(bot,
        '⏳ Batch instalasi sedang berjalan dan tidak bisa dibatalkan. Hasilnya akan dilaporkan di sini.',
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'back_to_menu' }]] }
        });
      return;
    }
    userSessions.delete(chatId);
    await safeEdit(bot, '❌ Multi-install dibatalkan.\n\n💰 _Saldo Anda tidak terpotong._', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Kembali ke Menu', callback_data: 'back_to_menu' }]] }
    });
    return;
  }

  const session = userSessions.get(chatId);
  if (!session || session.flow !== 'multi') {
    await safeEdit(bot, '❌ Sesi kadaluarsa. Mulai lagi dari menu ya.\n\n💰 _Saldo Anda tidak terpotong._', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Menu', callback_data: 'back_to_menu' }]] }
    });
    return;
  }
  session.lastActivity = Date.now();
  session.messageId = messageId;

  if (action.startsWith('page_')) {
    const page = parseInt(action.slice(5), 10) || 0;
    return showMultiWindows(bot, chatId, session, page);
  }

  if (action.startsWith('win_')) {
    if (installLock.isLocked(chatId)) return;
    const selected = findVersion(action.slice(4));
    if (!selected) return;
    session.windowsVersion = selected;
    session.step = 'multi_waiting_rdp_password';
    userSessions.set(chatId, session);
    await safeEdit(bot, buildRdpPasswordPrompt(session), {
      chat_id: chatId,
      message_id: session.messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Pilih Ulang', callback_data: 'multi_page_0' }], cancelRow] }
    });
    return;
  }
}

function buildRdpPasswordPrompt(session, errorNote = null) {
  return (
    '📝 *Konfigurasi Multi-Install*\n\n' +
    `🪟 Windows: ${escapeMd(session.windowsVersion.name)}\n` +
    `🖥️ Jumlah VPS: ${session.targets.length}\n` +
    `💰 Estimasi biaya: s/d Rp ${(session.targets.length * INSTALLATION_COST).toLocaleString('id-ID')} ` +
    `(Rp ${INSTALLATION_COST.toLocaleString('id-ID')} × VPS yang berhasil)\n\n` +
    '🔑 *Masukkan password RDP Windows:*\n' +
    `_${RDP_PASSWORD_RULE}. Dipakai untuk semua VPS._\n` +
    'Contoh: `Fauzi2024`' +
    (errorNote ? `\n\n❌ ${errorNote}` : '')
  );
}

async function handleRdpPasswordInput(bot, chatId, text, session, userSessions) {
  const password = String(text || '');
  if (!isValidRdpPassword(password)) {
    await safeEdit(bot, buildRdpPasswordPrompt(session, RDP_PASSWORD_RULE), {
      chat_id: chatId,
      message_id: session.messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Pilih Ulang', callback_data: 'multi_page_0' }], cancelRow] }
    });
    return;
  }

  session.rdpPassword = password;
  session.step = 'multi_installing';
  userSessions.set(chatId, session);
  await runBatch(bot, chatId, session, userSessions);
}

/* ========================================================================= */
/* Eksekusi batch (paralel)                                                  */
/* ========================================================================= */
const STATUS_EMOJI = {
  queued: '⏳',
  checking: '🔍',
  installing: '🔄',
  success: '✅',
  failed: '❌',
  skipped: '⚠️'
};

function friendlyError(error) {
  const raw = String((error && error.message) || error || 'Error');
  const code = raw.includes(':') ? raw.split(':')[0] : raw;
  const map = {
    SSH_AUTH: 'Password SSH salah',
    SSH_RESET: 'Koneksi diputus VPS',
    SSH_TIMEOUT: 'VPS tidak merespons',
    SSH_REFUSED: 'Koneksi SSH ditolak',
    SSH_DNS: 'IP tidak ditemukan',
    SSH_HANDSHAKE: 'OS terlalu lama (SSH tak cocok)',
    SPEC_INCOMPLETE: 'Gagal baca spesifikasi',
    SPEC_PARSE: 'Gagal baca spesifikasi',
    KVM_CHECK_INCOMPLETE: 'Gagal cek KVM',
    PREP_DOWNLOAD_FAILED: 'VPS gagal unduh installer',
    PREP_DOWNLOAD_HTML: 'Server script bermasalah',
    PREP_INCOMPLETE: 'Persiapan terputus',
    LAUNCH_FAILED: 'Installer gagal dijalankan',
    INSTALL_VANISHED: 'Proses berhenti (RAM/disk?)',
    INSTALL_TIMEOUT: 'Melewati batas waktu',
    VPS_UNREACHABLE: 'VPS hilang saat instalasi',
    INSTALL_FAILED: 'Installer berhenti dengan error',
    EXEC_TIMEOUT: 'VPS berhenti merespons'
  };
  return map[code] || (raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw).slice(0, 60);
}

function renderBatch(session, states, done = false) {
  const lines = states.map((s) => {
    const emoji = STATUS_EMOJI[s.status] || '⏳';
    let detail;
    if (s.status === 'installing') detail = `${s.percent || 0}%${s.note ? ` · ${escapeMd(s.note)}` : ''}`;
    else if (s.status === 'success') detail = 'selesai';
    else if (s.status === 'failed' || s.status === 'skipped') detail = escapeMd(s.note || '-');
    else if (s.status === 'checking') detail = 'cek spesifikasi';
    else detail = 'antre';
    return `${emoji} \`${escapeMd(s.ip)}\` — ${detail}`;
  });

  const sukses = states.filter((s) => s.status === 'success').length;
  const gagal = states.filter((s) => s.status === 'failed').length;
  const lewat = states.filter((s) => s.status === 'skipped').length;

  const header = done
    ? '📊 *Multi-Install Selesai*'
    : `🔄 *Multi-Install berjalan* (${session.windowsVersion.name})`;

  let footer;
  if (done) {
    const totalCharged = states.filter((s) => s.charged).length * INSTALLATION_COST;
    footer =
      `\n\n✅ Berhasil: ${sukses}   ❌ Gagal: ${gagal}   ⚠️ Dilewati: ${lewat}\n` +
      `💰 Total dipotong: Rp ${totalCharged.toLocaleString('id-ID')}\n` +
      (sukses > 0
        ? `\n👤 User: \`admin\`  🔑 Password: \`${escapeMd(session.rdpPassword)}\`\n` +
          `_Monitor tiap VPS: http://<IP>:8006 — tunggu Windows Setup selesai sebelum connect RDP._`
        : '');
  } else {
    footer = '\n\n_Boleh tutup chat ini. Proses tetap jalan; laporan akhir dikirim ke sini._';
  }

  return `${header}\n\n${lines.join('\n')}${footer}`;
}

async function installOne(state, windowsVersion, rdpPassword, chatId) {
  state.status = 'checking';

  // 1. Tentukan port SSH.
  let resolved;
  try {
    resolved = await resolveSSHPort(state.ip, state.port);
  } catch (_) {
    resolved = { port: null };
  }
  if (!resolved.port) { state.status = 'failed'; state.note = 'Port SSH tak ditemukan'; return; }

  const target = { host: state.ip, port: resolved.port, username: state.username, password: state.password };

  // 2. Baca spesifikasi + dukungan KVM (satu koneksi).
  let rawSpecs, kvm, allocation;
  let conn;
  try {
    conn = await ssh.connectWithRetry(target, { percobaan: 3 });
    rawSpecs = await detectVPSSpecs(conn);
    kvm = await checkVPSSupport(conn);
    allocation = calculateAllocation(rawSpecs);
  } catch (error) {
    state.status = 'failed';
    state.note = friendlyError(error);
    try { if (conn) conn.end(); } catch (_) {}
    return;
  }
  try { conn.end(); } catch (_) {}

  // 3. Cek minimal & kecocokan versi Windows.
  if (rawSpecs.cpu < MIN_CPU || allocation.ram < MIN_RAM || allocation.storage < MIN_STORAGE) {
    state.status = 'skipped';
    state.note = `Spek kurang (${rawSpecs.cpu}C/${allocation.ram}GB/${allocation.storage}GB)`;
    return;
  }
  if (!isVersionCompatible(windowsVersion, allocation)) {
    state.status = 'skipped';
    state.note = `${windowsVersion.name} tidak muat`;
    return;
  }

  // 4. Catat & pasang.
  const installationId = await recordInstallation(chatId, {
    ip: state.ip,
    sshPort: resolved.port,
    windowsId: windowsVersion.id,
    windowsName: windowsVersion.name,
    cost: INSTALLATION_COST,
    status: 'running',
    batch: true
  });

  const config = {
    windowsId: windowsVersion.id,
    cpu: allocation.cpu,
    ram: allocation.ram,
    storage: allocation.storage,
    swap: allocation.swap,
    password: rdpPassword,
    isArm: rawSpecs.isArm,
    supportsKvm: kvm.supported
  };

  state.status = 'installing';
  state.percent = 0;

  try {
    await installRDP(target, config, {
      onProgress: (p) => {
        state.percent = p.percent;
        state.note = p.note || '';
      }
    });
    state.status = 'success';
    state.percent = 100;

    // Potong Rp1.000 hanya untuk VPS yang benar-benar sukses.
    if (!isAdmin(chatId)) {
      const charged = await deductBalance(chatId, INSTALLATION_COST);
      state.charged = charged;
      if (!charged) {
        console.error(`[MULTI BILLING] Gagal memotong saldo user ${chatId} untuk ${state.ip}.`);
      }
    } else {
      state.charged = false; // admin unlimited, tidak dipotong
    }
    await updateInstallation(installationId, state.charged || isAdmin(chatId) ? 'success' : 'success_uncharged');
  } catch (error) {
    state.status = 'failed';
    state.note = friendlyError(error);
    await updateInstallation(installationId, 'failed', String(error && error.message).slice(0, 300));
  }
}

async function runBatch(bot, chatId, session, userSessions) {
  installLock.lock(chatId);

  const states = session.targets.map((t) => ({
    ip: t.ip,
    port: t.port,
    username: t.username,
    password: t.password,
    status: 'queued',
    percent: 0,
    note: '',
    charged: false
  }));

  await safeEdit(bot, renderBatch(session, states), {
    chat_id: chatId,
    message_id: session.messageId,
    parse_mode: 'Markdown'
  });

  // Perbarui tampilan berkala (dibatasi agar tidak kena rate limit Telegram).
  // `finished` mencegah tick terakhir menimpa laporan "Selesai" (race saat
  // Promise.all beres tepat di sekitar batas interval).
  let finished = false;
  const renderer = setInterval(() => {
    if (finished) return;
    safeEdit(bot, renderBatch(session, states), {
      chat_id: chatId,
      message_id: session.messageId,
      parse_mode: 'Markdown'
    }).catch(() => {});
  }, 20000);

  try {
    await Promise.all(
      states.map((s) => installOne(s, session.windowsVersion, session.rdpPassword, chatId)
        .catch((err) => { s.status = 'failed'; s.note = friendlyError(err); }))
    );
  } finally {
    finished = true;
    clearInterval(renderer);
    installLock.unlock(chatId);
  }

  await safeEdit(bot, renderBatch(session, states, true), {
    chat_id: chatId,
    message_id: session.messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '« Kembali ke Menu', callback_data: 'back_to_menu' }]] }
  });

  session.step = 'done';
  userSessions.delete(chatId);
}

module.exports = {
  MULTI_STEPS,
  startMultiInstall,
  handleMultiText,
  handleMultiCallback
};
