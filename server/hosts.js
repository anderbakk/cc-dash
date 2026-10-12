// Terminal backends. Both expose the same interface:
//   start(sess)            launch `claude` for a session
//   isAlive(sess)          is the process still running
//   attach(sess, size)     -> view { onData(cb), onExit(cb), write(s), resize(c, r), close() }
//   kill(sess)
//
// TmuxHost (Linux/macOS when tmux is installed): sessions live in a private
// tmux server, so they survive cc-dash restarts. Each browser connection gets
// its own `tmux attach` client, which also gives a clean redraw for free.
//
// PtyHost (Windows, or no tmux): cc-dash owns the process through node-pty.
// Sessions survive closing the browser, but not restarting cc-dash; they can
// then be continued with `claude --resume`.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pty from 'node-pty';
import { DATA_DIR, IS_WIN } from './paths.js';

const SCROLLBACK_BYTES = 512 * 1024;

// Variables Claude Code sets for its own child processes. If cc-dash itself is
// started from inside a Claude session they must not leak into new sessions.
// CLAUDE_CODE_CHILD_SESSION in particular turns transcript saving off, which
// would leave every session cc-dash starts without a title, cost or --resume.
const STRIP_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_PID',
];

export function childEnv(extra = {}) {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...extra };
  for (const k of STRIP_ENV) delete env[k];
  return env;
}

// node-pty on Windows only finds a bare name on PATH if it has its extension
// ("powershell.exe" works, "pwsh" does not). Resolve it the way a shell would,
// and fail with a message that says which shell is missing.
export function resolveShell(shell) {
  if (!IS_WIN || /[\\/]/.test(shell)) return shell;
  const exts = path.extname(shell) ? [''] : (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';');
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const full = path.join(dir, shell + ext);
      if (dir && fs.existsSync(full)) return full;
    }
  }
  throw new Error(`Fant ikke skallet «${shell}» på PATH`);
}

export const defaultShell = () =>process.env.CC_DASH_SHELL || (IS_WIN ? 'powershell.exe' : process.env.SHELL || '/bin/bash');

// The three families of shell we know how to drive.
export function shellKind(shell) {
  const name = path.basename(shell).toLowerCase().replace(/\.exe$/, '');
  if (name === 'pwsh' || name === 'powershell') return 'ps';
  if (name === 'cmd') return 'cmd';
  return 'posix';
}

