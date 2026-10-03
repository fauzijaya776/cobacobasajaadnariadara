const { safeEdit } = require('../utils/telegram');
const { INSTALLATION_COST, VPS_CREATE_COST } = require('../config/constants');

async function handleFAQ(bot, chatId, messageId) {
  const rp = (n) => `Rp ${Number(n).toLocaleString('id-ID')}`;
  const faqText =
`❓ *FAQ & Bantuan*

🖥️ *Install RDP*
Ubah VPS Ubuntu jadi RDP Windows. Kirim IP + password VPS, pilih versi Windows, buat password RDP, tunggu ±15–45 menit. ${rp(INSTALLATION_COST())}/VPS, saldo dipotong *hanya kalau berhasil*.

📦 *Multi Install RDP*
Pasang RDP ke banyak VPS sekaligus (maks 10). Satu baris = satu VPS: \`IP PASSWORD\`. Ditagih per VPS yang berhasil.

☁️ *Control DO via API*
Pakai token DigitalOcean Anda sendiri (scope *Write*): buat droplet 1–10 sekaligus (${rp(VPS_CREATE_COST())} flat/batch), lihat daftar, nyalakan/matikan/reboot, reset password root, snapshot, hapus droplet, cek tagihan — selain buat droplet semuanya gratis. Token hanya disimpan sementara di memori bot.

💰 *Deposit Saldo*
Isi saldo via QRIS (semua e-wallet & m-banking). Bayar persis sesuai nominal, saldo masuk otomatis. Kalau belum masuk 1–2 menit, tekan *Cek Status Pembayaran*.

🔑 *Aturan Password*
• RDP Windows: huruf + angka, min 8, tanpa simbol. Contoh \`Fauzi2024\`
• Root droplet DO: wajib simbol + huruf besar/kecil + angka, karakter terakhir huruf. Contoh \`@Mbahfauzi2025x\`

🔌 *Cara connect RDP*
Buka Remote Desktop (Windows) / Microsoft Remote Desktop (HP) → IP VPS, user \`admin\`, password RDP yang Anda buat.

💡 *Tips*
• Link monitor \`http://IP:8006\` menampilkan layar Windows saat dipasang. Tulisan "NoVNC encountered an error" itu normal saat Windows restart — tunggu saja.
• Tunggu Windows Setup benar-benar selesai (10–60 menit) sebelum connect RDP.
• Satu akun hanya bisa menjalankan satu proses instalasi dalam satu waktu; pakai *Multi Install* untuk banyak VPS.
• Setelah RDP jadi, set *Account lockout threshold* = 0 (secpol.msc → Account Policies → Account Lockout Policy) agar akun tidak terkunci.
• Instalasi gagal? Saldo tidak terpotong. Pastikan VPS fresh Ubuntu, spek cukup, dan mendukung KVM.

🆘 Admin: wa.me/6285173329868`;

  await safeEdit(bot, faqText, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: '🏢 Rekomendasi VPS', callback_data: 'providers' }],
        [{ text: '« Kembali', callback_data: 'back_to_menu' }]
      ]
    }
  });
}

module.exports = {
  handleFAQ
};
