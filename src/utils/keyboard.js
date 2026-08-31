/**
 * Label tombol keyboard persisten.
 * Dipakai di dua tempat (pembuatan tombol dan pengenalan pesan masuk),
 * jadi didefinisikan sekali di sini agar tidak pernah beda.
 */
const BUTTON = {
  INSTALL: '🖥️ Install RDP',
  MULTI: '📦 Multi Install',
  CREATE_VPS: '☁️ Buat VPS',
  DEPOSIT: '💰 Deposit',
  BALANCE: '💳 Cek Saldo',
  FAQ: '❓ FAQ',
  PROVIDER: '🏢 Provider',
  MENU: '🏠 Menu Utama'
};

/** Menu utama berbentuk inline keyboard (menempel di pesan). */
function createMainMenu(isAdmin = false) {
  const keyboard = [
    [
      { text: BUTTON.INSTALL, callback_data: 'install_rdp' },
      { text: BUTTON.MULTI, callback_data: 'multi_start' }
    ],
    [
      { text: BUTTON.CREATE_VPS, callback_data: 'do_start' },
      { text: BUTTON.DEPOSIT, callback_data: 'deposit' }
    ],
    [
      { text: BUTTON.FAQ, callback_data: 'faq' },
      { text: BUTTON.PROVIDER, callback_data: 'providers' }
    ]
  ];

  if (isAdmin) {
    keyboard.splice(1, 0, [
      { text: '💳 Tambah Saldo', callback_data: 'add_balance' },
      { text: '🗣️ Broadcast', callback_data: 'boardcast' },
      { text: '📊 Database', callback_data: 'manage_db' }
    ]);
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
        [{ text: BUTTON.CREATE_VPS }, { text: BUTTON.DEPOSIT }],
        [{ text: BUTTON.BALANCE }, { text: BUTTON.FAQ }],
        [{ text: BUTTON.MENU }]
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
  { command: 'install',      description: '🖥️ Install RDP Windows' },
  { command: 'multiinstall', description: '📦 Install RDP ke banyak VPS' },
  { command: 'createvps',    description: '☁️ Buat VPS via DigitalOcean' },
  { command: 'deposit',      description: '💰 Isi saldo' },
  { command: 'saldo',        description: '💳 Cek saldo' },
  { command: 'faq',          description: '❓ Bantuan & panduan' },
  { command: 'batal',        description: '❌ Batalkan proses berjalan' }
];

module.exports = {
  BUTTON,
  BOT_COMMANDS,
  createMainMenu,
  createPersistentKeyboard
};
