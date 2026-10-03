const { WINDOWS_VERSIONS } = require('./windows');
const { VPS_CONFIGS } = require('./vps');
const { price } = require('../utils/settings');

/**
 * Harga berupa FUNGSI karena bisa diubah admin dari panel website kapan saja
 * (lihat utils/settings.js). Panggil INSTALLATION_COST() setiap kali dipakai,
 * jangan disimpan ke variabel jangka panjang.
 *
 * INSTALLATION_COST(): biaya install RDP per VPS.
 * VPS_CREATE_COST():   biaya layanan buat droplet DO, flat per batch (1-10).
 */
const INSTALLATION_COST = () => price('installCost');
const VPS_CREATE_COST = () => price('vpsCreateCost');

module.exports = {
  WINDOWS_VERSIONS,
  VPS_CONFIGS,
  INSTALLATION_COST,
  VPS_CREATE_COST
};