// Quote one argument for the shell that will run the claude command line.
function quote(arg, kind) {
  if (/^[A-Za-z0-9_\-./:=@]+$/.test(arg)) return arg;
  if (kind === 'ps') return `'${arg.replace(/'/g, "''")}'`;
  if (kind === 'cmd') return `"${arg.replace(/"/g, '""')}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

// A fresh ConPTY console starts on the system OEM code page (850 in Norway),
// so UTF-8 output from claude would be decoded as Latin-1: æøå and the box
// drawing in the TUI turn to mojibake. Switch the console to UTF-8 first.
// UTF8Encoding::new($false) = no BOM, unlike [Text.Encoding]::UTF8.
const WIN_UTF8 = '[Console]::OutputEncoding=[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)';

// Returns [file, args] for a session's launch spec (see profiles.js): the
// shell runs `init` first, then either claude with `args` or, for a plain
// terminal, stays open at its prompt. The shell's own profile/rc is loaded,
// so functions defined there (like a login helper) can be used as `init`.
export function launchCommand({ shell, init, command, claude, args = [] }) {
  shell ||= defaultShell();
  const kind = shellKind(shell);
  const cmdline = claude ? [command || process.env.CC_DASH_CLAUDE_CMD || 'claude', ...args.map((a) => quote(a, kind))].join(' ') : null;
  if (kind === 'ps') {
    const steps = [WIN_UTF8, init, cmdline && `& ${cmdline}`].filter(Boolean).join('; ');
    return [shell, ['-NoLogo', ...(claude ? [] : ['-NoExit']), '-Command', steps]];
  }
  if (kind === 'cmd') {
    const steps = ['chcp 65001 >nul', init, cmdline].filter(Boolean).join(' & ');
    return [shell, [claude ? '/C' : '/K', steps]];
  }
  if (claude) return [shell, ['-lc', [init, `exec ${cmdline}`].filter(Boolean).join('; ')]];
  // A plain shell after init: exec a fresh login shell. Exported variables
  // carry over; functions and aliases defined by init do not.
  return init ? [shell, ['-lc', `${init}; exec ${quote(shell, kind)} -l`]] : [shell, ['-l']];
}

export class PtyHost {
  name = 'pty';
  #procs = new Map(); // session id -> { pty, chunks, bytes, listeners, exitListeners }

  constructor({ onExit } = {}) {
    this.onExit = onExit;
  }

  start(sess) {
    const [file, args] = launchCommand(sess.launch);
    const p = pty.spawn(resolveShell(file), args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: sess.cwd,
      env: childEnv({ ...sess.launch.env, CC_DASH_SESSION: sess.id }),
    });
    const proc = { pty: p, chunks: [], bytes: 0, listeners: new Set(), exitListeners: new Set(), alive: true };
    p.onData((d) => {
      proc.chunks.push(d);
      proc.bytes += d.length;
      while (proc.bytes > SCROLLBACK_BYTES && proc.chunks.length > 1) proc.bytes -= proc.chunks.shift().length;
      for (const l of proc.listeners) l(d);
    });
    p.onExit(({ exitCode }) => {
      proc.alive = false;
      for (const l of proc.exitListeners) l(exitCode);
      this.#procs.delete(sess.id);
      this.onExit?.(sess, exitCode);
    });
    this.#procs.set(sess.id, proc);
  }

  isAlive(sess) {
    return this.#procs.get(sess.id)?.alive ?? false;
  }

  attach(sess, { cols, rows }) {
    const proc = this.#procs.get(sess.id);
    if (!proc) return null;
    let dataCb = () => {};
    let exitCb = () => {};
    const onData = (d) => dataCb(d);
    const onExit = (c) => exitCb(c);
    return {
      onData(cb) {
        dataCb = cb;
        // Replay recent output, then wiggle the size so the TUI redraws
        // itself cleanly for the newly attached terminal.
        if (proc.chunks.length) cb(proc.chunks.join(''));
        proc.listeners.add(onData);
        setTimeout(() => {
          if (!proc.alive) return;
          try {
            proc.pty.resize(Math.max(cols - 1, 20), rows);
            proc.pty.resize(cols, rows);
          } catch {}
        }, 50);
      },
      onExit(cb) {
        exitCb = cb;
        proc.exitListeners.add(onExit);
      },
      write: (s) => proc.alive && proc.pty.write(s),
      resize: (c, r) => {
        try {
          if (proc.alive) proc.pty.resize(c, r);
        } catch {}
      },
      close() {
        proc.listeners.delete(onData);
        proc.exitListeners.delete(onExit);
      },
    };
  }

  kill(sess) {
    this.#procs.get(sess.id)?.pty.kill();
  }

  killAll() {
    for (const p of this.#procs.values()) p.pty.kill();
  }
}

const TMUX_CONF = `# Written by cc-dash. Applies only to cc-dash's private tmux server.
set -g status off
set -g mouse on
set -g history-limit 50000
set -sg escape-time 0
set -g default-terminal "tmux-256color"
set -as terminal-features ",xterm-256color:RGB:extkeys"
set -g extended-keys on
set -g window-size latest
set -g aggressive-resize on
`;

export class TmuxHost {
  name = 'tmux';

  constructor() {
    this.bin = process.env.CC_DASH_TMUX || 'tmux';
    this.socket = process.env.CC_DASH_TMUX_SOCKET || 'cc-dash';
    this.conf = path.join(DATA_DIR, 'tmux.conf');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(this.conf, TMUX_CONF);
  }

  static available() {
    if (IS_WIN || process.env.CC_DASH_HOST === 'pty') return false;
    const r = spawnSync(process.env.CC_DASH_TMUX || 'tmux', ['-V'], { stdio: 'ignore' });
    return r.status === 0;
  }

  #tmux(args, opts = {}) {
    return execFileSync(this.bin, ['-L', this.socket, '-f', this.conf, ...args], {
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    }).toString();
  }

  #target(sess) {
    return `cc-${sess.id}`;
  }

  start(sess) {
    const [file, args] = launchCommand(sess.launch);
    const cmd = [file, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    const env = Object.entries({ ...sess.launch.env, CC_DASH_SESSION: sess.id }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    this.#tmux(['new-session', '-d', '-s', this.#target(sess), '-x', '120', '-y', '40', '-c', sess.cwd, ...env, cmd]);
    this.#live.at = 0;
  }

  #live = { at: 0, set: new Set() };

  // Cached briefly: the sidebar polls this for every managed session.
  liveTargets() {
    if (Date.now() - this.#live.at < 500) return this.#live.set;
    let set;
    try {
      set = new Set(this.#tmux(['list-sessions', '-F', '#{session_name}']).split('\n').filter(Boolean));
    } catch {
      set = new Set(); // no server running yet
    }
    this.#live = { at: Date.now(), set };
    return set;
  }

  isAlive(sess) {
    return this.liveTargets().has(this.#target(sess));
  }

  attach(sess, { cols, rows }) {
    if (!this.isAlive(sess)) return null;
    const p = pty.spawn(this.bin, ['-L', this.socket, '-f', this.conf, 'attach-session', '-t', this.#target(sess)], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: sess.cwd,
      env: childEnv(),
    });
    let closed = false;
    return {
      onData: (cb) => p.onData(cb),
      onExit: (cb) => p.onExit(({ exitCode }) => !closed && cb(exitCode)),
      write: (s) => p.write(s),
      resize: (c, r) => {
        try {
          p.resize(c, r);
        } catch {}
      },
      close() {
        closed = true;
        p.kill(); // detaches this client; the session keeps running
      },
    };
  }

  kill(sess) {
    try {
      this.#tmux(['kill-session', '-t', this.#target(sess)]);
    } catch {}
    this.#live.at = 0;
  }
}
