// Uji SSH online: node test-ssh.js
const assert = require('assert');
const http = require('http');
const { Server, utils } = require('ssh2');
const WebSocket = require('ws');
const { createSshGateway, isPrivate } = require('./src/webSsh');

for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.1', '172.16.5.5', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.ok(isPrivate(ip), ip);
for (const ip of ['8.8.8.8', '167.99.72.70', '172.32.0.1', '2001:4860::8888']) assert.ok(!isPrivate(ip), ip);

const hostKey = utils.generateKeyPairSync('ed25519').private;
const sshd = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'pw' ? ctx.accept() : ctx.reject()));
  client.on('session', (accept) => accept().on('pty', (a) => a()).on('shell', (a) => {
    const s = a();
    s.write('$ ');
    s.on('data', (d) => s.write(`echo:${d}`));
  }));
}).listen(0, '127.0.0.1');

const tickets = new Map([['good', { uid: 1, username: 't', exp: Date.now() + 60000 }], ['good2', { uid: 1, username: 't', exp: Date.now() + 60000 }]]);
const take = (t) => { const v = tickets.get(t); tickets.delete(t); return v || null; };
const server = http.createServer().listen(0);
server.on('upgrade', createSshGateway({ takeTicket: take, resolve: async (h) => h }));
const url = (t) => `ws://127.0.0.1:${server.address().port}/api/ssh/ws?ticket=${t}`;

function run(ticket, creds) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url(ticket));
    const got = { ctl: [], out: '' };
    ws.on('unexpected-response', (_, res) => resolve({ http: res.statusCode }));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'connect', host: '127.0.0.1', port: sshd.address().port, username: 'root', ...creds, cols: 80, rows: 24 })));
    ws.on('message', (d, bin) => {
      if (!bin) {
        const m = JSON.parse(d.toString());
        got.ctl.push(m.type);
        if (m.type === 'ready') ws.send(JSON.stringify({ type: 'data', data: 'ls' }));
        if (m.type === 'closed') { got.reason = m.reason; }
      } else {
        got.out += d.toString();
        if (got.out.includes('echo:ls')) ws.close();
      }
    });
    ws.on('close', () => resolve(got));
  });
}

(async () => {
  assert.equal((await run('salah', { password: 'pw' })).http, 401, 'tiket salah ditolak');
  const ok = await run('good', { password: 'pw' });
  assert.ok(ok.ctl.includes('ready') && ok.out.includes('echo:ls'), JSON.stringify(ok));
  assert.equal((await run('good', { password: 'pw' })).http, 401, 'tiket sekali pakai');
  const bad = await run('good2', { password: 'salah' });
  assert.ok(/salah/i.test(bad.reason || ''), JSON.stringify(bad));
  console.log('webSsh OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
