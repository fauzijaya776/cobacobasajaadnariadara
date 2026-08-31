async function handleFAQ(bot, chatId, messageId) {
  const faqText =
`❓ *FAQ - Pertanyaan Umum*

☁️ *Buat VPS (DigitalOcean)*
Bikin VPS baru langsung dari bot pakai akun DigitalOcean kamu sendiri.

*Cara pakai:*
1. Klik menu ☁️ Buat VPS.
2. Kirim Personal Access Token DigitalOcean (harus scope *Write*). Ambil di: cloud.digitalocean.com → API → Tokens → Generate New Token (centang Write).
3. Pilih region → ukuran → OS → jumlah droplet (1-10).
4. Kirim password root, atau tekan 🎲 Buatkan otomatis.
5. Bot bikin VPS lalu kirim IP + user \`root\` + password.

*Biaya:* Rp 1.000 flat per proses — mau bikin 1 atau 10 VPS tetap Rp 1.000. Sewa VPS-nya sendiri ditagih DigitalOcean langsung ke akun kamu.

*Password root VPS:* wajib ada simbol, huruf besar, huruf kecil, dan angka, serta karakter terakhir HARUS huruf.
Contoh: \`@Mbahfauzi2025digital\`
Simbol yang boleh: \`!@#%^&*()_-+=.,?\`

*Catatan:*
• Token & password otomatis dihapus dari chat.
• Login password aktif ~1 menit setelah VPS menyala.
• VPS yang sudah jadi bisa langsung dipasang RDP lewat menu 🖥️ Install RDP.

━━━━━━━━━━━━━━

🖥️ *Install RDP & 📦 Multi Install*
Ubah VPS Ubuntu jadi Windows RDP. Multi Install memasang ke banyak VPS sekaligus (Rp 1.000 per VPS).
*Password RDP Windows:* cukup huruf dan angka, minimal 8. Contoh: \`Fauzi2024\`.

_Beda dengan password VPS di atas ya: RDP tanpa simbol, VPS wajib pakai simbol._

━━━━━━━━━━━━━━

🔒 *Langkah Wajib Setelah Proses Installasi RDP Selesai*

*1. Mengatur Account Lockout Threshold Jadi Nol*

Langkah pertama ini bakal bikin akun kamu nggak akan terkunci lagi walaupun ada beberapa kali login gagal. Cocok banget buat menghindari gangguan penguncian akun.

*Caranya:*
1. Tekan tombol Windows + R, ketik secpol.msc, lalu tekan Enter.
2. Ini akan membuka jendela Local Security Policy.
3. Pergi ke Account Policies > Account Lockout Policy.
4. Cari Account lockout threshold, klik dua kali.
5. Ubah nilainya jadi 0 (nol), lalu klik OK.

*TIPS TAMBAHAN*

1. Tekan Monitor Insttalation Untuk Melihat proses installasinya.
2. Jika Muncul Pesan "NoVNC Encountered An Error" di monitoring installation, abaikan saja, tunggu 10 menit-1 jam sampai proses benar-benar selesai.
3. Sambil menunggu, anda dapat melakukan instalasi lain secara bersamaan.
4. Jika ingin bertanya, hubungi admin di wa.me/6285173329868.
5. Untuk memulai bot lagi, ketik /start`;

  await bot.editMessageText(faqText, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '« Kembali', callback_data: 'back_to_menu' }
      ]]
    }
  });
}

module.exports = {
  handleFAQ
};
