// The fleet: tasks the skipper hands out to crew sessions, and the events it
// is told about. The skipper is a Claude session cc-dash starts with its MCP
// tools (see mcp.js); everything here works without spending a token:
//
//  - a task is a story or job, with its worktree, branch, crew session and PR
//  - a watcher polls the crew's hook state, and notices when a crew session
//    finishes a turn, needs someone, ends, or mentions a new PR
//  - pull requests are checked with gh / az until they are merged
//  - events are typed into the skipper's terminal once it is idle and you are
//    not typing there yourself, so it wakes only when something happened
//
// State lives in ~/.cc-dash/fleet.json and survives restarts.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HOST, PORT } from './local.js';
import { DATA_DIR, IS_WIN, pathKey, safeId } from './paths.js';
import { repoFor, resolveRefs } from './refs.js';
import { allTranscripts, recentMessages, refsFor } from './transcripts.js';

const run = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const FLEET_FILE = path.join(DATA_DIR, 'fleet.json');
export const SKIPPER_DIR = path.join(DATA_DIR, 'skipper');
const SKIPPER_TEMPLATE = path.join(ROOT, 'skipper', 'CLAUDE.md');

export const PHASES = ['starting', 'working', 'needs-you', 'review', 'pr-open', 'merged', 'closed'];
const TICK_MS = 3000;
const PR_POLL_MS = 3 * 60e3;
const QUIET_AFTER_INPUT_MS = 20e3; // do not type into the skipper while you are typing there
const SETTLE_MS = 2500; // let events that come together go out as one message
const BRIEF_TIMEOUT_MS = 90e3;
const MAX_EVENTS = 200;

const now = () => Date.now();
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);

export function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9/]+/g, '-')
      .replace(/\/+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'task'
  );
}

// A git branch name we are willing to pass on: no options, no "..", no spaces.
export function validBranch(b) {
  return typeof b === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/#-]{0,120}$/.test(b) && !b.includes('..') && !b.endsWith('.lock') && !b.endsWith('/');
}

const git = (cwd, args, timeout = 30e3) =>
  run('git', ['-C', cwd, ...args], { windowsHide: true, timeout }).then(({ stdout }) => stdout.trim());

// ---- pull requests ---------------------------------------------------------

// Where a PR stands: 'open', 'merged', 'closed', or null when we cannot tell
// (no gh / az, not logged in, or not a PR URL we know).
export async function prState(url) {
  if (typeof url !== 'string') return null;
  const shell = IS_WIN; // gh and az are .cmd/.exe shims there; the arguments below are validated
  try {
    let m = url.match(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/);
    if (m) {
      const { stdout } = await run('gh', ['pr', 'view', url, '--json', 'state', '--jq', '.state'], { windowsHide: true, timeout: 30e3, shell });
      return { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }[stdout.trim()] || null;
    }
    m = url.match(/^https:\/\/dev\.azure\.com\/([\w.-]+)\/[^/\s]+\/_git\/[^/\s]+\/pullrequest\/(\d+)$/i);
    if (m) {
      const { stdout } = await run('az', ['repos', 'pr', 'show', '--id', m[2], '--org', `https://dev.azure.com/${m[1]}`, '--query', 'status', '-o', 'tsv'], {
        windowsHide: true,
        timeout: 60e3,
        shell,
      });
      return { active: 'open', completed: 'merged', abandoned: 'closed' }[stdout.trim()] || null;
    }
  } catch {}
  return null;
}

// ---- worktrees -------------------------------------------------------------

