// Combines three sources into the sidebar list:
//  - managed sessions: started from cc-dash, running in a host (tmux/pty)
//  - transcripts: every recent Claude Code session on this machine
//  - hook status files: live state (working / waiting / idle / ended)
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, STATE_FILE, STATUS_DIR, safeId } from './paths.js';
import { sessionRoots } from './folders.js';
import { allTranscripts, touchedFor } from './transcripts.js';

const EXTERNAL_LIVE_MS = 24 * 3600e3; // hook status older than this is treated as stale
const MAX_RECENT = 60;

export class SessionManager {
  constructor(host) {
    this.host = host;
    this.managed = new Map(); // id -> { id, claudeSessionId, cwd, args, createdAt }
    this.#load();
  }

  #load() {
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {}
    // Only tmux sessions can outlive cc-dash. Anything else that is gone shows
    // up again as a normal transcript and can be resumed from there.
    for (const s of saved.sessions || []) if (this.host.isAlive(s)) this.managed.set(s.id, s);
    this.profileOf = new Map(Object.entries(saved.profiles || {})); // claude session id -> profile id
    this.#save();
  }

  #save() {
    // Keep the remembered profiles from growing forever.
    const recent = [...this.profileOf].slice(-500);
    this.profileOf = new Map(recent);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ sessions: [...this.managed.values()], profiles: Object.fromEntries(recent) }, null, 2));
  }

  // profile: from profiles.js. A Claude profile starts (or resumes) a Claude
  // session; any other gives a plain shell, which has no transcript and only
  // lives as long as its process.
  create({ cwd, resumeId, profile }) {
    cwd ||= profile.cwd;
    if (!cwd || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Mappen finnes ikke: ${cwd}`);
    }
    if (resumeId && !safeId(resumeId)) throw new Error('Ugyldig sesjons-id');
    if (resumeId && !profile.claude) throw new Error(`Profilen «${profile.name}» starter ikke Claude`);
    for (const s of this.managed.values()) {
      if (resumeId && s.claudeSessionId === resumeId) return s; // already running here
    }
    const id = randomUUID().slice(0, 8);
    // Plain shells get a key of their own in the same namespace, so the
    // sidebar, diff and files treat them like any other session.
    const claudeSessionId = profile.claude ? resumeId || randomUUID() : `shell-${id}`;
    const sess = {
      id,
      claudeSessionId,
      shell: !profile.claude,
      profileId: profile.id,
      profileName: profile.name,
      cwd: path.resolve(cwd),
      // A snapshot: editing the profile later does not change a running session.
      launch: {
        shell: profile.shell,
        init: profile.init,
        command: profile.command,
        claude: profile.claude,
        env: profile.env,
        args: !profile.claude ? [] : resumeId ? ['--resume', resumeId] : ['--session-id', claudeSessionId],
      },
      createdAt: Date.now(),
    };
    this.host.start(sess);
    this.managed.set(sess.id, sess);
    if (profile.claude) this.profileOf.set(claudeSessionId, profile.id);
    this.#save();
    return sess;
  }

  // Which profile a Claude session was started with here, so continuing it
  // later uses the same one (same login, same env).
  rememberedProfile(claudeSessionId) {
    return this.profileOf.get(claudeSessionId) || null;
  }

  get(id) {
    return this.managed.get(id) || null;
  }

  kill(id) {
    const s = this.managed.get(id);
    if (!s) return false;
    this.host.kill(s);
    this.forget(id);
    return true;
  }

  forget(id) {
    if (this.managed.delete(id)) this.#save();
  }

  #prune() {
    for (const s of this.managed.values()) if (!this.host.isAlive(s)) this.managed.delete(s.id);
  }

  #status(sessionId) {
    const read = (suffix) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(STATUS_DIR, `${sessionId}.${suffix}.json`), 'utf8'));
      } catch {
        return null;
      }
    };
    return { hook: read('hook'), line: read('line') };
  }

  // The working directory of any known session (used for diff/files).
  cwdFor(key) {
    for (const s of this.managed.values()) if (s.claudeSessionId === key) return s.cwd;
    return allTranscripts().get(key)?.cwd || null;
  }

  // Every folder the session works in, its cwd first (see folders.js).
  rootsFor(key) {
    return sessionRoots(this.cwdFor(key), touchedFor(key));
  }

  // The folder behind a root id, for diff/files. 'main' (or none) is the cwd.
  async rootDir(key, id) {
    if (!id || id === 'main') return this.cwdFor(key);
    return (await this.rootsFor(key)).find((r) => r.id === id)?.path || null;
  }

  list() {
    const before = this.managed.size;
    this.#prune();
    if (this.managed.size !== before) this.#save();

    const transcripts = allTranscripts();
    const byClaudeId = new Map([...this.managed.values()].map((s) => [s.claudeSessionId, s]));
    const keys = new Set([...transcripts.keys(), ...byClaudeId.keys()]);
    const now = Date.now();
    const out = [];
    for (const key of keys) {
      const t = transcripts.get(key);
      const m = byClaudeId.get(key);
      const { hook, line } = this.#status(key);
      const cwd = m?.cwd || t?.cwd || hook?.cwd || null;
      const hookFresh = hook && now - hook.ts < EXTERNAL_LIVE_MS;
      let state = hookFresh ? hook.state : null;
      if (!m && state === 'ended') state = null;
      out.push({
        key,
        managedId: m?.id || null,
        running: !!m,
        // Open in a terminal outside cc-dash (according to the hooks).
        external: !m && !!state,
        shell: !!m?.shell, // a plain terminal, not Claude
        profileId: m?.profileId || this.profileOf.get(key) || null,
        title: t?.title || (m?.shell ? m.profileName : null),
        cwd,
        project: cwd ? path.basename(cwd) : null,
        gitBranch: t?.gitBranch && t.gitBranch !== 'HEAD' ? t.gitBranch : null,
        model: line?.model?.display_name || t?.model || null,
        costUsd: t?.costUsd ?? 0,
        costIncomplete: t?.costIncomplete || false,
        tokens: t?.tokens || 0,
        contextPct: line?.context_window?.used_percentage ?? null,
        state,
        stateDetail: hookFresh ? hook.detail || null : null,
        stateAt: hookFresh ? hook.ts : null,
        lastPrompt: hook?.prompt || t?.lastPrompt || t?.firstPrompt || null,
        startedAt: t?.startedAt || m?.createdAt || null,
        lastAt: Math.max(t?.lastAt || 0, hookFresh ? hook.ts : 0, m?.createdAt || 0) || null,
      });
    }
    out.sort((a, b) => b.running - a.running || b.external - a.external || (b.lastAt || 0) - (a.lastAt || 0));
    const live = out.filter((s) => s.running || s.external);
    const recent = out.filter((s) => !s.running && !s.external).slice(0, MAX_RECENT);
    return [...live, ...recent];
  }

  recentDirs() {
    const seen = new Map();
    for (const t of allTranscripts().values()) {
      if (t.cwd && fs.existsSync(t.cwd)) seen.set(t.cwd, Math.max(seen.get(t.cwd) || 0, t.lastAt || 0));
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([dir]) => dir).slice(0, 20);
  }
}
