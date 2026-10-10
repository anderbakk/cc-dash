// Git diff and read-only file access, always confined to a session's cwd.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

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
  const prefix = path.relative(cwd, root).split(path.sep).join('/');
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
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
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
