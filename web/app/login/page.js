'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LogIn, User, Lock, ShieldCheck } from 'lucide-react';
import { api, nextPath } from '../lib';
import { Alert } from '../ui';
import AuthShell from '../AuthShell';

export default function Login() {
  const router = useRouter();
  const [f, setF] = useState({ username: '', password: '' });
  const [challenge, setChallenge] = useState('');   // ada = admin sedang di langkah OTP
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      if (challenge) {
        await api('/login/otp', { method: 'POST', body: { challenge, code } });
        return router.replace(nextPath('/admin'));
      }
      const r = await api('/login', { method: 'POST', body: f });
      if (r.otp) { setChallenge(r.challenge); setBusy(false); return; }
      router.replace(nextPath('/'));
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <AuthShell>
      {challenge ? (<>
        <h1><ShieldCheck size={22} style={{ verticalAlign: -3 }} /> Verifikasi admin</h1>
        <p className="muted">Kode 6 digit sudah dikirim ke Telegram admin. Berlaku 10 menit.</p>
        <form onSubmit={submit} className="mt">
          <label htmlFor="c">Kode OTP</label>
          <input id="c" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoComplete="one-time-code" required autoFocus />
          {err && <div className="mt"><Alert tone="bad">{err}</Alert></div>}
          <button className="btn block mt" disabled={busy || code.length !== 6}>{busy ? <span className="spinner" /> : <ShieldCheck size={17} />} Verifikasi</button>
        </form>
        <p className="muted center mt small">
          <a href="#" onClick={(e) => { e.preventDefault(); setChallenge(''); setCode(''); setErr(''); }}>Kembali / kirim ulang kode</a>
        </p>
      </>) : (<>
        <h1>Selamat datang kembali</h1>
        <p className="muted">Masuk untuk mengelola RDP dan saldo Anda.</p>
        <form onSubmit={submit} className="mt">
          <label htmlFor="u">Username</label>
          <div className="input-icon"><User size={16} />
            <input id="u" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="username" required autoFocus />
          </div>
          <label htmlFor="p">Password</label>
          <div className="input-icon"><Lock size={16} />
            <input id="p" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="current-password" required />
          </div>
          <div className="row between mt-s small">
            <span />
            <Link href="/register?reset=1">Lupa password?</Link>
          </div>
          {err && <div className="mt"><Alert tone="bad">{err}</Alert></div>}
          <button className="btn block mt" disabled={busy}>{busy ? <span className="spinner" /> : <LogIn size={17} />} Masuk</button>
        </form>
        <p className="muted center mt">Belum punya akun? <a href="/register" onClick={(e) => { e.preventDefault(); router.push(`/register${location.search}`); }}>Daftar gratis</a></p>
      </>)}
    </AuthShell>
  );
}
