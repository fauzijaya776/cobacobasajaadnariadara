/**
 * Label tombol, menu, perintah, dan deskripsi bot.
 *
 * Label tombol keyboard persisten dipakai di dua tempat (pembuatan tombol dan
 * pengenalan pesan masuk), jadi didefinisikan sekali di sini agar tidak pernah
 * beda.
 */
const BUTTON = {
  INSTALL: '🖥️ Install RDP',
  MULTI: '📦 Multi Install RDP',
  DO_CONTROL: '☁️ Control DO via API',
  DEPOSIT: '💰 Deposit Saldo',
  BALANCE: '💳 Saldo & Riwayat',
  FAQ: '❓ FAQ & Bantuan',
  PROVIDER: '🏢 Rekomendasi VPS',
  MENU: '🏠 Menu Utama'
};

/**
 * Label keyboard persisten VERSI LAMA.
 *
 * Keyboard persisten disimpan di aplikasi Telegram milik user sampai diganti.
 * Setelah bot diperbarui, user yang belum mengetik /start masih melihat tombol
 * lama — tanpa pemetaan ini, menekannya tidak memberi reaksi apa pun.
 */
const LEGACY_BUTTONS = {
  '📦 Multi Install': BUTTON.MULTI,
  '☁️ Buat VPS': BUTTON.DO_CONTROL,
  '💰 Deposit': BUTTON.DEPOSIT,
  '💳 Cek Saldo': BUTTON.BALANCE,
  '❓ FAQ': BUTTON.FAQ,
  '🏢 Provider': BUTTON.PROVIDER
};

/** Ubah teks tombol (baru atau lama) ke label baku. null kalau bukan tombol. */
function resolveButton(text) {
  if (Object.values(BUTTON).includes(text)) return text;
  return LEGACY_BUTTONS[text] || null;
}

/** Apakah teks ini tombol versi lama (keyboard user perlu diganti). */
function isLegacyButton(text) {
  return Object.prototype.hasOwnProperty.call(LEGACY_BUTTONS, text);
}

/** Menu utama berbentuk inline keyboard (menempel di pesan). */
function createMainMenu(isAdmin = false) {
  const keyboard = [
    [
      { text: '🖥️ Install RDP', callback_data: 'install_rdp' },
      { text: '📦 Multi Install RDP', callback_data: 'multi_start' }
    ],
    [
      { text: '☁️ Control DO via API', callback_data: 'do_start' }
    ],
    [
      { text: '💰 Deposit Saldo', callback_data: 'deposit' },
      { text: '💳 Saldo & Riwayat', callback_data: 'my_balance' }
    ],
    [
      { text: '❓ FAQ & Bantuan', callback_data: 'faq' },
      { text: '🏢 Rekomendasi VPS', callback_data: 'providers' }
    ]
  ];

  if (isAdmin) {
    keyboard.push([
      { text: '➕ Tambah Saldo User', callback_data: 'add_balance' },
      { text: '📢 Broadcast', callback_data: 'boardcast' }
    ]);
    keyboard.push([{ text: '🗄️ Data & Backup', callback_data: 'manage_db' }]);
  }

  return { reply_markup: { inline_keyboard: keyboard } };
}

/**
 * Keyboard persisten yang selalu terlihat di bawah kolom ketik.
 *
 * Ini yang membuat user tidak perlu mengetik /start: tombolnya menempel di
 * aplikasi Telegram dan bertahan lintas pesan sampai diganti/dihapus.
 */
function createPersistentKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: BUTTON.INSTALL }, { text: BUTTON.MULTI }],
        [{ text: BUTTON.DO_CONTROL }, { text: BUTTON.DEPOSIT }],
        [{ text: BUTTON.BALANCE }, { text: BUTTON.FAQ }],
        [{ text: BUTTON.PROVIDER }, { text: BUTTON.MENU }]
      ],
      resize_keyboard: true,   // tombol mengecil, tidak memakan layar
      is_persistent: true,     // tetap tampil, tidak sembunyi setelah dipakai
      input_field_placeholder: 'Pilih menu di bawah atau ketik /start'
    }
  };
}

/**
 * Daftar perintah yang didaftarkan ke Telegram lewat setMyCommands.
 * Hasilnya: tombol "Menu" biru di sebelah kolom ketik yang menampilkan
 * daftar perintah ini — bisa diklik, tidak perlu diketik.
 */
const BOT_COMMANDS = [
  { command: 'start',        description: '🏠 Buka menu utama' },
  { command: 'install',      description: '🖥️ Install RDP Windows ke 1 VPS' },
  { command: 'multiinstall', description: '📦 Install RDP ke banyak VPS sekaligus' },
  { command: 'do',           description: '☁️ Control DigitalOcean via API' },
  { command: 'deposit',      description: '💰 Isi saldo via QRIS' },
  { command: 'saldo',        description: '💳 Cek saldo & riwayat transaksi' },
  { command: 'faq',          description: '❓ Bantuan & panduan' },
  { command: 'batal',        description: '❌ Batalkan proses yang sedang berjalan' }
];

/**
 * Deskripsi bot di Telegram.
 *
 * - SHORT (maks 120 karakter): tampil di halaman profil bot dan saat bot
 *   dibagikan.
 * - LONG (maks 512 karakter): tampil di chat KOSONG sebelum user menekan
 *   tombol START ("Apa yang bisa dilakukan bot ini?"). Tanpa ini, user baru
 *   hanya melihat layar kosong dan tidak tahu fungsi bot.
 */
const BOT_SHORT_DESCRIPTION =
  'Bot installer RDP Windows otomatis untuk VPS Ubuntu. Rp1.000/VPS, bayar hanya jika berhasil. Deposit QRIS.';

const BOT_DESCRIPTION =
  '🚀 Bot Instalasi RDP Windows\n\n' +
  '🖥️ Ubah VPS Ubuntu jadi RDP Windows (XP s/d 11 & Server 2003–2025) — cukup kirim IP & password VPS.\n' +
  '📦 Install ke banyak VPS sekaligus.\n' +
  '☁️ Butuh VPS? Buat & kelola droplet DigitalOcean via API (token Anda sendiri).\n' +
  '💰 Deposit QRIS, saldo masuk otomatis.\n\n' +
  '💵 Rp1.000/VPS — saldo dipotong HANYA kalau instalasi berhasil.\n\n' +
  'Tekan START untuk mulai.';

module.exports = {
  BUTTON,
  LEGACY_BUTTONS,
  resolveButton,
  isLegacyButton,
  BOT_COMMANDS,
  BOT_SHORT_DESCRIPTION,
  BOT_DESCRIPTION,
  createMainMenu,
  createPersistentKeyboard
};
