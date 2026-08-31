/**
 * Fitur "Buat VPS" lewat API DigitalOcean.
 *
 * Alur:
 *   token DO  ->  region  ->  ukuran  ->  image  ->  jumlah (1-10)
 *             ->  password root  ->  buat droplet  ->  kirim IP + password
 *
 * Biaya bot: FLAT Rp1.000 per batch (berapa pun jumlah droplet). Tagihan sewa
 * droplet-nya sendiri ditanggung akun DigitalOcean milik buyer.
 *
 * Droplet dibuat di akun buyer (buyer memasukkan token pribadinya), jadi bot
 * tidak menanggung biaya apa pun dari sisi DigitalOcean.
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
  genPassword
} = require('../utils/digitalocean');
const {
  hasSufficientBalance,
  deductBalance,
  isAdmin
} = require('../utils/userManager');
const installLock = require('../utils/installLock');
const { isValidVpsPassword, VPS_PASSWORD_RULE, VPS_SYMBOLS } = require('../utils/password');
const { safeEdit, safeSend, safeDelete, escapeMd } = require('../utils/telegram');

const MAX_DROPLETS = 10;

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

const cancelRow = [{ text: '« Batal', callback_data: 'do_cancel' }];

/* ========================================================================= */
/* Mulai                                                                      */
/* ========================================================================= */
async function startDO(bot, chatId, messageId, userSessions) {
  if (installLock.isLocked(chatId)) {
    await safeEdit(bot,
      '⏳ Ada instalasi RDP Anda yang sedang berjalan. Tunggu sampai selesai dulu ya.',
      {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'back_to_menu' }]] }
      });
    return;
  }

  const cukup = await hasSufficientBalance(chatId, VPS_CREATE_COST);
  if (!cukup) {
    await safeEdit(bot,
      `❌ Saldo tidak mencukupi.\n\n` +
      `Biaya buat VPS: Rp ${VPS_CREATE_COST.toLocaleString('id-ID')} (flat per batch)\n` +
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

  await safeEdit(bot, buildTokenPrompt(), {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [cancelRow] }
  });

  userSessions.set(chatId, {
    flow: 'do',
    step: 'do_waiting_token',
    messageId,
    startTime: Date.now(),
    lastActivity: Date.now()
  });
}

function buildTokenPrompt(errorNote = null) {
  return (
    '☁️ *Buat VPS via DigitalOcean*\n\n' +
    `Biaya layanan: *Rp ${VPS_CREATE_COST.toLocaleString('id-ID')}* flat (buat 1-${MAX_DROPLETS} droplet, harga tetap segini).\n` +
    '_Tagihan sewa droplet dibayar dari akun DigitalOcean Anda sendiri._\n\n' +
    '🔑 *Kirim Personal Access Token DigitalOcean Anda:*\n' +
    'Token harus punya izin *Write*.\n\n' +
    'Cara ambil token:\n' +
    '1. Buka cloud.digitalocean.com → API → Tokens\n' +
    '2. Generate New Token (centang Write)\n' +
    '3. Salin dan kirim ke sini\n\n' +
    '_Token akan dihapus otomatis setelah dikirim._' +
    (errorNote ? `\n\n❌ ${errorNote}` : '')
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
  if (!token || token.length < 20) {
    await safeEdit(bot, buildTokenPrompt('Token terlalu pendek / kosong. Salin ulang token DigitalOcean Anda.'), {
      chat_id: chatId,
      message_id: session.messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [cancelRow] }
    });
    return;
  }

  await safeEdit(bot, '🔍 Memeriksa token DigitalOcean...', {
    chat_id: chatId,
    message_id: session.messageId
  });

  const check = await validateToken(token);
  if (!check.ok) {
    const detail = String(check.error || '').split(':').slice(1).join(':') || 'Token ditolak.';
    await safeEdit(bot, buildTokenPrompt(detail), {
      chat_id: chatId,
      message_id: session.messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [cancelRow] }
    });
    return;
  }

  session.token = token;
  session.doEmail = check.email || null;
  session.step = 'do_selecting_region';
  userSessions.set(chatId, session);

  await showRegionSelection(bot, chatId, session);
}

