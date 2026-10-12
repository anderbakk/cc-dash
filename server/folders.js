// Finds the folders a session works in besides the one it was started in.
// Claude often edits a second repo, or writes notes to a folder next to the
// project, without ever changing its own cwd. The tool calls in the transcript
// say where: files written or read, and folders the shell moved into.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CLAUDE_DIR, DATA_DIR, IS_WIN, isInside, pathKey } from './paths.js';

const run = promisify(execFile);

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// A folder that was only read from counts once it has been read this often;
// a single look at a file in Downloads should not add a panel tab.
const MIN_READS = 3;

// Absolute, platform-native path, or null for anything we cannot place
// (variables, globs). Git Bash writes C:\git as /c/git.
export function normalizePath(p, base) {
  if (typeof p !== 'string' || !p.trim() || /[$*?%`]/.test(p)) return null;
  p = p.trim();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  if (IS_WIN) {
    const m = p.match(/^\/([a-zA-Z])(?=\/|$)(.*)$/);
    if (m) p = `${m[1]}:${m[2] || '/'}`;
    else if (/^[\\/](?![\\/])/.test(p)) return null; // drive-relative, ambiguous
  }
  if (!path.isAbsolute(p)) {
    const b = base && normalizePath(base);
    if (!b) return null;
    p = path.join(b, p);
  }
  p = path.resolve(p);
  return IS_WIN ? p.replace(/^[a-z]:/, (d) => d.toUpperCase()) : p;
}

const ARG = String.raw`("[^"]+"|'[^']+'|[^\s;&|()"'<>]+)`;
const SHELL_DIR = new RegExp(
  String.raw`(?:^|[;&|(\n{]\s*)(?:cd|pushd|Set-Location|sl)\s+(?:-(?:Literal)?Path\s+)?${ARG}|\bgit\s+-C\s+${ARG}`,
  'g',
);
const unquote = (s) => s.replace(/^(["'])(.*)\1$/, '$2');

// Folders used by one assistant message: [{ dir, file?, kind: 'write'|'read'|'shell' }]
export function toolTargets(content, cwd) {
  const out = [];
  if (!Array.isArray(content)) return out;
  for (const c of content) {
    if (c?.type !== 'tool_use' || !c.input) continue;
    const inp = c.input;
    const file = (p, kind) => {
      const f = normalizePath(p, cwd);
      if (f) out.push({ dir: path.dirname(f), file: f, kind });
    };
    const dir = (p, kind) => {
      const d = normalizePath(p, cwd);
      if (d) out.push({ dir: d, kind });
    };
    if (WRITE_TOOLS.has(c.name)) file(inp.file_path ?? inp.notebook_path, 'write');
    else if (c.name === 'Read') file(inp.file_path, 'read');
    else if (c.name === 'Glob' || c.name === 'Grep') dir(inp.path, 'read');
    else if (SHELL_TOOLS.has(c.name) && typeof inp.command === 'string') {
      for (const m of inp.command.matchAll(SHELL_DIR)) dir(unquote(m[1] ?? m[2]), 'shell');
    }
  }
  return out;
}

export function newTouched() {
  return { dirs: new Map(), written: new Map() }; // dir -> { write, read, shell, lastAt }; file -> lastAt
}

export function addTargets(touched, targets, at) {
  for (const t of targets) {
    const k = pathKey(t.dir);
    const d = touched.dirs.get(k) || { dir: t.dir, write: 0, read: 0, shell: 0, lastAt: 0 };
    d[t.kind]++;
    if (at > d.lastAt) d.lastAt = at;
    touched.dirs.set(k, d);
    if (t.kind === 'write') touched.written.set(t.file, Math.max(touched.written.get(t.file) || 0, at || 0));
  }
}

export function mergeTouched(list) {
  const out = newTouched();
  for (const t of list) {
    for (const [k, d] of t.dirs) {
      const o = out.dirs.get(k);
      if (!o) out.dirs.set(k, { ...d });
      else {
        o.write += d.write;
        o.read += d.read;
        o.shell += d.shell;
        o.lastAt = Math.max(o.lastAt, d.lastAt);
      }
    }
    for (const [f, at] of t.written) out.written.set(f, Math.max(out.written.get(f) || 0, at));
  }
  return out;
}

// ---- roots -----------------------------------------------------------------

const gitTops = new Map(); // dir -> { at, top }
const GIT_TTL = 60e3;

async function gitTop(dir) {
  const k = pathKey(dir);
  const hit = gitTops.get(k);
  if (hit && Date.now() - hit.at < GIT_TTL) return hit.top;
  let top = null;
  try {
    const { stdout } = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { windowsHide: true });
    top = normalizePath(stdout.trim());
  } catch {}
  gitTops.set(k, { at: Date.now(), top });
  return top;
}

export const rootId = (p) => createHash('sha1').update(pathKey(p)).digest('hex').slice(0, 10);

function existingDir(p) {
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) return null;
  return st.isDirectory() ? p : path.dirname(p);
}

// The session's folders: its own cwd first (id 'main'), then every other
// folder it wrote to or worked in. A folder inside a git repo is widened to
// the repo; others stay as they are, merged into their topmost used parent.
export async function sessionRoots(cwd, touched) {
  const roots = [];
  const mainTop = cwd ? await gitTop(cwd) : null;
  if (cwd) roots.push({ id: 'main', path: cwd, name: path.basename(cwd) || cwd, git: !!mainTop, primary: true });
  if (!touched) return roots;

  const home = os.homedir();
  const skip = [mainTop || cwd, CLAUDE_DIR, DATA_DIR, os.tmpdir()].filter(Boolean);
  const found = new Map(); // key -> root
  // Shortest first, so a parent is seen before the folders inside it.
  const dirs = [...touched.dirs.values()].sort((a, b) => a.dir.length - b.dir.length);
  for (const d of dirs) {
    if (skip.some((s) => isInside(d.dir, s))) continue;
    let root = [...found.values()].find((r) => isInside(d.dir, r.path));
    if (!root) {
      const dir = existingDir(d.dir);
      if (!dir) continue;
      const top = await gitTop(dir);
      // Outside git only a write makes a folder: a look at a parent folder
      // would otherwise swallow everything below it.
      if (!top && !d.write) continue;
      const p = top || dir;
      if (skip.some((s) => isInside(p, s)) || pathKey(p) === pathKey(home) || path.parse(p).root === p) continue;
      root = found.get(pathKey(p));
      if (!root) found.set(pathKey(p), (root = { path: p, git: !!top, write: 0, read: 0, shell: 0, lastAt: 0 }));
    }
    root.write += d.write;
    root.read += d.read;
    root.shell += d.shell;
    root.lastAt = Math.max(root.lastAt, d.lastAt);
  }

  const extra = [...found.values()]
    .filter((r) => r.write || (r.git && (r.shell || r.read >= MIN_READS)))
    .sort((a, b) => b.write - a.write || b.lastAt - a.lastAt);
  for (const r of extra) {
    roots.push({ id: rootId(r.path), path: r.path, name: path.basename(r.path), git: r.git, primary: false, writes: r.write });
  }
  // Without git there is no diff, so list what the session wrote instead.
  for (const root of roots) {
    if (root.git) continue;
    root.written = [...touched.written.entries()]
      .filter(([f]) => isInside(f, root.path) && fs.existsSync(f))
      .sort((a, b) => b[1] - a[1])
      .map(([f, at]) => ({ path: path.relative(root.path, f).split(path.sep).join('/'), at }));
  }
  return roots;
}
