'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { QrCode, CheckCircle2, Clock, RefreshCw, Smartphone } from 'lucide-react';
import { api, rp, tgl, useMe, usePoll } from '../../lib';
import { Alert, Empty, useUi } from '../../ui';

const PRESET = [10000, 20000, 50000, 100000, 200000];
const MIN = 2000;

function Countdown({ until }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, new Date(until).getTime() - now);
  if (!until || Number.isNaN(left)) return null;
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  return <span className="badge warn"><Clock size={12} /> {left ? `${m}:${String(s).padStart(2, '0')}` : 'kadaluarsa'}</span>;
}

export default function Deposit() {
  const { me, reload } = useMe();
  const { toast } = useUi();
  const [amount, setAmount] = useState('');
  const [pay, setPay] = useState(null);
  const [state, setState] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState(null);

  const loadRecent = () => api('/history')
    .then((d) => setRecent(d.transactions.filter((t) => t.type === 'deposit').slice(0, 5))).catch(() => setRecent([]));
  useEffect(() => { loadRecent(); }, []);

  async function create(e) {
    e.preventDefault();
    setBusy(true); setErr(''); setState('');
    try { setPay(await api('/deposit', { method: 'POST', body: { amount } })); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  }

  async function check(manual) {
    if (!pay) return;
    try {
      const r = await api(`/deposit/${pay.ref}`);
      setState(r.state);
      if (r.state === 'credited' || r.state === 'already') { reload(); loadRecent(); toast('Pembayaran diterima, saldo sudah masuk.'); }
      else if (manual) toast(r.state === 'error' ? 'Server pembayaran sibuk, coba lagi sebentar.' : 'Pembayaran belum diterima.', 'bad');
    } catch (e) {
      // Hanya 404 yang berarti tagihan benar-benar hilang; gangguan jaringan = coba lagi.
      if (e.status === 404) setState('expired');
      else if (manual) toast(e.message, 'bad');
    }
  }

  const finished = ['credited', 'already', 'expired'].includes(state);
  // Bot juga memantau & menerima webhook; polling ini hanya memperbarui layar.
  usePoll(() => check(false), 6000, Boolean(pay) && !finished);

  const n = Number(amount) || 0;

  return (<>
    <div className="page-head">
      <div><h1>Deposit Saldo</h1><p>Isi saldo via QRIS. Masuk otomatis dalam hitungan detik.</p></div>
    </div>

    <div className="split">
      <div className="card">
        {!pay ? (
          <form onSubmit={create}>
            <div className="card-head"><h2>Pilih nominal</h2></div>
            <div className="chips">
              {PRESET.map((p) => (
                <button type="button" key={p} className={`chip ${n === p ? 'active' : ''}`} onClick={() => setAmount(String(p))}>{rp(p)}</button>
              ))}
            </div>
            <label htmlFor="amt">Atau masukkan nominal lain</label>
            <input id="amt" inputMode="numeric" value={n ? n.toLocaleString('id-ID') : ''} placeholder={`Minimal ${rp(MIN)}`}
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} required />
            {err && <div className="mt"><Alert tone="bad">{err}</Alert></div>}
            <button className="btn block mt" disabled={busy || n < MIN}>
              {busy ? <span className="spinner" /> : <QrCode size={17} />} {n >= MIN ? `Bayar ${rp(n)}` : 'Buat QRIS'}
            </button>
          </form>
        ) : state === 'credited' || state === 'already' ? (
          <div className="center" style={{ padding: '24px 0' }}>
            <CheckCircle2 size={56} className="pos" />
            <h2 className="mt">Pembayaran berhasil!</h2>
            <p className="muted">Saldo bertambah {rp(pay.credit)}. Saldo sekarang {rp(me.balance)}.</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <Link href="/install" className="btn">Install RDP sekarang</Link>
              <button className="btn ghost" onClick={() => { setPay(null); setState(''); setAmount(''); }}>Deposit lagi</button>
            </div>
          </div>
        ) : state === 'expired' ? (
          <div className="center" style={{ padding: '24px 0' }}>
            <Clock size={48} className="muted" />
            <h2 className="mt">Tagihan kadaluarsa</h2>
            <p className="muted">Kalau Anda sudah membayar tapi saldo belum masuk, hubungi admin dengan menyebut ref <code>{pay.ref}</code>.</p>
            <button className="btn" onClick={() => { setPay(null); setState(''); }}>Buat deposit baru</button>
          </div>
        ) : (
          <div className="center">
            <div className="row" style={{ justifyContent: 'center' }}>
              <span className="badge info"><span className="spinner" style={{ width: 10, height: 10 }} /> Menunggu pembayaran</span>
              <Countdown until={pay.expired_at} />
            </div>
            <img src={pay.qr} alt="Kode QRIS pembayaran" className="qr mt" />
            <div className="mt"><span className="muted small">Total bayar</span><div style={{ fontSize: 28, fontWeight: 750 }}>{rp(pay.total)}</div></div>
            <p className="small muted">Saldo masuk: <b>{rp(pay.credit)}</b> · Ref <code>{pay.ref}</code></p>
            {pay.sandbox && <Alert tone="warn">Mode sandbox — bukan pembayaran sungguhan.</Alert>}
            <div className="row mt" style={{ justifyContent: 'center' }}>
              <button className="btn ghost" onClick={() => check(true)}><RefreshCw size={15} /> Cek status</button>
              <button className="btn ghost" onClick={() => { setPay(null); setState(''); }}>Batal</button>
            </div>
            <p className="hint">Halaman ini memeriksa otomatis. Anda boleh menutupnya — saldo tetap masuk setelah dibayar.</p>
          </div>
        )}
      </div>

      <div className="stack">
        <div className="card">
          <h3><Smartphone size={16} style={{ verticalAlign: -3 }} /> Cara bayar</h3>
          <ol className="small" style={{ paddingLeft: 18, margin: '10px 0 0' }}>
            <li>Pilih nominal lalu tekan <b>Bayar</b>.</li>
            <li>Scan QRIS dengan GoPay, OVO, DANA, ShopeePay, atau m-banking apa pun.</li>
            <li>Bayar <b>persis</b> sesuai total.</li>
            <li>Saldo masuk otomatis dalam hitungan detik.</li>
          </ol>
        </div>
        <div className="card">
          <h3>Deposit terakhir</h3>
          {!recent ? <div className="skeleton mt" style={{ height: 60 }} /> : recent.length === 0 ? <Empty title="Belum ada deposit" /> : (
            <div className="list">{recent.map((t) => (
              <div className="list-item" key={t.id}><span className="d">{tgl(t.created_at)}</span><b className="pos">+{rp(t.amount)}</b></div>
            ))}</div>
          )}
        </div>
      </div>
    </div>
  </>);
}