async function handlePasswordInput(bot, chatId, text, session, userSessions) {
  const password = String(text || '').trim();
  // Password root VPS: simbol+besar+kecil+angka, diakhiri huruf (utils/password.js).
  if (!isValidVpsPassword(password)) {
    await safeEdit(bot, buildPasswordPrompt(session, VPS_PASSWORD_RULE), {
      chat_id: chatId,
      message_id: session.messageId,
      parse_mode: 'Markdown',
      reply_markup: passwordKeyboard()
    });
    return;
  }

  session.rootPassword = password;
  userSessions.set(chatId, session);
  await createAndReport(bot, chatId, session, userSessions);
}

/* ========================================================================= */
/* Callback (region / ukuran / image / jumlah / auto-password / batal)       */
/* ========================================================================= */
async function handleDOCallback(bot, query, userSessions) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data; // diawali 'do_'
  const action = data.slice(3);

  if (action === 'start') {
    return startDO(bot, chatId, messageId, userSessions);
  }
  if (action === 'cancel') {
    userSessions.delete(chatId);
    await safeEdit(bot, '❌ Pembuatan VPS dibatalkan.\n\n💰 _Saldo Anda tidak terpotong._', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Kembali ke Menu', callback_data: 'back_to_menu' }]] }
    });
    return;
  }

  const session = userSessions.get(chatId);
  if (!session || session.flow !== 'do') {
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

  const sep = action.indexOf('_');
  const key = sep === -1 ? action : action.slice(0, sep);
  const val = sep === -1 ? '' : action.slice(sep + 1);

  switch (key) {
    case 'region': {
      if (!findRegion(val)) return;
      session.region = val;
      session.step = 'do_selecting_size';
      userSessions.set(chatId, session);
      return showSizeSelection(bot, chatId, session);
    }
    case 'size': {
      if (!findSize(val)) return;
      session.size = val;
      session.step = 'do_selecting_image';
      userSessions.set(chatId, session);
      return showImageSelection(bot, chatId, session);
    }
    case 'img': {
      if (!findImage(val)) return;
      session.image = val;
      session.step = 'do_selecting_count';
      userSessions.set(chatId, session);
      return showCountSelection(bot, chatId, session);
    }
    case 'count': {
      const n = parseInt(val, 10);
      if (!Number.isInteger(n) || n < 1 || n > MAX_DROPLETS) return;
      session.count = n;
      session.step = 'do_waiting_password';
      userSessions.set(chatId, session);
      await safeEdit(bot, buildPasswordPrompt(session), {
        chat_id: chatId,
        message_id: session.messageId,
        parse_mode: 'Markdown',
        reply_markup: passwordKeyboard()
      });
      return;
    }
    case 'passauto': {
      session.rootPassword = genPassword(16);
      userSessions.set(chatId, session);
      return createAndReport(bot, chatId, session, userSessions);
    }
    default:
      return;
  }
}

