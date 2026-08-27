/**
 * Ukuran RAM yang biasa dijual provider VPS.
 * `free -m` selalu melaporkan sedikit lebih kecil dari nominal karena kernel
 * sudah memesan sebagian memori (VPS 4 GB terbaca ~3.8 GB). Untuk tampilan dan
 * alokasi kita pakai angka nominal ini, bukan angka mentah dari `free`.
 */
const NOMINAL_RAM_SIZES = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];

/**
 * Bulatkan RAM mentah ke ukuran nominal terdekat di ATAS-nya,
 * selama selisihnya masuk akal (maksimal 15%).
 *
 * 3.8 -> 4      (VPS 4 GB)
 * 7.7 -> 8      (VPS 8 GB)
 * 15.6 -> 16    (VPS 16 GB)
 * 5.0 -> 6      (selisih 20% > 15% -> tetap 5, tidak dinaikkan paksa)
 */
function toNominalRam(rawGb) {
  const raw = Number(rawGb);
  if (!Number.isFinite(raw) || raw <= 0) return 0;

  for (const size of NOMINAL_RAM_SIZES) {
    if (size >= raw) {
      // Hanya naikkan kalau memang tinggal sedikit lagi (overhead kernel),
      // bukan lompat jauh ke ukuran yang tidak dimiliki VPS.
      return size - raw <= raw * 0.15 ? size : Math.floor(raw);
    }
  }
  return Math.floor(raw);
}

/**
 * Rapikan hasil deteksi mentah.
 *
 * PENTING: RAM dan storage TIDAK dibulatkan ke atas secara membabi buta seperti
 * versi lama (`Math.ceil`). Membulatkan ke atas membuat bot mengalokasikan
 * sumber daya yang secara fisik tidak ada, dan instalasi mati di tengah jalan.
 */
function roundUpSpecs(specs) {
  return {
    cpu: Math.max(1, Math.floor(Number(specs.cpu) || 1)),
    ram: toNominalRam(specs.ram),
    storage: Math.max(1, Math.floor(Number(specs.storage) || 0))
  };
}

/**
 * Hitung alokasi untuk Windows.
 *
 * RAM: dialokasikan PENUH sesuai ukuran VPS (tidak dikurangi).
 * Agar tetap aman, host disiapkan swap file + memory overcommit sebelum
 * instalasi dimulai (lihat prepareHostCommand di rdpInstaller.js). Tanpa swap,
 * alokasi penuh membuat OOM killer menembak QEMU di tengah instalasi.
 *
 * Storage: dihitung dari ruang KOSONG yang benar-benar tersedia, dikurangi
 * swap dan sedikit ruang aman untuk sistem. Versi lama memakai ukuran total
 * filesystem, sehingga VPS yang sudah terpakai sebagian bisa kehabisan disk.
 */
function calculateAllocation(rawSpecs) {
  const ram = toNominalRam(rawSpecs.ram);
  const cpu = Math.max(1, Math.floor(rawSpecs.cpu));

  const swap = recommendedSwapGb(ram);
  const availStorage = Math.floor(Number(rawSpecs.storageAvail ?? rawSpecs.storage) || 0);

  // Sisakan ruang untuk swap file + margin sistem (log, update, temp).
  const SYSTEM_RESERVE_GB = 5;
  const storage = Math.max(0, availStorage - swap - SYSTEM_RESERVE_GB);

  return { cpu, ram, storage, swap };
}

/**
 * Ukuran swap sebagai bantalan OOM.
 * Cukup menutup overhead QEMU + host (~1 GB) pada puncak instalasi,
 * dibatasi supaya tidak memakan disk secara berlebihan.
 */
function recommendedSwapGb(ramGb) {
  if (ramGb <= 4) return 2;
  if (ramGb <= 16) return 4;
  return 6;
}

module.exports = {
  roundUpSpecs,
  toNominalRam,
  calculateAllocation,
  recommendedSwapGb,
  NOMINAL_RAM_SIZES
};
