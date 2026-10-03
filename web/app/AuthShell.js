import { MonitorDown, ShieldCheck, Wallet, Cloud, Server } from 'lucide-react';

const FEAT = [
  [MonitorDown, 'Install RDP otomatis', 'Ubah VPS Ubuntu jadi RDP Windows (XP sampai Server 2025) tanpa ribet.'],
  [ShieldCheck, 'Gagal? Saldo kembali', 'Biaya hanya untuk VPS yang berhasil. Yang gagal otomatis di-refund.'],
  [Wallet, 'Deposit QRIS instan', 'Semua e-wallet & m-banking, saldo masuk otomatis.'],
  [Cloud, 'Kontrol DigitalOcean', 'Buat & kelola droplet langsung dari dashboard.']
];

export default function AuthShell({ children }) {
  return (
    <div className="auth">
      <section className="auth-side">
        <div className="brand" style={{ color: '#fff', padding: 0 }}>
          <span className="brand-mark" style={{ background: 'rgba(255,255,255,.18)' }}><Server size={18} /></span>
          RDP Installer
        </div>
        <div>
          <h2>RDP Windows siap pakai,<br />dari VPS Anda sendiri.</h2>
          <p>Daftar gratis, deposit via QRIS, lalu pasang RDP Windows ke VPS Anda dalam hitungan menit.</p>
          <div className="auth-feat">
            {FEAT.map(([Icon, t, d]) => (
              <div key={t}><span className="ic"><Icon size={18} /></span><div><b>{t}</b><span>{d}</span></div></div>
            ))}
          </div>
        </div>
        <p style={{ fontSize: 13 }}>Butuh bantuan? <a href="https://wa.me/6285173329868" style={{ color: '#fff', textDecoration: 'underline' }}>Hubungi admin</a></p>
      </section>
      <main className="auth-main"><div className="auth-card">{children}</div></main>
    </div>
  );
}
