import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Semua /api/* diteruskan ke server bot (Render). Website tidak punya database
// sendiri: saldo & riwayat tetap satu sumber dengan bot Telegram.
const BOT_API_URL = (process.env.BOT_API_URL || 'http://localhost:3000').replace(/\/+$/, '');
const dev = process.env.NODE_ENV !== 'production';
// SSH online memakai WebSocket langsung ke server bot (Vercel tidak meneruskan WS).
const WS_ORIGIN = BOT_API_URL.replace(/^http/, 'ws');

// CSP: semua dari domain sendiri. 'unsafe-inline' untuk script dibutuhkan
// Next.js (skrip hidrasi inline); eval hanya diizinkan saat development.
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${WS_ORIGIN}`,
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'"
].join('; ');

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CSP },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }
];

export default {
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${BOT_API_URL}/api/:path*` }];
  }
};
