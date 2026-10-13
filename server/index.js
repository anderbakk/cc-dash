#!/usr/bin/env node
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MAX_PREVIEW, gitDiff, listDir, mimeFor, safeResolve } from './files.js';
import { PtyHost, TmuxHost } from './hosts.js';
import { COOKIE, HOST, PORT, findRunning, loginUrl, openBrowser } from './local.js';
import { loadProfiles, pickProfile } from './profiles.js';
import { repoFor, resolveRefs } from './refs.js';
import { CONFIG_FILE, DATA_DIR, IS_WIN, SETTINGS_FILE, safeId, stripBom } from './paths.js';
import { SessionManager } from './sessions.js';
import { refsFor } from './transcripts.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const require = createRequire(import.meta.url);
const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));

// ---- config & auth ---------------------------------------------------------

function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let cfg = {};
  try {
    cfg = JSON.parse(stripBom(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch {}
  if (!cfg.token) {
    cfg.token = randomBytes(24).toString('base64url');
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  }
  return cfg;
}
const config = loadConfig();

function tokenOk(t) {
  if (typeof t !== 'string') return false;
  const a = Buffer.from(t);
  const b = Buffer.from(config.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const authed = (req) => tokenOk(cookies(req)[COOKIE]);

// Guards against DNS rebinding and cross-site requests: the browser must be
// talking to us by our own address, and writes must come from our own page.
function hostOk(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const allowed = new Set(['localhost', '127.0.0.1', '::1', HOST, ...(process.env.CC_DASH_ALLOWED_HOSTS || '').split(',')]);
  return allowed.has(host);
}

function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// ---- sessions --------------------------------------------------------------

const host = TmuxHost.available() ? new TmuxHost() : new PtyHost({ onExit: (s) => manager.forget(s.id) });
const manager = new SessionManager(host);

function hooksInstalled() {
  try {
    return fs.readFileSync(SETTINGS_FILE, 'utf8').includes('--cc-dash');
  } catch {
    return false;
  }
}

// ---- http ------------------------------------------------------------------

const VENDOR = {
  '/vendor/xterm.mjs': [pkgDir('@xterm/xterm'), 'lib/xterm.mjs'],
  '/vendor/xterm.css': [pkgDir('@xterm/xterm'), 'css/xterm.css'],
  '/vendor/addon-fit.mjs': [pkgDir('@xterm/addon-fit'), 'lib/addon-fit.mjs'],
  '/vendor/addon-web-links.mjs': [pkgDir('@xterm/addon-web-links'), 'lib/addon-web-links.mjs'],
  '/vendor/addon-search.mjs': [pkgDir('@xterm/addon-search'), 'lib/addon-search.mjs'],
  '/vendor/addon-unicode11.mjs': [pkgDir('@xterm/addon-unicode11'), 'lib/addon-unicode11.mjs'],
  '/vendor/marked.esm.js': [pkgDir('marked'), 'lib/marked.esm.js'],
};

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(data);
}

function sendFile(res, file, extra = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'Not found' });
    if (st.size > MAX_PREVIEW) return send(res, 413, { error: 'The file is too large to preview' });
    res.writeHead(200, { 'Content-Type': mimeFor(file), 'Content-Length': st.size, 'Cache-Control': 'no-store', ...extra });
    fs.createReadStream(file).pipe(res);
  });
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1e5) throw new Error('Request too large');
  }
  return body ? JSON.parse(body) : {};
}

const LOGIN_PAGE = `<!doctype html><meta charset="utf-8"><title>cc-dash</title>
<body style="font:16px system-ui;padding:2rem;background:#111;color:#ddd">
<h1>cc-dash</h1><p>Open the link with the token that was printed in the terminal where you ran <code>npm start</code>.</p>`;

