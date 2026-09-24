/**
 * Fitur "☁️ Control DO via API" — kelola akun DigitalOcean milik buyer.
 *
 * Buyer memasukkan Personal Access Token DigitalOcean-nya sendiri, lalu bisa:
 *   • ➕ Buat droplet (1-10 sekaligus)      — biaya layanan Rp1.000 flat/batch
 *   • 📋 Lihat daftar & detail droplet      — gratis
 *   • 🟢 Nyalakan / 🔴 Matikan / 🔄 Reboot / ⚡ Power cycle — gratis
 *   • 🔑 Reset password root / 📸 Snapshot   — gratis
 *   • 🗑️ Hapus droplet (dengan konfirmasi)  — gratis
 *   • 💵 Lihat pemakaian tagihan bulan ini
 *
 * KEAMANAN TOKEN: token disimpan HANYA di memori proses (Map di bawah), tidak
 * pernah ditulis ke file/cadangan. Hilang otomatis setelah 60 menit tidak
 * dipakai, saat user menekan "Putuskan", atau saat bot restart. Pesan berisi
 * token langsung dihapus dari chat.
 *
 * Tagihan sewa droplet ditanggung akun DigitalOcean milik buyer sendiri.
 */
const { VPS_CREATE_COST } = require('../config/constants');
const {
  DO_REGIONS,
  DO_SIZES,
  DO_IMAGES,
  findRegion,
  findSize,
  findImage,
  validateToken,
  createDroplets,
  waitForDroplets,
  genPassword,
  listDroplets,
  getDropletInfo,
  dropletAction,
  deleteDroplet,
  getBalance,
  describeError,
  DROPLET_ACTIONS
} = require('../utils/digitalocean');
const {
  hasSufficientBalance,
  deductBalance,
  isAdmin
} = require('../utils/userManager');
const { isValidVpsPassword, VPS_PASSWORD_RULE, VPS_SYMBOLS } = require('../utils/password');
const { safeEdit, safeSend, safeDelete, escapeMd, mdCode, mdBold, mdItalic } = require('../utils/telegram');

const MAX_DROPLETS = 10;
const LIST_PER_PAGE = 8;
const TOKEN_IDLE_MS = 60 * 60 * 1000;

/** Langkah-langkah alur ini (dipakai index untuk mengenali sesi). */
const DO_STEPS = new Set([
  'do_waiting_token',
  'do_selecting_region',
  'do_selecting_size',
  'do_selecting_image',
  'do_selecting_count',
  'do_waiting_password',
  'do_creating'
]);

/* ========================================================================= */
/* Penyimpanan token (memori saja)                                           */
/* ========================================================================= */
const doAuth = new Map(); // chatId -> { token, email, status, dropletLimit, scoped, lastUsed }

function getAuth(chatId) {
  const a = doAuth.get(chatId);
  if (!a) return null;
  if (Date.now() - a.lastUsed > TOKEN_IDLE_MS) {
    doAuth.delete(chatId);
    return null;
  }
  a.lastUsed = Date.now();
  return a;
}

const cleaner = setInterval(() => {
  const now = Date.now();
  for (const [chatId, a] of doAuth.entries()) {
    if (now - a.lastUsed > TOKEN_IDLE_MS) doAuth.delete(chatId);
  }
}, 10 * 60 * 1000);
if (cleaner.unref) cleaner.unref();

/* ========================================================================= */
/* Util tampilan                                                              */
/* ========================================================================= */
const STATUS_ICON = { active: '🟢', off: '🔴', new: '🟡', archive: '⚫' };
const statusIcon = (s) => STATUS_ICON[s] || '⚪';
const STATUS_TEXT = { active: 'Menyala', off: 'Mati', new: 'Sedang dibuat', archive: 'Diarsipkan' };

const btnMenuDO = { text: '« Menu DO', callback_data: 'do_menu' };
const btnMainMenu = { text: '🏠 Menu Utama', callback_data: 'back_to_menu' };
const cancelCreateRow = [{ text: '« Batal', callback_data: 'do_cancel' }];

/** Pesan galat DigitalOcean yang ramah ("KODE:penjelasan" → penjelasan). */
function humanError(error) {
  const raw = error && error.message && /^DO_/.test(error.message) ? error.message : describeError(error);
  return raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
}

function isAuthError(error) {
  return Boolean(error && error.response && error.response.status === 401);
}

async function edit(bot, chatId, messageId, text, keyboard) {
  return safeEdit(bot, text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard }
  });
}