/* ========================================================================= */
/* Layar-layar pemilihan                                                     */
/* ========================================================================= */
async function showRegionSelection(bot, chatId, session) {
  const keyboard = [];
  for (let i = 0; i < DO_REGIONS.length; i += 2) {
    const row = [{ text: DO_REGIONS[i].name, callback_data: `do_region_${DO_REGIONS[i].slug}` }];
    if (DO_REGIONS[i + 1]) {
      row.push({ text: DO_REGIONS[i + 1].name, callback_data: `do_region_${DO_REGIONS[i + 1].slug}` });
    }
    keyboard.push(row);
  }
  keyboard.push(cancelRow);

  await safeEdit(bot,
    `✅ Token valid${session.doEmail ? ` (\`${escapeMd(session.doEmail)}\`)` : ''}.\n\n` +
    '🌍 *Pilih lokasi/region droplet:*\n_Singapura biasanya paling ngebut dari Indonesia._',
    {
      chat_id: chatId,
      message_id: session.messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
}

async function showSizeSelection(bot, chatId, session) {
  const region = findRegion(session.region);
  const keyboard = DO_SIZES.map((s) => ([
    { text: `${s.name}  (~$${s.priceUsd}/bln)`, callback_data: `do_size_${s.slug}` }
  ]));
  keyboard.push(cancelRow);

  await safeEdit(bot,
    `🌍 Region: *${escapeMd(region.name)}*\n\n` +
    '💻 *Pilih ukuran droplet:*\n' +
    '_Untuk RDP Windows, pilih minimal 2GB RAM. Harga di bawah perkiraan tagihan DigitalOcean (bukan biaya bot)._',
    {
      chat_id: chatId,
      message_id: session.messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
}

async function showImageSelection(bot, chatId, session) {
  const size = findSize(session.size);
  const keyboard = DO_IMAGES.map((i) => ([
    { text: i.name, callback_data: `do_img_${i.slug}` }
  ]));
  keyboard.push(cancelRow);

  await safeEdit(bot,
    `💻 Ukuran: *${escapeMd(size.name)}*\n\n` +
    '📀 *Pilih sistem operasi (image):*\n_Ubuntu 22.04 direkomendasikan._',
    {
      chat_id: chatId,
      message_id: session.messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
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
  keyboard.push(cancelRow);

  await safeEdit(bot,
    `📀 Image: *${escapeMd(image.name)}*\n\n` +
    `🔢 *Berapa droplet yang dibuat?* (1-${MAX_DROPLETS})\n` +
    `_Biaya bot tetap Rp ${VPS_CREATE_COST.toLocaleString('id-ID')} berapa pun jumlahnya. ` +
    'Tiap droplet tetap ditagih terpisah oleh DigitalOcean ke akun Anda._',
    {
      chat_id: chatId,
      message_id: session.messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
}

function passwordKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🎲 Buatkan password otomatis', callback_data: 'do_passauto' }],
      cancelRow
    ]
  };
}

function buildPasswordPrompt(session, errorNote = null) {
  const region = findRegion(session.region);
  const size = findSize(session.size);
  const image = findImage(session.image);
  return (
    '📝 *Konfigurasi droplet*\n\n' +
    `🌍 Region: ${escapeMd(region.name)}\n` +
    `💻 Ukuran: ${escapeMd(size.name)}\n` +
    `📀 Image: ${escapeMd(image.name)}\n` +
    `🔢 Jumlah: ${session.count} droplet\n\n` +
    '🔑 *Kirim password root untuk droplet:*\n' +
    `_${VPS_PASSWORD_RULE}._\n` +
    `Simbol yang boleh: \`${VPS_SYMBOLS}\`\n` +
    'Contoh: `@Mbahfauzi2025digital`\n' +
    '_Dipakai untuk semua droplet di batch ini. Atau tekan tombol di bawah untuk password acak._' +
    (errorNote ? `\n\n❌ ${errorNote}` : '')
  );
}