async function handle(req, res) {
  if (!hostOk(req)) return send(res, 403, 'Invalid Host header', 'text/plain');
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // Log in by visiting /?token=..., which swaps the token for a cookie.
  if (url.searchParams.has('token')) {
    if (!tokenOk(url.searchParams.get('token'))) return send(res, 401, LOGIN_PAGE, 'text/html; charset=utf-8');
    return send(res, 302, '', 'text/plain', {
      'Set-Cookie': `${COOKIE}=${encodeURIComponent(config.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      Location: '/',
    });
  }

  // Raw files for previews carry the token in the path, so relative links
  // inside a previewed HTML page (css, images) keep working in the iframe.
  // /raw/<token>/<session>/<root id>/<path>
  const raw = p.match(/^\/raw\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/);
  if (raw && req.method === 'GET') {
    if (!tokenOk(raw[1])) return send(res, 401, { error: 'Not logged in' });
    const dir = await manager.rootDir(raw[2], raw[3]);
    const file = dir && safeResolve(dir, decodeURIComponent(raw[4]));
    if (!file) return send(res, 404, { error: 'Not found' });
    return sendFile(res, file, { 'Content-Security-Policy': 'sandbox allow-scripts' });
  }

  if (!authed(req)) {
    if (p.startsWith('/api/')) return send(res, 401, { error: 'Not logged in' });
    return send(res, 401, LOGIN_PAGE, 'text/html; charset=utf-8');
  }

  if (VENDOR[p]) return sendFile(res, path.join(...VENDOR[p]));

  if (!p.startsWith('/api/')) {
    const file = path.join(PUBLIC, p === '/' ? 'index.html' : p);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, { error: 'Not found' });
    return sendFile(res, file);
  }

  if (req.method !== 'GET' && !originOk(req)) return send(res, 403, { error: 'Invalid origin' });

  try {
    // Lets a second start, and scripts/start.js and stop.js, tell that this is
    // cc-dash and that it takes their token.
    if (p === '/api/ping' && req.method === 'GET') return send(res, 200, { app: 'cc-dash', pid: process.pid });
    if (p === '/api/shutdown' && req.method === 'POST') {
      send(res, 200, { ok: true, ended: host.killAll ? manager.managed.size : 0 });
      return setImmediate(shutdown);
    }
    if (p === '/api/sessions' && req.method === 'GET') {
      return send(res, 200, {
        sessions: manager.list(),
        host: host.name,
        platform: process.platform,
        hooks: hooksInstalled(),
        token: config.token,
        profiles: loadProfiles().map(({ id, name, claude, cwd, tag, color }) => ({ id, name, claude, cwd: cwd || null, tag: tag || null, color: color || null })),
      });
    }
    if (p === '/api/sessions' && req.method === 'POST') {
      const body = await readJson(req);
      // Continuing a session uses the profile it was started with, if known.
      const wanted = body.profile || (body.resumeId && manager.rememberedProfile(body.resumeId));
      let profile;
      try {
        profile = pickProfile(wanted, { claude: !!body.resumeId });
      } catch (e) {
        if (body.profile || !body.resumeId) throw e;
        profile = pickProfile(null, { claude: true }); // remembered profile was removed from config
      }
      const sess = manager.create({ cwd: body.cwd, resumeId: body.resumeId, profile });
      return send(res, 201, { managedId: sess.id, key: sess.claudeSessionId });
    }
    if (p === '/api/dirs') return send(res, 200, { dirs: manager.recentDirs() });

    const m = p.match(/^\/api\/sessions\/([^/]+)(?:\/(diff|files|file|refs|roots))?$/);
    if (m) {
      const [, id, action] = m;
      if (!safeId(id)) return send(res, 400, { error: 'Invalid id' });
      if (!action && req.method === 'DELETE') {
        return manager.kill(id) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Not found' });
      }
      if (action === 'refs') {
        const refs = refsFor(id);
        if (!refs) return send(res, 200, { refs: [], repo: null });
        const repo = await repoFor(manager.cwdFor(id));
        return send(res, 200, { refs: resolveRefs(refs, repo), repo });
      }
      if (action === 'roots') return send(res, 200, { roots: await manager.rootsFor(id) });
      // Diff and files work on one of the session's folders, the cwd by default.
      const cwd = await manager.rootDir(id, url.searchParams.get('root'));
      if (!cwd || !fs.existsSync(cwd)) return send(res, 404, { error: 'The session folder does not exist' });
      if (action === 'diff') return send(res, 200, await gitDiff(cwd));
      if (action === 'files') {
        const listing = listDir(cwd, url.searchParams.get('path') || '');
        return listing ? send(res, 200, { cwd, ...listing }) : send(res, 404, { error: 'Not found' });
      }
      if (action === 'file') {
        const file = safeResolve(cwd, url.searchParams.get('path') || '');
        return file ? sendFile(res, file) : send(res, 404, { error: 'Not found' });
      }
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => send(res, 500, { error: e.message }));
});

// ---- terminal websocket ----------------------------------------------------
// Client -> server: JSON {t:'in', d:string} | {t:'resize', c, r}
// Server -> client: raw terminal output as text frames, or JSON
// {t:'exit'} sent as a binary-flagged control frame.

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const m = req.url.match(/^\/ws\/term\/([^/?]+)\?c=(\d+)&r=(\d+)$/);
  if (!m || !hostOk(req) || !originOk(req) || !authed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  const sess = manager.get(m[1]);
  const view = sess && host.attach(sess, { cols: Number(m[2]), rows: Number(m[3]) });
  if (!view) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    view.onData((d) => ws.readyState === ws.OPEN && ws.send(d));
    view.onExit(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'exit' }), { binary: true });
      ws.close();
    });
    ws.on('message', (msg, isBinary) => {
      let o;
      try {
        o = JSON.parse(msg.toString());
      } catch {
        return;
      }
      if (o.t === 'in' && typeof o.d === 'string') view.write(o.d);
      else if (o.t === 'resize' && o.c > 0 && o.r > 0) view.resize(Math.min(o.c, 500), Math.min(o.r, 200));
    });
    ws.on('close', () => view.close());
  });
});

// ---- start -----------------------------------------------------------------

const noOpen = Boolean(process.env.CC_DASH_NO_OPEN) || process.argv.includes('--no-open');

server.on('error', async (e) => {
  // Starting twice is easy with a shortcut; if the port is held by our own
  // cc-dash, show that one instead of failing.
  if (e.code === 'EADDRINUSE' && (await findRunning(config.token))) {
    console.log(`cc-dash is already running on port ${PORT}.`);
    if (!noOpen) openBrowser(loginUrl(config.token));
    process.exit(0);
  }
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is in use. Start on another port, e.g. PORT=7421 npm start`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = loginUrl(config.token);
  console.log(`cc-dash is running (${host.name === 'tmux' ? 'tmux: sessions survive a restart' : 'pty: sessions live as long as cc-dash runs'})`);
  console.log(`\n  ${url}\n`);
  if (!hooksInstalled()) console.log('Tip: run "npm run setup" for live status (working/waiting) in the sidebar.\n');
  if (!noOpen) openBrowser(url);
});

function shutdown() {
  if (host.killAll) {
    if (manager.managed.size) console.log('Ending sessions (they can be continued with --resume).');
    host.killAll();
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
