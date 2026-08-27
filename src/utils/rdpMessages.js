const createInputMessage = (type, error = null) => {
  const messages = {
    ip: {
      title: '📝 *Masukkan detail VPS*',
      instruction: '🌐 Kirim IP VPS (port SSH dideteksi otomatis, atau tulis `IP:PORT`):',
      note: '_IP akan dihapus otomatis setelah dikirim untuk keamanan_'
    },
    password: {
      title: '🔑 *Masukkan Password VPS*',
      instruction: 'Silakan masukkan password root VPS:',
      note: '_Password akan dihapus otomatis setelah dikirim untuk keamanan_'
    }
  };

  const msg = messages[type];
  return `${msg.title}\n\n` +
    `${msg.instruction}\n` +
    `${msg.note}\n\n` +
    `⚠️ *PENTING:* VPS wajib fresh install Ubuntu 20.04/22.04/24.04` +
    (error ? `\n\n❌ Error: ${error}` : '');
};

const createVpsSpecsMessage = (windowsVersion) => {
  return `🖥️ *Konfigurasi Instalasi*\n\n` +
    `Windows: ${windowsVersion.name}\n` +
    `💰 Harga: Rp ${windowsVersion.price.toLocaleString('id-ID')}\n\n` +
    `⚠️ *PENTING:* VPS wajib fresh install Ubuntu 20.04/22.04/24.04\n\n` +
    `*Alokasi sumber daya:*\n` +
    `• CPU: seluruh core VPS\n` +
    `• RAM: penuh sesuai ukuran VPS — tidak dikurangi\n` +
    `• Storage: seluruh ruang kosong yang tersedia`;
};

module.exports = {
  createInputMessage,
  createVpsSpecsMessage
};
