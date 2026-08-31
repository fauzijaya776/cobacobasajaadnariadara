const { WINDOWS_VERSIONS } = require('./windows');
const { VPS_CONFIGS, INSTALLATION_COST } = require('./vps');

/**
 * Biaya layanan (bukan tagihan DigitalOcean) untuk membuat 1 batch droplet
 * lewat fitur "Buat VPS". Flat: berapa pun jumlah droplet (1-10), potongannya
 * tetap segini.
 */
const VPS_CREATE_COST = 1000;

module.exports = {
  WINDOWS_VERSIONS,
  VPS_CONFIGS,
  INSTALLATION_COST,
  VPS_CREATE_COST
};
