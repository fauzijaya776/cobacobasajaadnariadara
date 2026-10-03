'use client';
import { Mail, ShieldCheck, Zap, Heart, Gamepad2, Music, ArrowUpRight } from 'lucide-react';

const UTM = '?utm_source=rdpinstaller&utm_medium=banner';

/** Ilustrasi kotak masuk dengan kode OTP (RentalMail). */
function InboxArt() {
  return (
    <div className="ad-art" aria-hidden="true">
      <div className="ad-mail">
        <div className="ad-mail-head"><Mail size={14} /> Inbox sementara</div>
        <div className="ad-mail-row"><b>Instagram</b><span>Kode verifikasi Anda</span></div>
        <div className="ad-otp">482 913</div>
        <div className="ad-mail-row dim"><b>GitHub</b><span>Confirm your email</span></div>
      </div>
    </div>
  );
}

/** Ilustrasi amplop surat cinta + hati (KadoVirtual). */
function LoveArt() {
  return (
    <div className="ad-art" aria-hidden="true">
      <svg viewBox="0 0 160 120" className="ad-love">
        <rect x="18" y="34" width="124" height="78" rx="10" fill="#fff" />
        <path d="M18 44 L80 84 L142 44" fill="none" stroke="#fbcfe8" strokeWidth="4" />
        <path d="M80 70c-10-9-22-15-22-26a11 11 0 0 1 22-3 11 11 0 0 1 22 3c0 11-12 17-22 26z" fill="#f43f5e" />
        <path d="M128 18c-4-4-9-6-9-11a5 5 0 0 1 9-1 5 5 0 0 1 9 1c0 5-5 7-9 11z" fill="#fff" opacity=".9" />
        <path d="M28 22c-3-3-7-5-7-9a4 4 0 0 1 7-1 4 4 0 0 1 7 1c0 4-4 6-7 9z" fill="#fff" opacity=".7" />
      </svg>
    </div>
  );
}

export default function Ads() {
  return (
    <div className="ads">
      <a className="ad ad-rentalmail" href={`https://rentalmail.my.id${UTM}`} target="_blank" rel="sponsored noopener">
        <span className="ad-tag">Sponsor</span>
        <div className="ad-body">
          <div className="ad-brand"><span className="ad-logo"><Mail size={16} /></span> Rental Mail</div>
          <div className="ad-title">Email sementara buat OTP, masuk dalam hitungan detik.</div>
          <div className="ad-points">
            <span><Zap size={13} /> Instan</span><span><ShieldCheck size={13} /> Privasi aman</span><span>Instagram · GitHub · ChatGPT · PayPal</span>
          </div>
          <span className="ad-cta">Order sekarang · mulai Rp750 <ArrowUpRight size={15} /></span>
        </div>
        <InboxArt />
      </a>

      <a className="ad ad-kado" href={`https://kadovirtual.my.id${UTM}`} target="_blank" rel="sponsored noopener">
        <span className="ad-tag">Sponsor</span>
        <div className="ad-body">
          <div className="ad-brand"><span className="ad-logo"><Heart size={16} /></span> Kado Virtual</div>
          <div className="ad-title">Surat cinta digital yang bisa dimainkan. Bikin dia senyum!</div>
          <div className="ad-points">
            <span><Gamepad2 size={13} /> Mini game</span><span><Music size={13} /> Musik & foto</span><span>QR hati · tanpa daftar</span>
          </div>
          <span className="ad-cta">Pilih template · mulai Rp5.000 <ArrowUpRight size={15} /></span>
        </div>
        <LoveArt />
      </a>
    </div>
  );
}
