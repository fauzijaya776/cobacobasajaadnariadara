'use client';
import { useEffect, useRef, useState } from 'react';
import { TerminalSquare, Plug, Unplug, KeyRound, Lock, Maximize2, Minimize2 } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { api } from '../../lib';
import { Alert, Badge, Segmented } from '../../ui';

export default function SshOnline() {
  const [f, setF] = useState({ host: '', port: '22', username: 'root', password: '', privateKey: '', passphrase: '' });
  const [auth, setAuth] = useState('password');
  const [state, setState] = useState('idle');   // idle | connecting | ready | closed
  const [msg, setMsg] = useState('');
  const [full, setFull] = useState(false);
  const box = useRef(null);
  const ref = useRef({});                       // { term, fit, ws, ro }

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    setF((x) => ({ ...x, host: q.get('host') || x.host, username: q.get('user') || x.username }));
    return () => cleanup();
  }, []);

  useEffect(() => { setTimeout(() => { try { ref.current.fit?.fit(); } catch (_) {} }, 50); }, [full]);

  function cleanup() {
    const r = ref.current;
    try { r.ws?.close(); } catch (_) {}
    try { r.ro?.disconnect(); } catch (_) {}
    try { r.term?.dispose(); } catch (_) {}
    ref.current = {};
  }

  async function connect(e) {
    e.preventDefault();
    cleanup();
    setState('connecting'); setMsg('Meminta akses…');
    try {
      const [{ Terminal }, { FitAddon }, t] = await Promise.all([
        import('@xterm/xterm'), import('@xterm/addon-fit'), api('/ssh/ticket', { method: 'POST' })
      ]);
      const term = new Terminal({
        cursorBlink: true, fontSize: 14, scrollback: 5000, convertEol: false,
        fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
        theme: { background: '#0b0f19', foreground: '#e6e9ef', cursor: '#818cf8' }
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      box.current.innerHTML = '';
      term.open(box.current);
      fit.fit();

      const ws = new WebSocket(`${t.wsUrl}?ticket=${t.ticket}`);
      ws.binaryType = 'arraybuffer';
      const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
      ws.onopen = () => {
        setMsg('Menghubungkan ke VPS…');
        send({
          type: 'connect', host: f.host.trim(), port: f.port, username: f.username.trim(),
          ...(auth === 'password' ? { password: f.password } : { privateKey: f.privateKey, passphrase: f.passphrase }),
          cols: term.cols, rows: term.rows
        });
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return term.write(new Uint8Array(ev.data));
        const m = JSON.parse(ev.data);
        if (m.type === 'status') setMsg(m.text);
        if (m.type === 'ready') { setState('ready'); setMsg(''); term.focus(); }
        if (m.type === 'closed') { setState('closed'); setMsg(m.reason); }
      };
      ws.onerror = () => { setState('closed'); setMsg('Tidak bisa terhubung ke server SSH website. Coba lagi sebentar.'); };
      ws.onclose = () => setState((s) => (s === 'closed' ? s : 'closed'));
      term.onData((d) => send({ type: 'data', data: d }));
      term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
      const ro = new ResizeObserver(() => { try { fit.fit(); } catch (_) {} });
      ro.observe(box.current);
      ref.current = { term, fit, ws, ro };
      // Password tidak disimpan di halaman setelah dipakai.
      setF((x) => ({ ...x, password: '', passphrase: '' }));
    } catch (err) {
      setState('closed'); setMsg(err.message);
    }
  }

  function disconnect() {
    try { ref.current.ws?.close(); } catch (_) {}
    setState('closed'); setMsg('Koneksi diputus.');
  }

  const busy = state === 'connecting';
  const live = state === 'ready' || state === 'connecting';

  return (<>
    <div className="page-head">
      <div><h1>SSH Online</h1><p>Terminal SSH ke VPS Anda langsung dari browser. Gratis.</p></div>
      {state !== 'idle' && (
        <Badge tone={state === 'ready' ? 'ok' : state === 'connecting' ? 'warn' : 'bad'}>
          {state === 'ready' ? `Terhubung · ${f.username}@${f.host}` : state === 'connecting' ? 'Menghubungkan' : 'Terputus'}
        </Badge>
      )}
    </div>

    {!live && (
      <form className="card" onSubmit={connect}>
        <div className="grid grid-3">
          <div><label style={{ marginTop: 0 }} htmlFor="h">Host / IP</label>
            <input id="h" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="167.99.72.70" required /></div>
          <div><label style={{ marginTop: 0 }} htmlFor="po">Port</label>
            <input id="po" inputMode="numeric" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value.replace(/\D/g, '') })} required /></div>
          <div><label style={{ marginTop: 0 }} htmlFor="u">Username</label>
            <input id="u" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} required /></div>
        </div>
        <div className="mt">
          <Segmented value={auth} onChange={setAuth} options={[['password', 'Password', Lock], ['key', 'Private key', KeyRound]]} />
        </div>
        {auth === 'password' ? (<>
          <label htmlFor="pw">Password</label>
          <input id="pw" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="off" required />
        </>) : (<>
          <label htmlFor="pk">Private key (OpenSSH / PEM)</label>
          <textarea id="pk" value={f.privateKey} onChange={(e) => setF({ ...f, privateKey: e.target.value })} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" required style={{ minHeight: 120 }} />
          <label htmlFor="pp">Passphrase (kalau ada)</label>
          <input id="pp" type="password" value={f.passphrase} onChange={(e) => setF({ ...f, passphrase: e.target.value })} autoComplete="off" />
        </>)}
        {state === 'closed' && msg && <div className="mt"><Alert tone="bad">{msg}</Alert></div>}
        <button className="btn mt" disabled={busy}><Plug size={16} /> Hubungkan</button>
        <p className="hint">Password/key dikirim terenkripsi (WSS) dan tidak disimpan. Sesi ditutup otomatis setelah 30 menit tidak aktif. Maksimal 3 sesi bersamaan.</p>
      </form>
    )}

    <div className="card" style={{ display: state === 'idle' ? 'none' : 'block', padding: 0, overflow: 'hidden', ...(full ? { position: 'fixed', inset: 0, zIndex: 70, borderRadius: 0 } : {}) }}>
      <div className="row between" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
        <span className="row small" style={{ gap: 8 }}><TerminalSquare size={15} /> {f.username}@{f.host}:{f.port}{msg && <span className="muted">· {msg}</span>}</span>
        <span className="row" style={{ gap: 6 }}>
          <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={() => setFull(!full)} aria-label="Layar penuh">{full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
          {live
            ? <button className="btn danger sm" onClick={disconnect}><Unplug size={14} /> Putuskan</button>
            : <button className="btn sm" onClick={() => setState('idle')}>Sambung lagi</button>}
        </span>
      </div>
      <div ref={box} style={{ height: full ? 'calc(100vh - 48px)' : 480, background: '#0b0f19', padding: 6 }} />
    </div>
  </>);
}
