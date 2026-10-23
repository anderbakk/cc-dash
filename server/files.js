// Git diff and read-only file access, always confined to a session's cwd.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { isInside } from './paths.js';

const run = promisify(execFile);
const MAX_DIFF = 2 * 1024 * 1024;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const MAX_PREVIEW = 5 * 1024 * 1024;

async function git(cwd, args) {
  const { stdout } = await run('git', ['-C', cwd, ...args], { maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  return stdout;
}

export async function gitDiff(cwd) {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { repo: false };
  }
  // symbolic-ref also works in a fresh repo without commits.
  const branch = (await git(cwd, ['symbolic-ref', '--short', 'HEAD']).catch(() => git(cwd, ['rev-parse', '--short', 'HEAD'])).catch(() => '')).trim();
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  // A fresh repo has no HEAD; diff against the empty tree instead.
  const base = await git(cwd, ['rev-parse', '--verify', 'HEAD']).then(() => ['HEAD'], () => [EMPTY_TREE]);
  const [diff, numstat, status] = await Promise.all([
    git(root, ['diff', ...base, '--no-color', '--no-ext-diff']),
    git(root, ['diff', ...base, '--numstat']),
    git(root, ['status', '--porcelain=v1', '-uall']),
  ]);
  const stats = new Map();
  for (const line of numstat.split('\n')) {
    const [add, del, file] = line.split('\t');
    if (file) stats.set(file, { add: Number(add) || 0, del: Number(del) || 0 });
  }
  const files = status
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      let file = line.slice(3);
      if (file.includes(' -> ')) file = file.split(' -> ')[1];
      file = file.replace(/^"|"$/g, '');
      return { path: file, status: line.slice(0, 2).trim() || '?', ...(stats.get(file) || {}) };
    });
  // Paths are relative to the repo root; tell the client how to reach them from cwd.
  // realpath: git reports the long name of a folder given as an 8.3 short
  // name (C:\Users\THOR~1.AND), which would make the relative path go astray.
  const prefix = path.relative(fs.realpathSync.native(cwd), root).split(path.sep).join('/');
  return {
    repo: true,
    branch,
    prefix,
    files,
    diff: diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) + '\n… (diff avkortet)' : diff,
  };
}

// Resolve `rel` inside `root`, refusing anything that escapes it (including via symlinks).
export function safeResolve(root, rel = '') {
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, rel);
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    return null;
  }
  if (!isInside(real, realRoot)) return null;
  return real;
}

const HIDDEN = new Set(['.git', 'node_modules']);

export function listDir(root, rel) {
  const dir = safeResolve(root, rel);
  if (!dir || !fs.statSync(dir).isDirectory()) return null;
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !HIDDEN.has(e.name))
    .map((e) => {
      const isDir = e.isDirectory() || (e.isSymbolicLink() && fs.statSync(path.join(dir, e.name), { throwIfNoEntry: false })?.isDirectory());
      return { name: e.name, dir: !!isDir };
    })
    .sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name));
  return { path: path.relative(fs.realpathSync(root), dir).split(path.sep).join('/'), entries };
}

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'text/plain; charset=utf-8';
}

// Plain-text search (case-insensitive) in the files under `rel`. Uses git grep
// in a repo, so .gitignore applies; elsewhere a capped walk of the folder.
// Paths come back relative to `root`, like listDir.
const SEARCH_FILES = 200;
const SEARCH_HITS = 5; // lines shown per file
const SEARCH_WALK = 20000; // entries looked at without git
const SEARCH_SIZE = 1024 * 1024;

function snippet(text, at) {
  text = text.replace(/\r$/, '');
  if (text.length <= 200) return text;
  const from = Math.max(0, at - 60);
  return (from ? '…' : '') + text.slice(from, from + 200 - (from ? 1 : 0)) + (from + 200 < text.length ? '…' : '');
}

function collect(results, file, line, text, q) {
  let r = results.get(file);
  if (!r) {
    if (results.size >= SEARCH_FILES) return false;
    results.set(file, (r = { path: file, count: 0, hits: [] }));
  }
  r.count++;
  if (r.hits.length < SEARCH_HITS) r.hits.push({ line, text: snippet(text, text.toLowerCase().indexOf(q)) });
  return true;
}

function gitGrep(dir, q) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', dir, '-c', 'core.quotePath=false', 'grep', '-z', '-n', '-I', '-i', '-F', '--untracked', '-e', q, '--', '.'], { windowsHide: true });
    const results = new Map();
    let buf = '';
    let truncated = false;
    let failed = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const [file, line, ...rest] = buf.slice(0, nl).split('\0');
        buf = buf.slice(nl + 1);
        if (!collect(results, file, Number(line), rest.join('\0'), q)) {
          truncated = true;
          child.kill();
          return;
        }
      }
    });
    child.on('error', () => (failed = true));
    // 0: matches, 1: none, anything else (not a repo, no git): fall back.
    child.on('close', (code) => resolve(failed || (code > 1 && !truncated) ? null : { results, truncated }));
  });
}

function walkGrep(dir, q) {
  const results = new Map();
  let seen = 0;
  let truncated = false;
  const walk = (sub) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, sub), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      if (HIDDEN.has(e.name)) continue;
      if (++seen > SEARCH_WALK) return void (truncated = true);
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      if (!e.isFile()) continue;
      const full = path.join(dir, rel);
      let data;
      try {
        if (fs.statSync(full).size > SEARCH_SIZE) continue;
        data = fs.readFileSync(full);
      } catch {
        continue;
      }
      if (data.subarray(0, 8000).includes(0)) continue; // binary
      const text = data.toString('utf8');
      if (!text.toLowerCase().includes(q)) continue;
      text.split('\n').forEach((l, i) => {
        if (!truncated && l.toLowerCase().includes(q) && !collect(results, rel, i + 1, l, q)) truncated = true;
      });
    }
  };
  walk('');
  return { results, truncated };
}

export async function searchFiles(root, rel, query) {
  const dir = safeResolve(root, rel);
  if (!dir || !fs.statSync(dir).isDirectory()) return null;
  const q = String(query || '').toLowerCase();
  const base = path.relative(fs.realpathSync(root), dir).split(path.sep).join('/');
  if (!q.trim()) return { path: base, files: [], truncated: false };
  const found = (await gitGrep(dir, q)) || walkGrep(dir, q);
  const files = [...found.results.values()]
    .map((r) => ({ ...r, path: base ? `${base}/${r.path}` : r.path }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { path: base, files, truncated: found.truncated };
}
