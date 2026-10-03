/**
 * Pengaturan yang bisa diubah admin dari panel website, dipakai bot Telegram
 * DAN website: harga, mode maintenance, iklan, dan daftar user yang diblokir.
 * Disimpan di store (ikut file data + cadangan Telegram), jadi tetap ada
 * walau server restart.
 */
const store = require('./store');

const DEFAULTS = { installCost: 1000, vpsCreateCost: 1000 };

function settings() {
  if (!store.data.settings || typeof store.data.settings !== 'object') store.data.settings = {};
  return store.data.settings;
}

/** Harga terkini; nilai tidak sah jatuh ke default. */
function price(key) {
  const v = Number(settings()[key]);
  return Number.isInteger(v) && v >= 0 ? v : DEFAULTS[key];
}

/** Pesan maintenance kalau sedang aktif, selain itu null. */
function maintenanceMessage() {
  const m = settings().maintenance;
  if (!m || !m.on) return null;
  return String(m.message || '').trim() || 'Layanan sedang dalam perbaikan. Silakan coba lagi beberapa saat lagi.';
}

function blocked() {
  if (!store.data.blocked || typeof store.data.blocked !== 'object') store.data.blocked = {};
  return store.data.blocked;
}

/** Info blokir user ({at, by, reason}) atau null. */
function blockedInfo(uid) {
  return blocked()[String(uid)] || null;
}

/** Pesan maintenance untuk user ini (admin selalu null). */
function maintenanceFor(chatId) {
  const { isAdmin } = require('./userManager');
  return isAdmin(chatId) ? null : maintenanceMessage();
}

module.exports = { maintenanceFor, DEFAULTS, settings, price, maintenanceMessage, blocked, blockedInfo };
