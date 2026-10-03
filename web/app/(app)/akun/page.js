'use client';
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { api, rp, useMe } from '../../lib';
import { CopyButton, useUi } from '../../ui';

export default function Akun() {
  const { me } = useMe();
  const { toast } = useUi();
  const [f, setF] = useState({ old: '', password: '', again: '' });
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (f.password !== f.again) return toast('Konfirmasi password tidak sama.', 'bad');
    setBusy(true);
    try {
      await api('/password', { method: 'POST', body: f });
      toast('Password berhasil diganti. Sesi di perangkat lain otomatis keluar.');
      setF({ old: '', password: '', again: '' });
    } catch (e) { toast(e.message, 'bad'); }
    setBusy(false);
  }

  return (<>
    <div className="page-head"><div><h1>Pengaturan Akun</h1><p>Informasi akun dan keamanan.</p></div></div>
    <div className="grid grid-2">
      <div className="card">
        <h2>Profil</h2>
        <dl className="kv mt">
          <dt>Username</dt><dd>{me.username}</dd>
          {me.webOnly
            ? (<><dt>Jenis akun</dt><dd>Website</dd></>)
            : (<><dt>ID Telegram</dt><dd className="mono">{me.telegram_id}<CopyButton text={me.telegram_id} /></dd></>)}
          <dt>Peran</dt><dd>{me.admin ? 'Admin' : 'User'}</dd>
          <dt>Saldo</dt><dd>{me.admin ? 'Unlimited' : rp(me.balance)}</dd>
        </dl>
        <p className="hint mt">{me.webOnly
          ? 'Lupa password? Hubungi admin untuk mengatur ulang. Simpan password Anda baik-baik.'
          : 'Akun ini terhubung ke bot Telegram. Saldo, deposit, dan riwayat instalasi sama di keduanya.'}</p>
      </div>
      <form className="card" onSubmit={submit}>
        <h2><KeyRound size={16} style={{ verticalAlign: -2 }} /> Ganti password</h2>
        <label htmlFor="o">Password lama</label>
        <input id="o" type="password" value={f.old} onChange={(e) => setF({ ...f, old: e.target.value })} autoComplete="current-password" required />
        <label htmlFor="n">Password baru</label>
        <input id="n" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" minLength={8} required />
        <label htmlFor="a">Ulangi password baru</label>
        <input id="a" type="password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} autoComplete="new-password" minLength={8} required />
        <button className="btn mt" disabled={busy}>{busy && <span className="spinner" />} Simpan</button>
      </form>
    </div>
  </>);
}
