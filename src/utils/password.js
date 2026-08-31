/**
 * Aturan password. SENGAJA dua aturan berbeda karena kedua installer punya
 * kebutuhan berbeda:
 *
 *  1) Installer RDP (password Windows)  — contoh: Fauzi2024
 *     Hanya huruf & angka, minimal ada satu huruf dan satu angka. Tanpa simbol,
 *     karena password ini diteruskan ke script installer RDP eksternal (rdp.sh)
 *     yang belum tentu menangani simbol dengan aman.
 *
 *  2) Installer VPS (password root droplet DigitalOcean) — contoh: @Mbahfauzi2025digital
 *     Wajib mengandung: simbol, huruf besar, huruf kecil, dan angka; serta
 *     KARAKTER TERAKHIR harus huruf. Password ini hanya masuk ke cloud-init
 *     (aman untuk simbol), jadi aturannya bisa lebih ketat/kuat.
 *
 * Simbol yang diizinkan untuk VPS dibatasi ke set yang aman di YAML cloud-init.
 */

// ---- Installer RDP: huruf + angka ----
const RDP_PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,64}$/;

function isValidRdpPassword(pw) {
  return RDP_PASSWORD_REGEX.test(String(pw == null ? '' : pw));
}

const RDP_PASSWORD_RULE =
  'Minimal 8 karakter, harus ada huruf dan angka (tanpa simbol)';

// ---- Installer VPS: simbol + besar + kecil + angka, diakhiri huruf ----
// Simbol aman untuk cloud-init: ! @ # % ^ & * ( ) _ - + = . , ?
const VPS_PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#%^&*()_+=.,?\-])[A-Za-z0-9!@#%^&*()_+=.,?\-]{7,63}[A-Za-z]$/;

function isValidVpsPassword(pw) {
  return VPS_PASSWORD_REGEX.test(String(pw == null ? '' : pw));
}

// Catatan: teks aturan sengaja TIDAK memuat karakter simbol mentah, karena
// beberapa di antaranya (* dan _) adalah penanda Markdown Telegram dan akan
// merusak format kalau ditempel langsung ke pesan. Daftar simbolnya dipisah ke
// VPS_SYMBOLS agar bisa ditampilkan di dalam backtick (aman).
const VPS_PASSWORD_RULE =
  'Panjang 8-64, wajib ada simbol, huruf besar, huruf kecil, dan angka, ' +
  'serta karakter terakhir harus huruf';

/** Daftar simbol yang diizinkan — tampilkan SELALU di dalam backtick. */
const VPS_SYMBOLS = '!@#%^&*()_-+=.,?';

module.exports = {
  isValidRdpPassword,
  RDP_PASSWORD_RULE,
  RDP_PASSWORD_REGEX,
  isValidVpsPassword,
  VPS_PASSWORD_RULE,
  VPS_PASSWORD_REGEX,
  VPS_SYMBOLS
};
