const axios = require('axios');
const crypto = require('crypto');

const PAYMENTS_URL = 'https://api.dompetx.com/v1/payments';

function getApiKey() {
  const apiKey = process.env.API_KEY_DOMPETX;
  if (!apiKey) throw new Error('API_KEY_DOMPETX belum diatur pada file .env.');
  return apiKey;
}

function headers(apiKey, body, idempotencyKey) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto
    .createHmac('sha256', apiKey)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  return {
    'Content-Type': 'application/json',
    'X-DOMPAY-API-Key': apiKey,
    'X-DOMPAY-Signature': signature,
    'X-DOMPAY-Timestamp': timestamp,
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
  };
}

function normalizePayment(payload, reference) {
  const payment = payload?.data?.id ? payload.data : payload;
  const amount = Number(payment?.amount ?? payment?.getBalance);
  const fee = Number(payment?.fee || 0) + Number(payment?.additionalFee || 0);
  const totalBayar = Number(payment?.totalAmount ?? payment?.total ?? (amount + fee));
  const qrString = payment?.qrData?.qrString ?? payment?.qrString;

  if (!payment?.id || !qrString || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(totalBayar)) {
    throw new Error('Respons QRIS dari DompetX tidak lengkap.');
  }

  return {
    id: payment.id,
    reference,
    amount,
    totalBayar,
    fee,
    qr_string: qrString,
    qr_image: payment?.qrData?.qrImage ?? payment?.qrImage,
    expired_at: payment?.expiresAt ?? payment?.expiredAt
  };
}

async function createPayment(reference, amount) {
  const nominal = Number(amount);
  if (!Number.isFinite(nominal) || nominal <= 0) {
    throw new Error('Nominal deposit tidak valid.');
  }

  const apiKey = getApiKey();
  const body = JSON.stringify({ method: 'QRIS', amount: nominal, currency: 'IDR', reference });
  try {
    const response = await axios.post(PAYMENTS_URL, body, {
      headers: headers(apiKey, body, `deposit_${reference}_${crypto.randomUUID()}`),
      timeout: 30000
    });
    return normalizePayment(response.data, reference);
  } catch (error) {
    const message = error.response?.data?.message || error.message || 'Gagal membuat QRIS DompetX.';
    console.error('[DOMPETX CREATE ERROR]', error.response?.status || '', message);
    throw new Error(message);
  }
}

async function checkPaymentStatus(paymentId) {
  const apiKey = getApiKey();
  const body = '{}';
  try {
    const response = await axios.get(`${PAYMENTS_URL}/check-status/${encodeURIComponent(paymentId)}`, {
      headers: headers(apiKey, body),
      timeout: 30000
    });
    return response.data?.data || response.data;
  } catch (error) {
    const message = error.response?.data?.message || error.message || 'Gagal mengecek status DompetX.';
    console.error('[DOMPETX STATUS ERROR]', error.response?.status || '', message);
    throw new Error(message);
  }
}

module.exports = { createPayment, checkPaymentStatus };