/** Token dicabut / kedaluwarsa di tengah jalan → minta token lagi. */
async function handleAuthLost(bot, chatId, messageId, userSessions) {
  doAuth.delete(chatId);
  return promptToken(bot, chatId, messageId, userSessions,
    'Token DigitalOcean tidak valid lagi (dicabut atau kedaluwarsa). Kirim token baru.');
}

/* ========================================================================= */
/* Mulai & token                                                             */
/* ========================================================================= */
async function startDO(bot, chatId, messageId, userSessions) {
  if (getAuth(chatId)) return showDoMenu(bot, chatId, messageId, userSessions);
  return promptToken(bot, chatId, messageId, userSessions);
}

async function promptToken(bot, chatId, messageId, userSessions, errorNote = null) {
  userSessions.set(chatId, {
    flow: 'do',
    step: 'do_waiting_token',
    messageId,
    startTime: Date.now(),
    lastActivity: Date.now()
  });
  await edit(bot, chatId, messageId, buildTokenPrompt(errorNote), [[btnMainMenu]]);
}

function buildTokenPrompt(errorNote = null) {
  return (
    '☁️ *Control DigitalOcean via API*\n\n' +
    'Kelola akun DigitalOcean Anda langsung dari Telegram:\n' +
    `• ➕ Buat droplet 1-${MAX_DROPLETS} sekaligus (biaya layanan *Rp ${VPS_CREATE_COST.toLocaleString('id-ID')}* flat per batch)\n` +
    '• 📋 Lihat daftar & detail droplet\n' +
    '• 🟢 Nyalakan · 🔴 Matikan · 🔄 Reboot · ⚡ Power cycle\n' +
    '• 🔑 Reset password root · 📸 Snapshot · 🗑️ Hapus droplet\n' +
    '• 💵 Cek pemakaian tagihan bulan ini\n' +
    '_Selain membuat droplet, semua fitur gratis. Sewa droplet ditagih DigitalOcean ke akun Anda._\n\n' +
    '🔑 *Kirim Personal Access Token DigitalOcean Anda.*\n' +
    'Cara ambil token:\n' +
    '1. Buka cloud.digitalocean.com → API → Tokens\n' +
    '2. Generate New Token, centang scope *Write* (Full Access)\n' +
    '3. Salin lalu kirim ke sini\n\n' +
    '🔒 _Pesan token langsung dihapus. Token hanya disimpan sementara di memori bot ' +
    '(hilang setelah 60 menit tidak dipakai), tidak pernah disimpan ke file._' +
    (errorNote ? `\n\n❌ ${escapeMd(errorNote)}` : '')
  );
}

/* ========================================================================= */
/* Input teks (token & password root)                                        */
/* ========================================================================= */
async function handleDOText(bot, msg, userSessions) {
  const chatId = msg.chat.id;
  const session = userSessions.get(chatId);
  if (!session || session.flow !== 'do') return;

  session.lastActivity = Date.now();
  // Isi pesan mengandung rahasia (token / password) — hapus secepatnya.
  await safeDelete(bot, chatId, msg.message_id);

  if (session.step === 'do_waiting_token') {
    return handleTokenInput(bot, chatId, msg.text, session, userSessions);
  }
  if (session.step === 'do_waiting_password') {
    return handlePasswordInput(bot, chatId, msg.text, session, userSessions);
  }
}

async function handleTokenInput(bot, chatId, text, session, userSessions) {
  const token = String(text || '').trim();
  if (!token || token.length < 20 || /\s/.test(token)) {
    await edit(bot, chatId, session.messageId,
      buildTokenPrompt('Token terlalu pendek / tidak valid. Salin ulang token DigitalOcean Anda.'),
      [[btnMainMenu]]);
    return;
  }

  await safeEdit(bot, '🔍 Memeriksa token DigitalOcean...', {
    chat_id: chatId,
    message_id: session.messageId
  });

  const check = await validateToken(token);
  if (!check.ok) {
    const detail = String(check.error || '').split(':').slice(1).join(':') || 'Token ditolak.';
    await edit(bot, chatId, session.messageId, buildTokenPrompt(detail), [[btnMainMenu]]);
    return;
  }

  doAuth.set(chatId, {
    token,
    email: check.email || null,
    status: check.status || null,
    dropletLimit: check.dropletLimit,
    scoped: check.scoped,
    lastUsed: Date.now()
  });

  // Sesi input token selesai; menu DO tidak butuh sesi.
  if (userSessions.get(chatId) === session) userSessions.delete(chatId);
  await showDoMenu(bot, chatId, session.messageId, userSessions, '✅ Token valid, akun terhubung.');
}

