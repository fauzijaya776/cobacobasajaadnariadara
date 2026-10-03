'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, Copy, Info, X, XCircle } from 'lucide-react';

/* ============ Toast & dialog konfirmasi ============ */

const UiContext = createContext(null);
/** { toast(text, 'ok'|'bad'), confirm({title, body, ok, danger}) => Promise<boolean> } */
export const useUi = () => useContext(UiContext);

export function UiProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [dialog, setDialog] = useState(null);

  const toast = useCallback((text, type = 'ok') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  const confirm = useCallback((opts) => new Promise((resolve) => setDialog({ ...opts, resolve })), []);
  const close = (v) => { dialog.resolve(v); setDialog(null); };

  return (
    <UiContext.Provider value={{ toast, confirm }}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            {t.type === 'bad' ? <XCircle size={18} /> : <CheckCircle2 size={18} />}
            <div>{t.text}</div>
          </div>
        ))}
      </div>
      {dialog && (
        <Modal title={dialog.title} onClose={() => close(false)} footer={<>
          <button className="btn ghost" onClick={() => close(false)}>Batal</button>
          <button className={`btn ${dialog.danger ? 'danger' : ''}`} onClick={() => close(true)} autoFocus>{dialog.ok || 'Lanjutkan'}</button>
        </>}>
          {dialog.body}
        </Modal>
      )}
    </UiContext.Provider>
  );
}

export function Modal({ title, children, onClose, footer, wide }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Tutup"><X size={18} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ============ Komponen kecil ============ */

export const Badge = ({ tone = '', children }) => <span className={`badge ${tone}`}>{children}</span>;

/** Badge dari peta status { key: [label, tone] }. */
export function StatusBadge({ map, value }) {
  const [label, tone] = map[value] || [value || '-', ''];
  return <Badge tone={tone}>{label}</Badge>;
}

export function Alert({ tone = 'info', children }) {
  const Icon = tone === 'bad' || tone === 'warn' ? AlertTriangle : tone === 'ok' ? CheckCircle2 : Info;
  return <div className={`alert ${tone}`}><Icon size={18} /><div>{children}</div></div>;
}

export function Stat({ icon: Icon, label, value, hint, tone = '' }) {
  return (
    <div className="card stat">
      {Icon && <div className={`stat-icon ${tone}`}><Icon size={20} /></div>}
      <div>
        <div className="label">{label}</div>
        <div className="value">{value}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon: Icon, title, children }) {
  return (
    <div className="empty">
      {Icon && <Icon size={40} />}
      <div className="t">{title}</div>
      {children && <div className="small mt-s">{children}</div>}
    </div>
  );
}

export const Loading = ({ text = 'Memuat…' }) => <div className="loading"><span className="spinner" /> {text}</div>;

export function Progress({ value }) {
  return <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
    <div style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
  </div>;
}

export function CopyButton({ text, label = 'Salin' }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(String(text)); setDone(true); setTimeout(() => setDone(false), 1500); } catch (_) {}
  }
  return (
    <button type="button" className="icon-btn" style={{ width: 28, height: 28 }} onClick={copy} aria-label={label} title={label}>
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

export function Segmented({ value, onChange, options }) {
  return (
    <div className="segmented" role="tablist">
      {options.map(([k, label, Icon]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'active' : ''} onClick={() => onChange(k)}>
          {Icon && <Icon size={15} />}{label}
        </button>
      ))}
    </div>
  );
}

/* ============ Grafik batang (satu seri) ============
 * Satu warna (--series-1), batang maks 24px dengan ujung atas membulat 4px,
 * grid tipis, label nilai hanya di batang tertinggi, tooltip saat hover,
 * dan tabel data sebagai alternatif aksesibel. */
export function BarChart({ data, value, label, format = (v) => v, title }) {
  const [hover, setHover] = useState(null);
  const W = 640, H = 220, L = 8, R = 8, T = 22, B = 26;
  const vals = data.map(value);
  const max = Math.max(1, ...vals);
  const slot = (W - L - R) / data.length;
  const bw = Math.min(24, slot * 0.6);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const peak = vals.indexOf(Math.max(...vals));

  const barPath = (x, top, base) => {
    const h = base - top;
    if (h <= 0) return '';
    const r = Math.min(4, h, bw / 2);
    return `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${base} Z`;
  };

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <line key={f} className="grid-line" x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} />
        ))}
        {data.map((d, i) => {
          const x = L + slot * i + (slot - bw) / 2;
          const v = vals[i];
          return (
            <g key={i}>
              <path className={`bar ${hover !== null && hover !== i ? 'dim' : ''}`} d={barPath(x, y(v), y(0))} />
              {i === peak && v > 0 && (
                <text className="value-text" x={x + bw / 2} y={y(v) - 6} textAnchor="middle">{format(v, true)}</text>
              )}
              {(i % 2 === data.length % 2 || data.length <= 8) && (
                <text className="axis-text" x={x + bw / 2} y={H - 8} textAnchor="middle">{label(d, true)}</text>
              )}
              <rect x={L + slot * i} y={T} width={slot} height={H - T - B} fill="transparent"
                onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${label(d)}: ${format(v)}`} />
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: `${((L + slot * hover + slot / 2) / W) * 100}%`, top: `${(y(vals[hover]) / H) * 100}%` }}>
          <b>{format(vals[hover])}</b>{label(data[hover])}
        </div>
      )}
      <details className="table-view">
        <summary>Lihat sebagai tabel</summary>
        <div className="table-wrap"><table>
          <tbody>{data.map((d, i) => <tr key={i}><td>{label(d)}</td><td className="right">{format(vals[i])}</td></tr>)}</tbody>
        </table></div>
      </details>
    </div>
  );
}
