// src/handlers/agpAdminHandler.js
// Atur AutoGoPay tanpa akses Environment Render — dipakai Telegram DAN panel admin website.
//
// Telegram (khusus ADMIN_ID, hanya di chat pribadi):
//   /setagpkey agp_xxx                    simpan API key (pesan langsung dihapus)
//   /agpkey                               status (key tersamar)
//   /agpgateway autogopay|pakasir|auto    pilih gateway deposit baru
//   /hapusagpkey                          hapus key yang disimpan admin
//
// Setiap perubahan dikabarkan ke SEMUA admin, supaya perubahan yang bukan dari Anda
// (mis. dari orang yang memegang token bot lama yang pernah bocor) langsung ketahuan.
const agpConfig = require('../utils/agpConfig');
const autogopay = require('../utils/autogopay');
const gateway = require('../utils/gateway');
const { isAdmin } = require('../utils/userManager');

const adminIds = () => String(process.env.ADMIN_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB' : '-');

async function statusText({ verify = true } = {}) {
  const d = gateway.describe();
  const lines = [
    `Gateway deposit baru: ${d.gateway === 'autogopay' ? 'AutoGoPay' : 'Pakasir'} (diatur: ${d.providerSource})`,
    `API key AutoGoPay: ${d.keyMasked ? `${d.keyMasked} (dari ${d.keySource === 'env' ? 'Environment Render' : 'admin'})` : 'belum ada'}`,
  ];
  if (d.keySource === 'admin') lines.push(`Disimpan: ${fmt(d.keySetAt)} oleh ${d.keySetBy || '-'}`);
  if (d.decryptFailed) lines.push('⚠️ Key tersimpan tidak bisa dibuka (WEB_SECRET/BOT_TOKEN berubah?). Simpan ulang key.');
  if (!d.webSecretSet && d.keySource !== 'env') lines.push('⚠️ WEB_SECRET kosong di Render: key tidak bisa disimpan lewat admin.');
  if (verify && d.keyMasked) {
    const v = await autogopay.verifyKey(agpConfig.apiKey());
    lines.push(v.ok ? 'Cek ke AutoGoPay: ✅ key aktif' : `Cek ke AutoGoPay: ❌ ${v.reason}`);
  }
  return lines.join('\n');
}

async function notifyAdmins(bot, text, exceptChatId) {
  for (const id of adminIds()) {
    if (String(id) === String(exceptChatId)) continue;
    await bot.sendMessage(id, `🔐 [AutoGoPay] ${text}`).catch(() => {});
  }
}

/** @returns {Promise<{ok:boolean, message:string}>} */
async function setKey(bot, key, by, viaChatId) {
  key = String(key || '').trim();
  if (!agpConfig.looksLikeKey(key)) return { ok: false, message: 'Format key salah. Contoh: agp_xxxxxxxx (dari dashboard autogopay.site).' };
  if (!process.env.WEB_SECRET) return { ok: false, message: 'WEB_SECRET belum diisi di Environment Render, jadi key tidak bisa disimpan dengan aman.' };
  // Verifikasi tanpa membuat QRIS (hanya membaca daftar transaksi).
  const check = await autogopay.verifyKey(key);
  if (!check.ok) return { ok: false, message: `Key TIDAK disimpan: ${check.reason}` };
  await agpConfig.saveKey(key, by);
  await notifyAdmins(bot, `API key diganti oleh ${by} → ${agpConfig.mask(key)}. Bukan Anda? Segera ganti key di dashboard AutoGoPay.`, viaChatId);
  return { ok: true, message: `Key AutoGoPay disimpan (terenkripsi).\n\n${await statusText()}` };
}

async function setGateway(bot, choice, by, viaChatId) {
  choice = String(choice || '').trim().toLowerCase();
  if (!['autogopay', 'pakasir', 'auto'].includes(choice)) return { ok: false, message: 'Pilihan: autogopay, pakasir, atau auto.' };
  if (choice === 'autogopay' && !agpConfig.apiKey()) return { ok: false, message: 'Belum ada API key AutoGoPay. Simpan key dulu.' };
  await agpConfig.setProvider(choice);
  await notifyAdmins(bot, `Gateway deposit diubah oleh ${by} → ${choice}.`, viaChatId);
  return { ok: true, message: `Pengaturan gateway disimpan. Deposit lama tetap dicek ke gateway pembuatnya.\n\n${await statusText()}` };
}

async function clearKey(bot, by, viaChatId) {
  await agpConfig.clearKey();
  await notifyAdmins(bot, `API key yang disimpan admin DIHAPUS oleh ${by}.`, viaChatId);
  return { ok: true, message: `Key AutoGoPay yang disimpan admin sudah dihapus.\n\n${await statusText({ verify: false })}` };
}

function registerAgpCommands(bot, dataSiap) {
  const arg = (msg, cmd) => String(msg.text || '').replace(new RegExp(`^/${cmd}(@\\w+)?\\s*`, 'i'), '').trim();
  const send = (chatId, text) => bot.sendMessage(chatId, text).catch(() => {});

  bot.onText(/^\/setagpkey(@\w+)?\b/i, async (msg) => {
    // Pesan berisi key dihapus SECEPATNYA, siapa pun pengirimnya.
    await bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    if (!isAdmin(msg.from && msg.from.id)) return;
    if (msg.chat.type !== 'private') {
      return send(msg.chat.id, '⚠️ Key dikirim di grup. Pesannya sudah dihapus, tapi anggap key itu BOCOR: buat key baru di dashboard AutoGoPay, lalu kirim lewat chat PRIBADI dengan bot (atau panel admin website).');
    }
    await dataSiap;
    const r = await setKey(bot, arg(msg, 'setagpkey'), `telegram:${msg.from.id}`, msg.chat.id);
    return send(msg.chat.id, `${r.ok ? '✅' : '❌'} ${r.message}\n\nPesanmu yang berisi key sudah dihapus.`);
  });

  bot.onText(/^\/agpkey(@\w+)?\b/i, async (msg) => {
    if (!isAdmin(msg.from && msg.from.id)) return;
    await dataSiap;
    return send(msg.chat.id, await statusText());
  });

  bot.onText(/^\/agpgateway(@\w+)?\b/i, async (msg) => {
    if (!isAdmin(msg.from && msg.from.id)) return;
    await dataSiap;
    const r = await setGateway(bot, arg(msg, 'agpgateway'), `telegram:${msg.from.id}`, msg.chat.id);
    return send(msg.chat.id, `${r.ok ? '✅' : '❌'} ${r.message}${r.ok ? '' : '\nFormat: /agpgateway autogopay | pakasir | auto'}`);
  });

  bot.onText(/^\/hapusagpkey(@\w+)?\b/i, async (msg) => {
    if (!isAdmin(msg.from && msg.from.id)) return;
    await dataSiap;
    const r = await clearKey(bot, `telegram:${msg.from.id}`, msg.chat.id);
    return send(msg.chat.id, `🗑️ ${r.message}`);
  });
}

module.exports = { registerAgpCommands, statusText, setKey, setGateway, clearKey };
