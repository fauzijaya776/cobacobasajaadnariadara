const { safeEdit } = require('../utils/telegram');

async function handleProviders(bot, chatId, messageId) {
  const providers = `🏢 *Rekomendasi Provider VPS (support KVM)*

_Pilih VPS minimal 2 Core · 4 GB RAM · 40 GB disk, OS Ubuntu 22.04._

🇮🇩 *Provider Lokal:*
• Nevacloud
• Flaz VPS
• Warnahost
• OrangeVPS
• Jetorbit
• IDCloudHost
• Natanetwork
• RumahWeb
• Biznet Neo Virtual Compute
• Datalix

🌍 *Provider Internasional:*
• DigitalOcean (bisa dibuat langsung lewat menu ☁️ Control DO)
• LightNode
• Kuroit
• OVHcloud
• Crunchbits
• HostHatch
• Hetzner
• DedicatedCore
• GreenCloud
• AkileCloud
• Ultahost
• ByteVirt
• Datawagon
• Avoro
• Atlantic.Net
• Vebble`;

  await safeEdit(bot, providers, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '☁️ Control DO via API', callback_data: 'do_start' }],
        [{ text: '« Kembali', callback_data: 'back_to_menu' }]
      ]
    }
  });
}

module.exports = {
  handleProviders
};
