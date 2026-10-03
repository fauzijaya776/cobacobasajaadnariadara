'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Send, UserPlus, KeyRound } from 'lucide-react';
import { api, nextPath } from '../lib';
import { Alert } from '../ui';
import AuthShell from '../AuthShell';

/**
 * Daftar akun: cukup username + password. Opsional: tautkan saldo dari bot
 * Telegram lama (butuh kode OTP dari bot). Lupa password hanya bisa lewat bot
 * untuk akun yang tertaut; akun website saja dibantu admin.
 */
export default function Register() {
  const router = useRouter();
  const [reset, setReset] = useState(false);
  const [link, setLink] = useState(false);
  const [f, setF] = useState({ telegram_id: '', code: '', username: '', password: '' });
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { setReset(new URLSearchParams(location.search).has('reset')); }, []);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const useTelegram = reset || link;

  async function run(fn) {
    setBusy(true); setErr('');
    try { await fn(); } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  const sendOtp = () => run(async () => {
    await api('/otp', { method: 'POST', body: { telegram_id: f.telegram_id } });
    setSent(true);
    setCooldown(60);
  });

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const body = useTelegram ? f : { username: f.username, password: f.password };
      await api(reset ? '/reset' : '/register', { method: 'POST', body });
      router.replace(nextPath('/'));
    });
  };

  return (
    <AuthShell>
      <h1>{reset ? 'Atur ulang password' : 'Buat akun'}</h1>
      <p className="muted">
        {reset ? 'Untuk akun yang tertaut ke bot Telegram. Kode dikirim lewat bot.' : 'Gratis, cukup username dan password.'}
      </p>

      <form onSubmit={submit}>
        {!reset && (<>
          <label htmlFor="un">Username</label>
          <input id="un" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} autoComplete="username" required autoFocus />
          <div className="hint">3–20 karakter: huruf kecil, angka, atau garis bawah.</div>
        </>)}

        <label htmlFor="pw">{reset ? 'Password baru' : 'Password'}</label>
        <input id="pw" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" required minLength={8} />
        <div className="hint">Minimal 8 karakter.</div>

        {!reset && (
          <label className="row" style={{ gap: 8, fontWeight: 500, cursor: 'pointer' }}>
            <input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} style={{ width: 'auto' }} />
            Saya sudah punya saldo di bot Telegram (tautkan)
          </label>
        )}

        {useTelegram && (<>
          <Alert tone="info">Buka bot Telegram dan tekan <b>/start</b>. <b>ID Telegram</b> Anda tampil di menu utama bot.</Alert>
          <label htmlFor="tid">ID Telegram</label>
          <div className="input-group">
            <input id="tid" inputMode="numeric" value={f.telegram_id} onChange={(e) => setF({ ...f, telegram_id: e.target.value.replace(/\D/g, '') })} placeholder="contoh: 123456789" required />
            <button type="button" className="btn soft" onClick={sendOtp} disabled={busy || !f.telegram_id || cooldown > 0}>
              <Send size={15} /> {cooldown > 0 ? `${cooldown}s` : sent ? 'Kirim ulang' : 'Kirim kode'}
            </button>
          </div>
          {sent && <div className="hint pos">Kode 6 digit sudah dikirim ke chat bot Telegram Anda.</div>}
          <label htmlFor="code">Kode verifikasi</label>
          <input id="code" inputMode="numeric" maxLength={6} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.replace(/\D/g, '') })} placeholder="6 digit" required />
        </>)}

        {reset && <div className="hint mt">Akun dibuat tanpa Telegram? Minta admin mengatur ulang password Anda.</div>}

        {err && <div className="mt"><Alert tone="bad">{err}</Alert></div>}
        <button className="btn block mt" disabled={busy}>
          {busy ? <span className="spinner" /> : reset ? <KeyRound size={17} /> : <UserPlus size={17} />}
          {reset ? 'Simpan password baru' : 'Daftar'}
        </button>
      </form>

      <p className="muted center mt small">
        <Link href="/login">Sudah punya akun? Masuk</Link>
        {reset && <> · <a href="#" onClick={(e) => { e.preventDefault(); setReset(false); setErr(''); }}>Daftar akun baru</a></>}
      </p>
    </AuthShell>
  );
}