/* ========================================================================= */
/* Menu DO                                                                    */
/* ========================================================================= */
async function showDoMenu(bot, chatId, messageId, userSessions, note = null) {
  const auth = getAuth(chatId);
  if (!auth) return promptToken(bot, chatId, messageId, userSessions);

  await safeEdit(bot, '⏳ Memuat data akun DigitalOcean...', { chat_id: chatId, message_id: messageId });

  let total = null;
  try {
    total = (await listDroplets(auth.token, { page: 1, perPage: 1 })).total;
  } catch (error) {
    if (isAuthError(error)) return handleAuthLost(bot, chatId, messageId, userSessions);
    total = null;
  }
  const bill = await getBalance(auth.token);

  const lines = ['☁️ *Control DigitalOcean via API*', ''];
  if (note) lines.push(note, '');
  lines.push(`👤 Akun: ${auth.email ? `\`${mdCode(auth.email)}\`` : '_(token scope terbatas)_'}` +
    (auth.status ? ` · ${escapeMd(auth.status)}` : ''));
  lines.push(`🖥️ Droplet: ${total == null ? '-' : total}${auth.dropletLimit ? ` / ${auth.dropletLimit}` : ''}`);
  if (bill && bill.monthToDateUsage != null) {
    lines.push(`💵 Pemakaian bulan ini: $${bill.monthToDateUsage.toFixed(2)}`);
  }
  lines.push('', 'Pilih tindakan:');

  await edit(bot, chatId, messageId, lines.join('\n'), [
    [
      { text: '➕ Buat Droplet', callback_data: 'do_new' },
      { text: '📋 Daftar Droplet', callback_data: 'do_list_1' }
    ],
    [
      { text: '🔄 Muat Ulang', callback_data: 'do_menu' },
      { text: '🔌 Putuskan Token', callback_data: 'do_logout' }
    ],
    [btnMainMenu]
  ]);
}

/* ========================================================================= */
/* Daftar & detail droplet                                                   */
/* ========================================================================= */
async function showDropletList(bot, chatId, messageId, userSessions, page = 1) {
  const auth = getAuth(chatId);
  if (!auth) return promptToken(bot, chatId, messageId, userSessions);

  await safeEdit(bot, '⏳ Memuat daftar droplet...', { chat_id: chatId, message_id: messageId });

  let res;
  try {
    res = await listDroplets(auth.token, { page, perPage: LIST_PER_PAGE });
  } catch (error) {
    if (isAuthError(error)) return handleAuthLost(bot, chatId, messageId, userSessions);
    return edit(bot, chatId, messageId,
      `❌ Gagal memuat daftar droplet.\n\n${escapeMd(humanError(error))}`,
      [[{ text: '🔄 Coba Lagi', callback_data: `do_list_${page}` }, btnMenuDO]]);
  }

  const totalPages = Math.max(1, Math.ceil(res.total / LIST_PER_PAGE));
  if (res.droplets.length === 0 && page > 1) {
    return showDropletList(bot, chatId, messageId, userSessions, 1);
  }

  if (res.droplets.length === 0) {
    return edit(bot, chatId, messageId,
      '📋 *Daftar Droplet*\n\nBelum ada droplet di akun ini.',
      [[{ text: '➕ Buat Droplet', callback_data: 'do_new' }], [btnMenuDO]]);
  }

  const keyboard = res.droplets.map((d) => ([{
    text: `${statusIcon(d.status)} ${String(d.name).slice(0, 28)} · ${d.ip || 'belum ada IP'}`,
    callback_data: `do_dp_${d.id}`
  }]));

  const nav = [];
  if (page > 1) nav.push({ text: '⬅️ Sebelumnya', callback_data: `do_list_${page - 1}` });
  if (page < totalPages) nav.push({ text: 'Selanjutnya ➡️', callback_data: `do_list_${page + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([
    { text: '🔄 Muat Ulang', callback_data: `do_list_${page}` },
    { text: '➕ Buat Droplet', callback_data: 'do_new' }
  ]);
  keyboard.push([btnMenuDO]);

  await edit(bot, chatId, messageId,
    `📋 *Daftar Droplet* (${res.total} total · halaman ${page}/${totalPages})\n\n` +
    '🟢 menyala · 🔴 mati · 🟡 sedang dibuat\n\nTekan droplet untuk mengelolanya:',
    keyboard);
}

function dropletDetailText(d, note = null) {
  const created = d.createdAt ? new Date(d.createdAt).toLocaleString('id-ID') : '-';
  const ram = d.memoryMb ? (d.memoryMb >= 1024 ? `${d.memoryMb / 1024} GB` : `${d.memoryMb} MB`) : '-';
  return (
    `🖥️ *${mdBold(d.name)}*\n\n` +
    `${statusIcon(d.status)} Status: *${mdBold(STATUS_TEXT[d.status] || d.status)}*` +
    (d.locked ? ' _(sedang memproses aksi)_' : '') + '\n' +
    `🌐 IP: ${d.ip ? `\`${d.ip}\`` : '_belum ada_'}\n` +
    `🌍 Region: ${escapeMd(d.region)}\n` +
    `💻 Spek: ${d.vcpus || '-'} vCPU · ${ram} · ${d.diskGb || '-'} GB\n` +
    `📀 OS: ${escapeMd(d.image)}\n` +
    (d.priceMonthly != null ? `💵 Tarif DO: ~$${d.priceMonthly}/bulan\n` : '') +
    `🆔 ID: \`${d.id}\`\n` +
    `📅 Dibuat: ${escapeMd(created)}` +
    (note ? `\n\n${note}` : '')
  );
}

