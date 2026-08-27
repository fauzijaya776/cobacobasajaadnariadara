/**
 * TIDAK DIPAKAI LAGI.
 *
 * Penyimpanan sudah pindah ke file JSON (lihat src/utils/store.js), sehingga
 * bot tidak lagi membutuhkan database apa pun — tidak SQLite, tidak Turso.
 *
 * File ini sengaja dibiarkan agar impor lama yang mungkin tertinggal gagal
 * dengan pesan jelas, bukan diam-diam memakai data kosong.
 */
throw new Error(
  'src/config/database.js sudah tidak dipakai. Gunakan require("../utils/store") sebagai gantinya.'
);