// New worktrees go in <repo>/.claude/worktrees/<name>, where Claude Code puts
// its own: inside the repo the folder is already trusted, and the path is
// kept out of `git status` through .git/info/exclude.
export async function addWorktree(repoDir, { branch, base }) {
  const top = path.resolve(await git(repoDir, ['rev-parse', '--show-toplevel']));
  const dir = path.join(top, '.claude', 'worktrees', slugify(branch));
  if (fs.existsSync(dir)) throw new Error(`The worktree folder already exists: ${dir}`);
  const common = path.resolve(top, await git(top, ['rev-parse', '--git-common-dir']));
  const exclude = path.join(common, 'info', 'exclude');
  let ex = '';
  try {
    ex = fs.readFileSync(exclude, 'utf8');
  } catch {}
  if (!ex.split(/\r?\n/).includes('.claude/worktrees/')) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${ex && !ex.endsWith('\n') ? '\n' : ''}.claude/worktrees/\n`);
  }
  await git(top, ['fetch', '--quiet', 'origin'], 60e3).catch(() => {});
  if (!base) base = (await git(top, ['rev-parse', '--verify', '--quiet', 'origin/HEAD']).then(() => 'origin/HEAD', () => null)) || 'HEAD';
  const exists = await git(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
  await git(top, ['worktree', 'add', ...(exists ? [dir, branch] : ['-b', branch, dir, base])], 120e3);
  return { repo: top, worktree: dir, branch, base: exists ? null : base };
}

// ---- the fleet -------------------------------------------------------------

export class Fleet {
  constructor(manager, { token, pickProfile }) {
    this.manager = manager;
    this.token = token;
    this.pickProfile = pickProfile;
    this.tasks = new Map();
    this.events = []; // { seq, at, task, kind, text }
    this.seq = 0;
    this.delivered = 0;
    this.skipperSession = null; // the skipper's last Claude session, to continue it
    this.seen = new Map(); // task id -> { state, prs: Set }
    this.lastPush = 0;
    this.#load();
  }

  #load() {
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(FLEET_FILE, 'utf8'));
    } catch {}
    for (const t of saved.tasks || []) this.tasks.set(t.id, t);
    this.events = saved.events || [];
    this.seq = saved.seq || 0;
    this.delivered = saved.delivered || 0;
    this.skipperSession = saved.skipperSession || null;
  }

  #save() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const data = { tasks: [...this.tasks.values()], events: this.events, seq: this.seq, delivered: this.delivered, skipperSession: this.skipperSession };
    const tmp = `${FLEET_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, FLEET_FILE);
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => console.error('fleet:', e.message)), TICK_MS);
    this.prTimer = setInterval(() => this.pollPrs().catch(() => {}), PR_POLL_MS);
    this.timer.unref?.();
    this.prTimer.unref?.();
  }

  // ---- tasks ---------------------------------------------------------------

  get(ref) {
    if (this.tasks.has(ref)) return this.tasks.get(ref);
    for (const t of this.tasks.values()) if (t.phase !== 'closed' && (t.sessionKey === ref || t.managedId === ref)) return t;
    return null;
  }

  list({ includeClosed = false } = {}) {
    return [...this.tasks.values()].filter((t) => includeClosed || t.phase !== 'closed').map((t) => this.#view(t));
  }

  #view(t) {
    const { brief, ...rest } = t;
    const s = this.#session(t);
    return { ...rest, briefPending: !!brief, state: s?.state || null, running: !!s?.running, costUsd: s?.costUsd ?? null };
  }

  #key(t) {
    const m = t.managedId && this.manager.get(t.managedId);
    if (m && m.claudeSessionId !== t.sessionKey) t.sessionKey = m.claudeSessionId; // after /clear or /resume
    return t.sessionKey;
  }

  #session(t, list = this.manager.list()) {
    const key = this.#key(t);
    return list.find((s) => s.key === key) || null;
  }

  #touch(t) {
    t.updatedAt = now();
    this.#save();
  }

  update(ref, { phase, story, pr, note, title } = {}) {
    const t = this.get(ref);
    if (!t) throw new Error(`No task "${ref}"`);
    if (phase !== undefined) {
      if (!PHASES.includes(phase)) throw new Error(`phase must be one of ${PHASES.join(', ')}`);
      t.phase = phase;
    }
    if (story !== undefined) t.story = story || null;
    if (title) t.title = title;
    if (pr !== undefined) t.pr = pr ? { url: pr, state: t.pr?.url === pr ? t.pr.state : 'open' } : null;
    if (note) t.notes.push({ at: now(), text: clip(note, 2000) });
    this.#touch(t);
    return this.#view(t);
  }

  // Starts a crew session for a task, in a new worktree unless worktree is
  // false. The brief is typed in once Claude is ready for it (hook "idle"):
  // given on the command line it would sit behind a trust prompt, or be
  // mangled by the shell.
  async startTask({ repo, title, brief, branch, base, story = null, worktree = true, profile = null }) {
    if (!repo || !fs.existsSync(repo)) throw new Error(`Folder does not exist: ${repo}`);
    if (!title) throw new Error('title is required');
    if (!brief) throw new Error('brief is required');
    if (base && !validBranch(base)) throw new Error(`Invalid base: ${base}`);
    const id = `${slugify(title).slice(0, 30)}-${randomUUID().slice(0, 4)}`;
    branch ||= `task/${slugify(title).slice(0, 40)}`;
    if (!validBranch(branch)) throw new Error(`Invalid branch name: ${branch}`);
    const where = worktree ? await addWorktree(repo, { branch, base }) : { repo: path.resolve(repo), worktree: null, branch: null, base: null };
    const prof = this.pickProfile(profile, { claude: true });
    const sess = this.manager.create({ cwd: where.worktree || where.repo, profile: prof, name: title });
    const t = {
      id,
      title,
      story,
      repo: where.repo,
      worktree: where.worktree,
      branch: where.branch,
      base: where.base,
      managedId: sess.id,
      sessionKey: sess.claudeSessionId,
      phase: 'starting',
      brief,
      pr: null,
      notes: [],
      createdAt: now(),
      updatedAt: now(),
    };
    this.tasks.set(id, t);
    this.#save();
    return this.#view(t);
  }

  // Makes an existing session (started here or in another terminal) a task.
  track({ session, title, story = null }) {
    const s = this.manager.list().find((x) => x.key === session || x.managedId === session || x.key.startsWith(session));
    if (!s) throw new Error(`No session "${session}"`);
    const existing = this.get(s.key);
    if (existing) return this.#view(existing);
    const id = `${slugify(title || s.title || s.key).slice(0, 30)}-${randomUUID().slice(0, 4)}`;
    const t = {
      id,
      title: title || s.title || s.key,
      story,
      repo: s.projectRoot,
      worktree: s.cwd && s.projectRoot && pathKey(s.cwd) !== pathKey(s.projectRoot) ? s.cwd : null,
      branch: s.gitBranch,
      base: null,
      managedId: s.managedId,
      sessionKey: s.key,
      phase: s.state === 'waiting' ? 'needs-you' : 'working',
      brief: null,
      pr: null,
      notes: [],
      createdAt: now(),
      updatedAt: now(),
    };
    this.tasks.set(id, t);
    this.#save();
    return this.#view(t);
  }

  // Ends the crew session and removes the worktree. git refuses to remove a
  // worktree with changes that are not committed, and that is left as is:
  // the skipper has to ask. The branch is only deleted when asked, with -d,
  // or with -D once its PR is known to be merged (a squash merge leaves it
  // unmerged as far as the local repo knows).
  async finish(ref, { removeWorktree = true, deleteBranch = false } = {}) {
    const t = this.get(ref);
    if (!t) throw new Error(`No task "${ref}"`);
    const done = [];
    if (t.managedId && this.manager.kill(t.managedId)) done.push('ended the session');
    if (removeWorktree && t.worktree && fs.existsSync(t.worktree)) {
      try {
        await git(t.repo, ['worktree', 'remove', t.worktree]);
        done.push(`removed the worktree ${t.worktree}`);
      } catch (e) {
        throw new Error(`Could not remove the worktree (${e.stderr?.trim() || e.message}). ${done.join(', ')}`);
      }
    }
    if (deleteBranch && t.branch && validBranch(t.branch)) {
      try {
        await git(t.repo, ['branch', t.pr?.state === 'merged' ? '-D' : '-d', t.branch]);
        done.push(`deleted the branch ${t.branch}`);
      } catch (e) {
        done.push(`kept the branch ${t.branch} (${e.stderr?.trim() || e.message})`);
      }
    }
    t.phase = 'closed';
    t.closedAt = now();
    this.seen.delete(t.id);
    this.#touch(t);
    return { task: this.#view(t), done };
  }

  // ---- events --------------------------------------------------------------

  #event(t, kind, text) {
    this.events.push({ seq: ++this.seq, at: now(), task: t?.id || null, kind, text });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.#save();
  }

  // Undelivered events, which then count as delivered.
  takeEvents() {
    const out = this.events.filter((e) => e.seq > this.delivered);
    this.delivered = this.seq;
    this.#save();
    return out;
  }

  #lastWords(key) {
    const msgs = recentMessages(key, { last: 15, maxChars: 600 }) || [];
    return msgs.filter((m) => m.role === 'claude').pop()?.text || null;
  }

  async tick() {
    const list = this.manager.list();
    this.noteSkipper();
    for (const t of this.tasks.values()) {
      if (t.phase === 'closed') continue;
      const s = this.#session(t, list);
      const seen = this.seen.get(t.id) || { state: undefined, turn: null };
      const first = seen.state === undefined; // just started watching it
      const state = s?.running || s?.external ? s.state : 'gone';
      // A turn is done when the session is idle after a prompt we have not
      // reported yet. Going by when the turn began (from the hook) rather than
      // by seeing "working" catches turns shorter than a tick, too.
      const turn = s?.turnStartedAt || null;
      if (first) seen.turn = turn;

      if (t.brief) {
        if (state === 'idle' && this.manager.type(t.managedId, t.brief)) {
          t.brief = null;
          t.phase = 'working';
          this.#touch(t);
        } else if (now() - t.createdAt > BRIEF_TIMEOUT_MS && !t.briefLate) {
          t.briefLate = true;
          this.#event(t, 'not-started', 'Has not got its brief yet: the session is not ready (a trust or login prompt?). Ask the captain to look at it.');
        }
      } else if (!first && state === 'idle' && turn && turn !== seen.turn) {
        seen.turn = turn;
        if (t.phase === 'needs-you') t.phase = 'working';
        const said = this.#lastWords(this.#key(t));
        this.#event(t, 'turn-done', `Finished its turn.${said ? ` Last message: "${clip(said.replace(/\s+/g, ' '), 500)}"` : ''}`);
        this.#touch(t);
      } else if (!first && state !== seen.state) {
        if (state === 'waiting') {
          if (t.phase === 'working') t.phase = 'needs-you';
          this.#event(t, 'needs-input', `Is waiting: ${s?.stateDetail || 'a prompt that needs an answer'}.`);
        } else if (state === 'gone' || state === 'ended') {
          this.#event(t, 'ended', 'The session has ended.');
        }
        if (state === 'working' && t.phase === 'needs-you') t.phase = 'working';
        this.#touch(t);
      }
      seen.state = state;

      // A PR for the task's own repo that shows up in the crew's transcript
      // (see refs.js) is taken to be the task's. Links to other PRs are not.
      const key = this.#key(t);
      const refs = !t.pr && key && refsFor(key);
      if (refs) {
        const repo = await repoFor(t.worktree || t.repo);
        const pr = repo && resolveRefs(refs, repo).find((r) => r.kind === 'pr' && r.url && r.repo === repo.name && r.host === repo.host);
        if (pr) {
          t.pr = { url: pr.url, state: 'open' };
          if (['starting', 'working', 'needs-you', 'review'].includes(t.phase)) t.phase = 'pr-open';
          // Not for a PR that was already there when the task was tracked.
          if (!first) this.#event(t, 'pr-opened', `Opened a pull request: ${pr.url}`);
          this.#touch(t);
        }
      }
      this.seen.set(t.id, seen);
    }
    this.#push(list);
  }

  async pollPrs() {
    for (const t of this.tasks.values()) {
      if (t.phase === 'closed' || !t.pr?.url || t.pr.state === 'merged') continue;
      const st = await prState(t.pr.url);
      if (!st || st === t.pr.state) continue;
      t.pr.state = st;
      if (st === 'merged') {
        t.phase = 'merged';
        this.#event(t, 'pr-merged', `The pull request was merged: ${t.pr.url}`);
      } else if (st === 'closed') this.#event(t, 'pr-closed', `The pull request was closed without merging: ${t.pr.url}`);
      this.#touch(t);
    }
  }

  // ---- the skipper ---------------------------------------------------------

  skipper() {
    for (const m of this.manager.managed.values()) if (m.role === 'skipper') return m;
    return null;
  }

  #push(list) {
    const pending = this.events.filter((e) => e.seq > this.delivered);
    const sk = this.skipper();
    if (!pending.length || !sk) return;
    if (now() - pending[pending.length - 1].at < SETTLE_MS || now() - this.lastPush < SETTLE_MS) return;
    if (now() - (this.manager.lastInput.get(sk.id) || 0) < QUIET_AFTER_INPUT_MS) return;
    if (list.find((s) => s.managedId === sk.id)?.state !== 'idle') return;
    const lines = pending.map((e) => {
      const t = e.task && this.tasks.get(e.task);
      return `- ${t ? `[${t.id}] ${t.title}` : '[fleet]'}: ${e.text}`;
    });
    const msg = `[cc-dash] ${pending.length === 1 ? 'One event' : `${pending.length} events`} from the fleet:\n${lines.join('\n')}`;
    if (this.manager.type(sk.id, msg)) {
      this.delivered = pending[pending.length - 1].seq;
      this.lastPush = now();
      this.#save();
    }
  }

  // Starts the skipper, or returns the one that runs. It continues its last
  // conversation unless fresh is set. The MCP config holds the token, so it
  // is written next to config.json, readable only by you.
  startSkipper({ fresh = false, profile = null } = {}) {
    const running = this.skipper();
    if (running) return running;
    fs.mkdirSync(SKIPPER_DIR, { recursive: true });
    fs.copyFileSync(SKIPPER_TEMPLATE, path.join(SKIPPER_DIR, 'CLAUDE.md'));
    const mcpFile = path.join(SKIPPER_DIR, 'mcp.json');
    const host = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
    const mcp = { mcpServers: { 'cc-dash': { type: 'http', url: `http://${host}:${PORT}/mcp`, headers: { Authorization: `Bearer ${this.token}` } } } };
    fs.writeFileSync(mcpFile, JSON.stringify(mcp, null, 2), { mode: 0o600 });
    const resumeId = !fresh && safeId(this.skipperSession) && allTranscripts().has(this.skipperSession) ? this.skipperSession : null;
    const sess = this.manager.create({
      cwd: SKIPPER_DIR,
      resumeId,
      profile: this.pickProfile(profile, { claude: true }),
      role: 'skipper',
      name: 'Skipper',
      extraArgs: ['--mcp-config', mcpFile, '--allowedTools', 'mcp__cc-dash'],
    });
    this.skipperSession = sess.claudeSessionId;
    this.#save();
    return sess;
  }

  // The skipper's session id changes after /clear; keep the latest.
  noteSkipper() {
    const sk = this.skipper();
    if (sk && sk.claudeSessionId !== this.skipperSession) {
      this.skipperSession = sk.claudeSessionId;
      this.#save();
    }
  }
}