function dropletDetailKeyboard(d) {
  const id = d.id;
  const power = d.status === 'active'
    ? [
        { text: '🔴 Matikan', callback_data: `do_act_off_${id}` },
        { text: '🔄 Reboot', callback_data: `do_act_reboot_${id}` }
      ]
    : [{ text: '🟢 Nyalakan', callback_data: `do_act_on_${id}` }];
  return [
    power,
    [
      { text: '⚡ Power Cycle', callback_data: `do_ask_cycle_${id}` },
      { text: '⛔ Matikan Paksa', callback_data: `do_ask_kill_${id}` }
    ],
    [
      { text: '🔑 Reset Password Root', callback_data: `do_ask_pwreset_${id}` },
      { text: '📸 Snapshot', callback_data: `do_ask_snap_${id}` }
    ],
    [
      { text: '🖥️ Install RDP ke VPS ini', callback_data: 'install_rdp' },
      { text: '🗑️ Hapus', callback_data: `do_ask_del_${id}` }
    ],
    [
      { text: '🔄 Muat Ulang', callback_data: `do_dp_${id}` },
      { text: '« Daftar Droplet', callback_data: 'do_list_1' }
    ]
  ];
}

async function showDropletDetail(bot, chatId, messageId, userSessions, id, note = null) {
  const auth = getAuth(chatId);
  if (!auth) return promptToken(bot, chatId, messageId, userSessions);

  let d;
  try {
    d = await getDropletInfo(auth.token, id);
  } catch (error) {
    if (isAuthError(error)) return handleAuthLost(bot, chatId, messageId, userSessions);
    const notFound = error && error.response && error.response.status === 404;
    return edit(bot, chatId, messageId,
      notFound
        ? '❌ Droplet tidak ditemukan (mungkin sudah dihapus).'
        : `❌ Gagal memuat droplet.\n\n${escapeMd(humanError(error))}`,
      [[{ text: '« Daftar Droplet', callback_data: 'do_list_1' }, btnMenuDO]]);
  }
  if (!d) {
    return edit(bot, chatId, messageId, '❌ Droplet tidak ditemukan.',
      [[{ text: '« Daftar Droplet', callback_data: 'do_list_1' }]]);
  }
  await edit(bot, chatId, messageId, dropletDetailText(d, note), dropletDetailKeyboard(d));
}

/* ========================================================================= */
/* Aksi droplet                                                               */
/* ========================================================================= */
const ASK_TEXT = {
  cycle: '⚡ *Power cycle* mematikan listrik droplet lalu menyalakannya lagi (seperti cabut-colok). Proses yang sedang berjalan bisa terputus.',
  kill: '⛔ *Matikan paksa* memutus listrik droplet seketika. Data yang belum tersimpan bisa hilang. Pakai "Matikan" biasa kalau bisa.',
  pwreset: '🔑 *Reset password root*: DigitalOcean akan me-restart droplet dan MENGIRIM password root baru ke EMAIL akun DigitalOcean Anda (bukan ke chat ini).',
  snap: '📸 *Snapshot* menyimpan salinan disk droplet. DigitalOcean menagih penyimpanan snapshot (~$0,06/GB/bulan). Droplet bisa dimatikan sebentar selama proses.',
  del: '🗑️ *Hapus droplet* secara PERMANEN. Semua data di dalamnya hilang dan tidak bisa dikembalikan.'
};

async function askConfirm(bot, chatId, messageId, key, id) {
  const confirm = key === 'del' ? `do_delok_${id}` : `do_act_${key}_${id}`;
  await edit(bot, chatId, messageId,
    `${ASK_TEXT[key]}\n\nLanjutkan untuk droplet \`${id}\`?`,
    [[
      { text: key === 'del' ? '✅ Ya, hapus permanen' : '✅ Ya, lanjutkan', callback_data: confirm },
      { text: '« Batal', callback_data: `do_dp_${id}` }
    ]]);
}

