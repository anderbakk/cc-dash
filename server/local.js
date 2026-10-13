// Finding and talking to a cc-dash that already runs on this machine. Shared by
// the server (a second `npm start`) and the start/stop scripts.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { CONFIG_FILE, IS_WIN, stripBom } from './paths.js';

export const HOST = process.env.HOST || '127.0.0.1';
export const PORT = Number(process.env.PORT || 7420);
export const COOKIE = `ccdash_${PORT}`;
const LOCAL = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;

export const loginUrl = (token) => `http://${LOCAL}:${PORT}/?token=${token}`;

export function readToken() {
  try {
    return JSON.parse(stripBom(fs.readFileSync(CONFIG_FILE, 'utf8'))).token || null;
  } catch {
    return null;
  }
}

// Calls the cc-dash API on PORT with our own token. Resolves with the parsed
// reply, or null when nothing answers, it is not cc-dash, or it does not take
// our token. Never rejects.
export function callLocal(path, { method = 'GET', token = readToken(), timeout = 1500 } = {}) {
  if (!token) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.request(
      { host: LOCAL === 'localhost' ? '127.0.0.1' : LOCAL, port: PORT, path, method, timeout, headers: { Cookie: `${COOKIE}=${encodeURIComponent(token)}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(res.statusCode === 200 ? JSON.parse(body) : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

export const findRunning = (token) => callLocal('/api/ping', { token }).then((r) => (r?.app === 'cc-dash' ? r : null));

export function openBrowser(url) {
  const [cmd, args] = IS_WIN
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
  } catch {}
}
