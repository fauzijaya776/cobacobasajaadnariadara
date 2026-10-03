'use client';
import { useEffect, useState } from 'react';
import { Receipt, MonitorDown } from 'lucide-react';
import { api, rp, tgl, trxLabel, trxTone, INSTALL_STATUS } from '../../lib';
import { Alert, Badge, Empty, Loading, Segmented, StatusBadge } from '../../ui';

export default function History() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('trx');
  const [type, setType] = useState('');
  useEffect(() => { api('/history').then(setData).catch((e) => setErr(e.message)); }, []);

  if (err) return <Alert tone="bad">{err}</Alert>;
  if (!data) return <Loading />;

  const types = [...new Set(data.transactions.map((t) => t.type))];
  const trx = type ? data.transactions.filter((t) => t.type === type) : data.transactions;
  const masuk = data.transactions.filter((t) => t.amount > 0).reduce((n, t) => n + t.amount, 0);
  const keluar = data.transactions.filter((t) => t.amount < 0).reduce((n, t) => n - t.amount, 0);

  return (<>
    <div className="page-head">
      <div><h1>Riwayat</h1><p>100 transaksi & instalasi terakhir.</p></div>
      <Segmented value={tab} onChange={setTab} options={[['trx', 'Transaksi', Receipt], ['inst', 'Instalasi', MonitorDown]]} />
    </div>

    {tab === 'trx' ? (
      <div className="card">
        <div className="card-head">
          <div className="row small"><span className="muted">Masuk</span><b className="pos">+{rp(masuk)}</b><span className="muted">· Keluar</span><b>−{rp(keluar)}</b></div>
          <select value={type} onChange={(e) => setType(e.target.value)} style={{ width: 'auto' }} aria-label="Filter jenis">
            <option value="">Semua jenis</option>
            {types.map((t) => <option key={t} value={t}>{trxLabel(t)}</option>)}
          </select>
        </div>
        {trx.length === 0 ? <Empty icon={Receipt} title="Belum ada transaksi" /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Waktu</th><th>Jenis</th><th className="right">Jumlah</th></tr></thead>
            <tbody>{trx.map((t) => (
              <tr key={t.id}>
                <td>{tgl(t.created_at)}</td>
                <td><Badge tone={trxTone(t.type)}>{trxLabel(t.type)}</Badge></td>
                <td className={`right ${t.amount >= 0 ? 'pos' : ''}`}><b>{t.amount >= 0 ? '+' : '−'}{rp(Math.abs(t.amount))}</b></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    ) : (
      <div className="card">
        {data.installations.length === 0 ? <Empty icon={MonitorDown} title="Belum ada instalasi" /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Waktu</th><th>IP</th><th>Windows</th><th>Status</th><th>Keterangan</th></tr></thead>
            <tbody>{data.installations.map((r) => (
              <tr key={r.id}>
                <td>{tgl(r.created_at)}</td>
                <td className="mono">{r.ip}</td>
                <td>{r.windows_name}</td>
                <td><StatusBadge map={INSTALL_STATUS} value={r.status} /></td>
                <td className="wrap small muted">{r.note ? String(r.note).replace(/^[A-Z_]+:\s*/, '').slice(0, 120) : ''}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    )}
  </>);
}