/* ========================================================================= */
/* Pembuatan droplet + laporan                                               */
/* ========================================================================= */
async function createAndReport(bot, chatId, session, userSessions) {
  session.step = 'do_creating';
  userSessions.set(chatId, session);

  const region = findRegion(session.region);
  const size = findSize(session.size);
  const image = findImage(session.image);

  await safeEdit(bot,
    `🔄 Membuat ${session.count} droplet di ${escapeMd(region.name)}...\n_Mohon tunggu, biasanya 1-2 menit._`,
    {
      chat_id: chatId,
      message_id: session.messageId,
      parse_mode: 'Markdown'
    });

  const ts = Date.now().toString(36);
  // Nama droplet dipakai DigitalOcean sebagai hostname — hanya boleh huruf,
  // angka, dan tanda hubung. chatId grup bisa negatif ("-100..."), jadi
  // karakter non-alfanumerik dibuang supaya nama tetap valid.
  const safeId = String(chatId).replace(/[^a-z0-9]/gi, '') || 'user';
  const names = [];
  for (let i = 1; i <= session.count; i++) {
    names.push(`rdp-${safeId}-${ts}-${i}`.toLowerCase());
  }

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
    const detail = String(error && error.message ? error.message : error);
    const human = detail.includes(':') ? detail.slice(detail.indexOf(':') + 1) : detail;
    console.error(`[DO CREATE] chat=${chatId} error=${detail}`);
    await safeEdit(bot,
      `❌ *Gagal membuat droplet*\n\n${escapeMd(String(human).slice(0, 500))}\n\n` +
      `💰 _Saldo Anda TIDAK terpotong._`,
      {
        chat_id: chatId,
        message_id: session.messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🔄 Coba Lagi', callback_data: 'do_start' },
            { text: '« Menu', callback_data: 'back_to_menu' }
          ]]
        }
      });
    userSessions.delete(chatId);
    return;
  }

  if (!created || created.length === 0) {
    await safeEdit(bot,
      '❌ DigitalOcean tidak mengembalikan droplet apa pun.\n\n💰 _Saldo Anda TIDAK terpotong._',
      {
        chat_id: chatId,
        message_id: session.messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '« Menu', callback_data: 'back_to_menu' }]] }
      });
    userSessions.delete(chatId);
    return;
  }

  /* Droplet sudah dibuat (dan sudah ditagih DigitalOcean ke akun buyer) —
   * BARU sekarang potong biaya layanan bot, flat sekali. */
  let charged = false;
  if (!isAdmin(chatId)) {
    charged = await deductBalance(chatId, VPS_CREATE_COST);
    if (!charged) {
      console.error(`[DO BILLING] Gagal memotong saldo user ${chatId} setelah droplet dibuat.`);
      notifyAdmin(bot,
        `⚠️ User ${chatId} berhasil membuat ${created.length} droplet DO tapi saldo tidak bisa dipotong.`);
    }
  }

  // Tunggu IP publik keluar, sambil memperbarui pesan (dibatasi biar tidak spam).
  let lastEdit = 0;
  const ids = created.map((d) => d.id);
  const results = await waitForDroplets({
    token: session.token,
    ids,
    onTick: (list) => {
      const now = Date.now();
      if (now - lastEdit < 7000) return;
      lastEdit = now;
      const ready = list.filter((r) => r.ip).length;
      safeEdit(bot,
        `🔄 Menyiapkan droplet... (${ready}/${list.length} sudah dapat IP)\n` +
        `_Menunggu DigitalOcean menyalakan VPS._`,
        {
          chat_id: chatId,
          message_id: session.messageId,
          parse_mode: 'Markdown'
        }).catch(() => {});
    }
  });

  // Susun laporan akhir.
  const lines = results.map((r, idx) => {
    const label = `Droplet ${idx + 1}`;
    if (r.ip) return `${label}: \`${r.ip}\``;
    return `${label}: _menyiapkan… (status: ${escapeMd(r.status || 'baru')})_`;
  });
  const belumSiap = results.filter((r) => !r.ip).length;

  const body =
    `✅ *${created.length} droplet berhasil dibuat!*\n\n` +
    `🌍 Region: ${escapeMd(region.name)}\n` +
    `💻 Ukuran: ${escapeMd(size.name)}\n` +
    `📀 Image: ${escapeMd(image.name)}\n\n` +
    `👤 User: \`root\`\n` +
    `🔑 Password: \`${escapeMd(session.rootPassword)}\`\n\n` +
    `🌐 *IP Publik:*\n${lines.join('\n')}\n\n` +
    (belumSiap > 0
      ? `⏳ ${belumSiap} droplet belum dapat IP dalam waktu tunggu. Cek panel DigitalOcean beberapa menit lagi.\n\n`
      : '') +
    `💡 *Cara masuk:* \`ssh root@<IP>\` lalu masukkan password di atas.\n` +
    `_Login password baru aktif ~1 menit setelah droplet menyala (cloud-init)._\n` +
    (charged
      ? `\n💰 Biaya layanan Rp ${VPS_CREATE_COST.toLocaleString('id-ID')} telah dipotong.`
      : (isAdmin(chatId) ? '' : `\n💰 _Catatan: biaya layanan belum bisa dipotong, hubungi admin._`)) +
    `\n\n⚠️ Ganti password root & aktifkan firewall untuk keamanan. Sewa droplet ditagih DigitalOcean ke akun Anda.`;

  await safeEdit(bot, body, {
    chat_id: chatId,
    message_id: session.messageId,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🖥️ Install RDP ke VPS ini', callback_data: 'install_rdp' }],
        [{ text: '« Kembali ke Menu', callback_data: 'back_to_menu' }]
      ]
    }
  });

  userSessions.delete(chatId);
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
  handleDOCallback
};
