#!/usr/bin/env node
// One-click start, and what the shortcuts from `npm run shortcut` run. If
// cc-dash is already running it just opens it; otherwise it updates the repo
// (when "autoUpdate" is on in ~/.cc-dash/config.json), runs `npm ci` when
// package-lock.json has changed, and starts the server in the background with
// its output in ~/.cc-dash/server.log.
//
//   --no-open         don't open the browser
//   --pause-on-error  wait for Enter before closing when something fails, so
//                     the message stays readable in a shortcut's window
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRunning, loginUrl, openBrowser, readToken } from '../server/local.js';
import { CONFIG_FILE, DATA_DIR, IS_WIN, stripBom } from '../server/paths.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOG_FILE = path.join(DATA_DIR, 'server.log');
const noOpen = process.argv.includes('--no-open');

async function fail(msg) {
  console.error(`\n${msg}`);
  if (process.argv.includes('--pause-on-error') && process.stdin.isTTY) {
    console.error('\nPress Enter to close.');
    await new Promise((r) => process.stdin.once('data', r));
  }
  process.exit(1);
}

function readConfig() {
  try {
    return JSON.parse(stripBom(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch {
    return {};
  }
}

// Fast-forwards to the latest default branch, but only when that is the branch
// you are on and nothing is uncommitted: anything else is someone working in
// the repo, and they decide when to pull. A failed pull (offline, say) only
// warns, since the version we have still runs.
function update() {
  const git = (...args) =>
    spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const out = (...args) => git(...args).stdout?.trim() || '';
  const branch = out('rev-parse', '--abbrev-ref', 'HEAD');
  if (!branch) return console.log('Not updating: no git repo (or git is not on PATH).');
  const main = out('rev-parse', '--abbrev-ref', 'origin/HEAD').replace(/^origin\//, '') || 'main';
  if (branch !== main) return console.log(`Not updating: on branch ${branch}, not ${main}.`);
  if (out('status', '--porcelain', '--untracked-files=no')) return console.log('Not updating: there are uncommitted changes.');
  const before = out('rev-parse', '--short', 'HEAD');
  console.log('Updating (git pull)...');
  const r = git('pull', '--ff-only', '--quiet');
  if (r.status !== 0) return console.log(`git pull failed, starting the version we have:\n${(r.stderr || r.error?.message || '').trim()}`);
  const after = out('rev-parse', '--short', 'HEAD');
  console.log(before === after ? 'Already up to date.' : `Updated ${before} -> ${after}.`);
}

// npm's own CLI script next to this node, so a shortcut does not depend on
// npm being on PATH; plain `npm` otherwise.
function npm(args) {
  const dir = path.dirname(process.execPath);
  const cli = [path.join(dir, 'node_modules/npm/bin/npm-cli.js'), path.join(dir, '../lib/node_modules/npm/bin/npm-cli.js')].find((f) => fs.existsSync(f));
  return cli
    ? spawnSync(process.execPath, [cli, ...args], { cwd: ROOT, stdio: 'inherit' })
    : spawnSync('npm', args, { cwd: ROOT, stdio: 'inherit', shell: IS_WIN });
}

// The stamp lives inside node_modules, so deleting node_modules also means
// installing again.
async function installDeps() {
  const stamp = path.join(ROOT, 'node_modules', '.cc-dash-lock');
  const hash = createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'package-lock.json'))).digest('hex');
  try {
    if (fs.readFileSync(stamp, 'utf8') === hash) return;
  } catch {}
  console.log('Installing dependencies (npm ci)...');
  const r = npm(['ci', '--no-audit', '--no-fund']);
  if (r.status !== 0) await fail('npm ci failed, see above.');
  fs.writeFileSync(stamp, hash);
}

function tail(file, lines = 15) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

const running = await findRunning();
if (running) {
  console.log('cc-dash is already running.');
  if (!noOpen) openBrowser(loginUrl(readToken()));
  process.exit(0);
}

if (readConfig().autoUpdate) update();
await installDeps();

fs.mkdirSync(DATA_DIR, { recursive: true });
const log = fs.openSync(LOG_FILE, 'w');
// Detached and without a window: the server, and with it every session, keeps
// running after this script and its window are gone.
const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js'), ...(noOpen ? ['--no-open'] : [])], {
  cwd: ROOT,
  detached: true,
  windowsHide: true,
  stdio: ['ignore', log, log],
});
let exited = null;
child.on('exit', (code) => (exited = code ?? 'signal'));
child.unref();

console.log('Starting cc-dash...');
for (let waited = 0; waited < 20000; waited += 250) {
  if (exited !== null) break;
  if (await findRunning()) {
    console.log(`cc-dash is running. Log: ${LOG_FILE}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 250));
}
await fail(`cc-dash did not start${exited !== null ? '' : ' within 20 seconds'}. From ${LOG_FILE}:\n\n${tail(LOG_FILE)}`);