async function runAction(bot, chatId, messageId, userSessions, key, id) {
  const auth = getAuth(chatId);
  if (!auth) return promptToken(bot, chatId, messageId, userSessions);
  const def = DROPLET_ACTIONS[key];
  if (!def) return;

  await safeEdit(bot, `⏳ ${def.label}...`, { chat_id: chatId, message_id: messageId });
  try {
    await dropletAction(auth.token, id, key);
  } catch (error) {
    if (isAuthError(error)) return handleAuthLost(bot, chatId, messageId, userSessions);
    return showDropletDetail(bot, chatId, messageId, userSessions, id,
      `❌ ${escapeMd(def.label)} gagal: ${escapeMd(humanError(error))}`);
  }
  const extra = key === 'pwreset' ? ' Cek email akun DigitalOcean Anda untuk password baru.' : '';
  return showDropletDetail(bot, chatId, messageId, userSessions, id,
    `✅ Perintah *${mdBold(def.label)}* dikirim. Tekan 🔄 Muat Ulang dalam beberapa detik untuk melihat status terbaru.${extra}`);
}

async function runDelete(bot, chatId, messageId, userSessions, id) {
  const auth = getAuth(chatId);
  if (!auth) return promptToken(bot, chatId, messageId, userSessions);
  await safeEdit(bot, '⏳ Menghapus droplet...', { chat_id: chatId, message_id: messageId });
  try {
    await deleteDroplet(auth.token, id);
  } catch (error) {
    if (isAuthError(error)) return handleAuthLost(bot, chatId, messageId, userSessions);
    return showDropletDetail(bot, chatId, messageId, userSessions, id,
      `❌ Gagal menghapus: ${escapeMd(humanError(error))}`);
  }
  await edit(bot, chatId, messageId,
    `✅ Droplet \`${id}\` sedang dihapus.\n_Penagihan DigitalOcean untuk droplet ini berhenti setelah terhapus._`,
    [[{ text: '📋 Daftar Droplet', callback_data: 'do_list_1' }, btnMenuDO]]);
}

/* ========================================================================= */
/* Callback                                                                   */
/* ========================================================================= */
async function handleDOCallback(bot, query, userSessions) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const action = query.data.slice(3); // buang 'do_'

  // Pisah "kunci_nilai". Contoh: list_2, dp_123, act_off_123, ask_del_123.
  const sep = action.indexOf('_');
  const key = sep === -1 ? action : action.slice(0, sep);
  const val = sep === -1 ? '' : action.slice(sep + 1);

  switch (key) {
    case 'start':
      return startDO(bot, chatId, messageId, userSessions);
    case 'menu':
      return showDoMenu(bot, chatId, messageId, userSessions);
    case 'logout':
      doAuth.delete(chatId);
      if (userSessions.get(chatId)?.flow === 'do') userSessions.delete(chatId);
      return edit(bot, chatId, messageId,
        '🔌 Token DigitalOcean diputus dan dihapus dari memori bot.',
        [[{ text: '☁️ Hubungkan Lagi', callback_data: 'do_start' }, btnMainMenu]]);
    case 'cancel': {
      const s = userSessions.get(chatId);
      if (s && s.flow === 'do' && s.step === 'do_creating') return; // sedang membuat, abaikan
      if (s && s.flow === 'do') userSessions.delete(chatId);
      if (getAuth(chatId)) {
        return showDoMenu(bot, chatId, messageId, userSessions,
          '❌ Pembuatan droplet dibatalkan. _Saldo tidak terpotong._');
      }
      return edit(bot, chatId, messageId, '❌ Dibatalkan.', [[btnMainMenu]]);
    }
    case 'list': {
      const page = Math.max(1, parseInt(val, 10) || 1);
      return showDropletList(bot, chatId, messageId, userSessions, page);
    }
    case 'dp': {
      const id = parseInt(val, 10);
      if (!id) return;
      return showDropletDetail(bot, chatId, messageId, userSessions, id);
    }
    case 'ask': {
      const i = val.lastIndexOf('_');
      const k = val.slice(0, i);
      const id = parseInt(val.slice(i + 1), 10);
      if (!id || !ASK_TEXT[k]) return;
      return askConfirm(bot, chatId, messageId, k, id);
    }
    case 'act': {
      const i = val.lastIndexOf('_');
      const k = val.slice(0, i);
      const id = parseInt(val.slice(i + 1), 10);
      if (!id || !DROPLET_ACTIONS[k]) return;
      return runAction(bot, chatId, messageId, userSessions, k, id);
    }
    case 'delok': {
      const id = parseInt(val, 10);
      if (!id) return;
      return runDelete(bot, chatId, messageId, userSessions, id);
    }
    case 'new':
      return startCreate(bot, chatId, messageId, userSessions);
    default:
      return handleCreateCallback(bot, chatId, messageId, key, val, userSessions);
  }
}

