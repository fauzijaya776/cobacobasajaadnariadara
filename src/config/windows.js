/**
 * minRam = RAM minimal (GB) yang realistis agar instalasi versi ini berhasil di QEMU.
 * Angka ini dipakai untuk menolak kombinasi yang pasti gagal SEBELUM saldo
 * dipotong dan sebelum user menunggu 40 menit sia-sia.
 *
 * minDisk = ruang disk minimal (GB) untuk image Windows-nya.
 */
const WINDOWS_VERSIONS = [
  // Windows Desktop
  { id: 1,  name: 'Windows 11 Pro',           price: 1000, category: 'desktop', minRam: 4, minDisk: 25 },
  { id: 2,  name: 'Windows 11 Enterprise',    price: 1000, category: 'desktop', minRam: 4, minDisk: 25 },
  { id: 3,  name: 'Windows 10 Pro',           price: 1000, category: 'desktop', minRam: 2, minDisk: 20 },
  { id: 4,  name: 'Windows 10 LTSC',          price: 1000, category: 'desktop', minRam: 2, minDisk: 20 },
  { id: 5,  name: 'Windows 10 Enterprise',    price: 1000, category: 'desktop', minRam: 2, minDisk: 20 },
  { id: 17, name: 'Windows 11 LTSC',          price: 1000, category: 'desktop', minRam: 4, minDisk: 25 },
  { id: 6,  name: 'Windows 8.1 Pro',          price: 1000, category: 'desktop', minRam: 2, minDisk: 16 },
  { id: 7,  name: 'Windows 8.1 Enterprise',   price: 1000, category: 'desktop', minRam: 2, minDisk: 16 },
  { id: 8,  name: 'Windows 7 Enterprise',     price: 1000, category: 'desktop', minRam: 2, minDisk: 16 },
  { id: 9,  name: 'Windows Vista Enterprise', price: 1000, category: 'desktop', minRam: 1, minDisk: 15 },
  { id: 10, name: 'Windows XP Professional',  price: 1000, category: 'desktop', minRam: 1, minDisk: 10 },

  // Windows Server
  { id: 11, name: 'Windows Server 2022',      price: 1000, category: 'server',  minRam: 4, minDisk: 25 },
  { id: 12, name: 'Windows Server 2019',      price: 1000, category: 'server',  minRam: 2, minDisk: 20 },
  { id: 13, name: 'Windows Server 2016',      price: 1000, category: 'server',  minRam: 2, minDisk: 20 },
  { id: 14, name: 'Windows Server 2012',      price: 1000, category: 'server',  minRam: 2, minDisk: 16 },
  { id: 15, name: 'Windows Server 2008',      price: 1000, category: 'server',  minRam: 1, minDisk: 15 },
  { id: 16, name: 'Windows Server 2025',      price: 1000, category: 'server',  minRam: 4, minDisk: 25 },
  { id: 18, name: 'Windows Server 2003',      price: 1000, category: 'server',  minRam: 1, minDisk: 10 }
];

/** Apakah spesifikasi VPS cukup untuk versi Windows ini. */
function isVersionCompatible(version, allocation) {
  return (
    allocation.ram >= (version.minRam || 1) &&
    allocation.storage >= (version.minDisk || 15)
  );
}

/** Daftar versi yang muat di VPS ini. */
function getCompatibleVersions(allocation) {
  return WINDOWS_VERSIONS.filter((v) => isVersionCompatible(v, allocation));
}

function findVersion(id) {
  return WINDOWS_VERSIONS.find((v) => v.id === Number(id)) || null;
}

module.exports = {
  WINDOWS_VERSIONS,
  isVersionCompatible,
  getCompatibleVersions,
  findVersion
};
