function createPaymentMessage(paymentData, amount) {
  const totalBayar = Number(paymentData.totalBayar ?? amount);
  const messageText = `💰 *Deposit Saldo*\n\n` +
    `Nominal Deposit: Rp ${amount.toLocaleString('id-ID')}\n` +
    `Total Bayar: Rp ${totalBayar.toLocaleString('id-ID')}\n\n` +
    `*Panduan Pembayaran QRIS:*\n` +
    `1. Scan QR Code di atas\n` +
    `2. Konfirmasi & selesaikan pembayaran\n` +
    `3. Tunggu saldo masuk otomatis\n` +
    `4. Jika ada kendala chat wa.me/6285173329868\n\n` +
    `⏳ Pembayaran akan kadaluarsa sesuai waktu yang tercantum di QRIS.`;

  return {
    messageText,
    keyboard: {}
  };
}

function createSuccessMessage(amount, newBalance) {
  return `✅ *Pembayaran Berhasil!*\n\n` +
    `💰 Saldo ditambahkan: Rp ${amount.toLocaleString('id-ID')}\n` +
    `💳 Saldo saat ini: Rp ${newBalance.toLocaleString('id-ID')}`;
}

function createErrorMessage(status) {
  return status === 'Expired'
    ? '⏰ Waktu pembayaran telah habis.'
    : '❌ Pembayaran dibatalkan.';
}

/**
 * Tampilan spesifikasi.
 *
 * RAM ditampilkan PENUH sesuai ukuran VPS — tidak ada pengurangan.
 * Storage tetap disebut apa adanya karena sebagian ruang dipakai sistem host
 * dan swap; angkanya dihitung dari ruang kosong yang benar-benar tersedia.
 */
function formatVPSSpecs(rawSpecs, allocation) {
  return `📊 *Spesifikasi VPS*\n\n` +
    `• CPU: ${allocation.cpu} Core\n` +
    `• RAM: ${allocation.ram} GB\n` +
    `• Storage: ${allocation.storage} GB\n\n` +
    `_RAM dialokasikan penuh ke Windows._\n\n`;
}

/** Versi ringkas untuk ditempel di pesan lain. */
function formatAllocationLine(allocation) {
  return `${allocation.cpu} Core · ${allocation.ram} GB RAM · ${allocation.storage} GB Storage`;
}

module.exports = {
  createPaymentMessage,
  createSuccessMessage,
  createErrorMessage,
  formatVPSSpecs,
  formatAllocationLine
};