/* ========================================================================= */
/* Buat droplet                                                               */
/* ========================================================================= */
async function startCreate(bot, chatId, messageId, userSessions) {
  const auth = getAuth(chatId);
  if (!auth) return promptToken(bot, chatId, messageId, userSessions);

  const cukup = await hasSufficientBalance(chatId, VPS_CREATE_COST);
  if (!cukup) {
    return edit(bot, chatId, messageId,
      `❌ Saldo tidak mencukupi.\n\n` +
      `Biaya layanan buat droplet: Rp ${VPS_CREATE_COST.toLocaleString('id-ID')} (flat per batch 1-${MAX_DROPLETS} droplet).\n` +
      `Fitur lain di Control DO tetap gratis.`,
      [[{ text: '💰 Deposit Saldo', callback_data: 'deposit' }, btnMenuDO]]);
  }

  const session = {
    flow: 'do',
    step: 'do_selecting_region',
    token: auth.token,
    doEmail: auth.email,
    messageId,
    startTime: Date.now(),
    lastActivity: Date.now()
  };
  userSessions.set(chatId, session);
  await showRegionSelection(bot, chatId, session);
}

async function handleCreateCallback(bot, chatId, messageId, key, val, userSessions) {
  const session = userSessions.get(chatId);
  if (!session || session.flow !== 'do' || !session.token) {
    return edit(bot, chatId, messageId,
      '❌ Sesi pembuatan droplet kadaluarsa. Mulai lagi ya.\n\n💰 _Saldo Anda tidak terpotong._',
      [[{ text: '☁️ Control DO', callback_data: 'do_start' }, btnMainMenu]]);
  }
  // Tombol lama ditekan saat droplet sedang dibuat → abaikan (cegah dobel).
  if (session.step === 'do_creating') return;

  session.lastActivity = Date.now();
  session.messageId = messageId;

  switch (key) {
    case 'region':
      if (!findRegion(val)) return;
      session.region = val;
      session.step = 'do_selecting_size';
      return showSizeSelection(bot, chatId, session);
    case 'size':
      if (!session.region || !findSize(val)) return;
      session.size = val;
      session.step = 'do_selecting_image';
      return showImageSelection(bot, chatId, session);
    case 'img':
      if (!session.size || !findImage(val)) return;
      session.image = val;
      session.step = 'do_selecting_count';
      return showCountSelection(bot, chatId, session);
    case 'count': {
      const n = parseInt(val, 10);
      if (!session.image || !Number.isInteger(n) || n < 1 || n > MAX_DROPLETS) return;
      session.count = n;
      session.step = 'do_waiting_password';
      return edit(bot, chatId, session.messageId, buildPasswordPrompt(session), passwordKeyboard());
    }
    case 'passauto':
      if (session.step !== 'do_waiting_password') return;
      session.rootPassword = genPassword(16);
      return createAndReport(bot, chatId, session, userSessions);
    default:
      return;
  }
}

async function handlePasswordInput(bot, chatId, text, session, userSessions) {
  const password = String(text || '').trim();
  if (!isValidVpsPassword(password)) {
    await edit(bot, chatId, session.messageId, buildPasswordPrompt(session, VPS_PASSWORD_RULE), passwordKeyboard());
    return;
  }
  session.rootPassword = password;
  await createAndReport(bot, chatId, session, userSessions);
}

async function showRegionSelection(bot, chatId, session) {
  const keyboard = [];
  for (let i = 0; i < DO_REGIONS.length; i += 2) {
    const row = [{ text: DO_REGIONS[i].name, callback_data: `do_region_${DO_REGIONS[i].slug}` }];
    if (DO_REGIONS[i + 1]) {
      row.push({ text: DO_REGIONS[i + 1].name, callback_data: `do_region_${DO_REGIONS[i + 1].slug}` });
    }
    keyboard.push(row);
  }
  keyboard.push(cancelCreateRow);

  await edit(bot, chatId, session.messageId,
    '➕ *Buat Droplet* — langkah 1/5\n\n' +
    '🌍 *Pilih lokasi/region droplet:*\n_Singapore biasanya paling cepat dari Indonesia._',
    keyboard);
}

