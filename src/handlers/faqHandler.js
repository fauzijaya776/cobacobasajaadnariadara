async function handleFAQ(bot, chatId, messageId) {
  const faqText =
`❓ *FAQ Singkat*

🖥️ *Install RDP*
Ubah VPS Ubuntu jadi Windows RDP. Kirim IP + password VPS, pilih Windows, tunggu. Rp 1.000/VPS, saldo terpotong hanya kalau berhasil.

📦 *Multi Install*
Pasang RDP ke banyak VPS sekaligus (1 baris = 1 VPS: \`ip password\`).

☁️ *Buat VPS (DigitalOcean)*
Bikin VPS baru pakai token DO kamu sendiri (scope *Write*). Rp 1.000 flat 1–10 VPS; sewa VPS ditagih DO ke akunmu.

💰 *Deposit*
Isi saldo via QRIS. Saldo masuk otomatis setelah dibayar.

🔑 *Aturan Password*
• RDP Windows: huruf + angka, min 8. Contoh \`Fauzi2024\`
• Root VPS (DO): wajib simbol + huruf besar/kecil + angka, karakter terakhir huruf. Contoh \`@Mbahfauzi2025x\`

💡 *Tips*
• Kalau muncul "NoVNC Encountered An Error" saat monitoring, abaikan — tunggu 10–60 menit sampai selesai.
• Bisa jalankan beberapa instalasi sekaligus.
• Setelah RDP jadi, set *Account lockout threshold* = 0 (secpol.msc → Account Policies → Account Lockout Policy) biar akun tak terkunci.

🆘 Admin: wa.me/6285173329868 · Ketik /start untuk buka menu.`;

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