async function showSizeSelection(bot, chatId, session) {
  const region = findRegion(session.region);
  const keyboard = DO_SIZES.map((s) => ([
    { text: `${s.name}  (~$${s.priceUsd}/bln)`, callback_data: `do_size_${s.slug}` }
  ]));
  keyboard.push(cancelCreateRow);

  await edit(bot, chatId, session.messageId,
    '➕ *Buat Droplet* — langkah 2/5\n\n' +
    `🌍 Region: *${mdBold(region.name)}*\n\n` +
    '💻 *Pilih ukuran droplet:*\n' +
    `_Untuk RDP Windows butuh minimal 2 vCPU · 4GB. Harga = perkiraan tagihan DigitalOcean (bukan biaya bot)._`,
    keyboard);
}

async function showImageSelection(bot, chatId, session) {
  const size = findSize(session.size);
  const keyboard = DO_IMAGES.map((i) => ([
    { text: i.name, callback_data: `do_img_${i.slug}` }
  ]));
  keyboard.push(cancelCreateRow);

  await edit(bot, chatId, session.messageId,
    '➕ *Buat Droplet* — langkah 3/5\n\n' +
    `💻 Ukuran: *${mdBold(size.name)}*\n\n` +
    '📀 *Pilih sistem operasi:*\n_Ubuntu 22.04 direkomendasikan kalau mau dipasang RDP._',
    keyboard);
}

async function showCountSelection(bot, chatId, session) {
  const image = findImage(session.image);
  const keyboard = [];
  let row = [];
  for (let n = 1; n <= MAX_DROPLETS; n++) {
    row.push({ text: String(n), callback_data: `do_count_${n}` });
    if (row.length === 5) { keyboard.push(row); row = []; }
  }
  if (row.length) keyboard.push(row);
  keyboard.push(cancelCreateRow);

  await edit(bot, chatId, session.messageId,
    '➕ *Buat Droplet* — langkah 4/5\n\n' +
    `📀 OS: *${mdBold(image.name)}*\n\n` +
    `🔢 *Berapa droplet yang dibuat?* (1-${MAX_DROPLETS})\n` +
    `_Biaya bot tetap Rp ${VPS_CREATE_COST.toLocaleString('id-ID')} berapa pun jumlahnya. ` +
    'Tiap droplet ditagih terpisah oleh DigitalOcean ke akun Anda._',
    keyboard);
}

function passwordKeyboard() {
  return [
    [{ text: '🎲 Buatkan Password Otomatis', callback_data: 'do_passauto' }],
    cancelCreateRow
  ];
}

function buildPasswordPrompt(session, errorNote = null) {
  const region = findRegion(session.region);
  const size = findSize(session.size);
  const image = findImage(session.image);
  return (
    '➕ *Buat Droplet* — langkah 5/5\n\n' +
    `🌍 Region: ${escapeMd(region.name)}\n` +
    `💻 Ukuran: ${escapeMd(size.name)}\n` +
    `📀 OS: ${escapeMd(image.name)}\n` +
    `🔢 Jumlah: ${session.count} droplet\n\n` +
    '🔑 *Kirim password root untuk droplet:*\n' +
    `_${VPS_PASSWORD_RULE}._\n` +
    `Simbol yang boleh: \`${VPS_SYMBOLS}\`\n` +
    'Contoh: `@Mbahfauzi2025digital`\n' +
    '_Dipakai untuk semua droplet di batch ini. Atau tekan tombol di bawah untuk password acak._' +
    (errorNote ? `\n\n❌ ${escapeMd(errorNote)}` : '')
  );
}

async function createAndReport(bot, chatId, session, userSessions) {
  session.step = 'do_creating';
  userSessions.set(chatId, session);
  const selesai = () => { if (userSessions.get(chatId) === session) userSessions.delete(chatId); };

  const region = findRegion(session.region);
  const size = findSize(session.size);
  const image = findImage(session.image);

  await safeEdit(bot,
    `🔄 Membuat ${session.count} droplet di ${escapeMd(region.name)}...\n_Mohon tunggu, biasanya 1-2 menit._`,
    { chat_id: chatId, message_id: session.messageId, parse_mode: 'Markdown' });

  const ts = Date.now().toString(36);
  // Nama droplet = hostname: hanya huruf, angka, tanda hubung. chatId grup bisa
  // negatif ("-100..."), jadi karakter non-alfanumerik dibuang.
  const safeId = String(chatId).replace(/[^a-z0-9]/gi, '') || 'user';
  const names = [];
  for (let i = 1; i <= session.count; i++) names.push(`rdp-${safeId}-${ts}-${i}`.toLowerCase());

  let created;
  try {
    created = await createDroplets({
      token: session.token,
      names,
      region: session.region,
      size: session.size,
      image: session.image,
      rootPassword: session.rootPassword
    });
  } catch (error) {
    console.error(`[DO CREATE] chat=${chatId} error=${describeError(error)}`);
    selesai();
    if (isAuthError(error)) return handleAuthLost(bot, chatId, session.messageId, userSessions);
    return edit(bot, chatId, session.messageId,
      `❌ *Gagal membuat droplet*\n\n${escapeMd(String(humanError(error)).slice(0, 500))}\n\n` +
      '💰 _Saldo Anda TIDAK terpotong._',
      [[{ text: '🔄 Coba Lagi', callback_data: 'do_new' }, btnMenuDO]]);
  }

  if (!created || created.length === 0) {
    selesai();
    return edit(bot, chatId, session.messageId,
      '❌ DigitalOcean tidak mengembalikan droplet apa pun.\n\n💰 _Saldo Anda TIDAK terpotong._',
      [[btnMenuDO]]);
  }

  /* Droplet sudah dibuat — BARU sekarang potong biaya layanan bot, flat sekali. */
  let charged = false;
  if (!isAdmin(chatId)) {
    charged = await deductBalance(chatId, VPS_CREATE_COST);
    if (!charged) {
      console.error(`[DO BILLING] Gagal memotong saldo user ${chatId} setelah droplet dibuat.`);
      notifyAdmin(bot, `⚠️ User ${chatId} berhasil membuat ${created.length} droplet DO tapi saldo tidak bisa dipotong.`);
    }
  }

  // Tunggu IP publik keluar, sambil memperbarui pesan (dibatasi biar tidak spam).
  let lastEdit = 0;
  const results = await waitForDroplets({
    token: session.token,
    ids: created.map((d) => d.id),
    onTick: (list) => {
      const now = Date.now();
      if (now - lastEdit < 7000) return;
      lastEdit = now;
      const ready = list.filter((r) => r.ip).length;
      safeEdit(bot,
        `🔄 Menyiapkan droplet... (${ready}/${list.length} sudah dapat IP)\n_Menunggu DigitalOcean menyalakan VPS._`,
        { chat_id: chatId, message_id: session.messageId, parse_mode: 'Markdown' }).catch(() => {});
    }
  });

  const lines = results.map((r, idx) => (r.ip
    ? `${idx + 1}. \`${r.ip}\``
    : `${idx + 1}. _menyiapkan… (status: ${mdItalic(r.status || 'baru')})_`));
  const belumSiap = results.filter((r) => !r.ip).length;

  const body =
    `✅ *${created.length} droplet berhasil dibuat!*\n\n` +
    `🌍 Region: ${escapeMd(region.name)}\n` +
    `💻 Ukuran: ${escapeMd(size.name)}\n` +
    `📀 OS: ${escapeMd(image.name)}\n\n` +
    '👤 User: `root`\n' +
    `🔑 Password: \`${mdCode(session.rootPassword)}\`\n\n` +
    `🌐 *IP Publik:*\n${lines.join('\n')}\n\n` +
    (belumSiap > 0
      ? `⏳ ${belumSiap} droplet belum dapat IP. Cek lagi lewat 📋 Daftar Droplet beberapa menit lagi.\n\n`
      : '') +
    '💡 *Cara masuk:* `ssh root@IP` lalu masukkan password di atas.\n' +
    '_Password root aktif ±1-2 menit setelah droplet menyala. Mau pasang RDP? Tunggu 2 menit lalu tekan Install RDP._\n' +
    (charged
      ? `\n💰 Biaya layanan Rp ${VPS_CREATE_COST.toLocaleString('id-ID')} telah dipotong.`
      : (isAdmin(chatId) ? '' : '\n💰 _Catatan: biaya layanan belum bisa dipotong, hubungi admin._')) +
    '\n\n⚠️ Simpan password ini. Sewa droplet ditagih DigitalOcean ke akun Anda.';

  selesai();
  await edit(bot, chatId, session.messageId, body, [
    [{ text: '🖥️ Install RDP ke VPS ini', callback_data: 'install_rdp' }],
    [{ text: '📋 Daftar Droplet', callback_data: 'do_list_1' }, btnMenuDO]
  ]);
}

function notifyAdmin(bot, text) {
  const adminId = (process.env.ADMIN_ID || '').split(',')[0].trim();
  if (!adminId) return;
  safeSend(bot, adminId, text).catch(() => {});
}

module.exports = {
  DO_STEPS,
  startDO,
  handleDOText,
  handleDOCallback,
  _doAuth: doAuth
};
