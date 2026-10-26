// The fleet: tasks the skipper hands out to crew sessions, and the events it
// is told about. The skipper is a Claude session cc-dash starts with its MCP
// tools (see mcp.js); everything here works without spending a token:
//
//  - a task is a story or job, with its worktree, branch, crew session and PR
//  - a watcher polls the crew's hook state, and notices when a crew session
//    finishes a turn, needs someone, or ends
//  - a task's pull request is found by its branch with gh / az, and checked
//    until it is merged
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
import { repoFor } from './refs.js';
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

// A task's PR is the one gh / az list with the task's branch as its source, in
// the task's repo. A PR link in the crew's transcript is not enough: a story
// or document the crew reads can link any PR, from any repo.
//
// A PR is { url, state: 'open' | 'merged' | 'closed', createdAt, closedAt, branch },
// times in ms or null.

const GH_STATE = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };
const AZ_STATE = { active: 'open', completed: 'merged', abandoned: 'closed' };
const time = (s) => (s && Date.parse(s)) || null;
const GH_FIELDS = 'url,state,createdAt,closedAt,headRefName,isCrossRepository';

// gh and az are .cmd/.exe shims on Windows and need a shell there, which does
// not quote the arguments: quote them, and refuse anything cmd could read as
// more than a name.
const cli = (cmd, args, timeout) => run(cmd, args, { windowsHide: true, timeout, shell: IS_WIN }).then(({ stdout }) => JSON.parse(stdout));
function arg(s) {
  if (!/^[\w ./#:@-]+$/.test(s)) throw new Error(`Not passed to a shell: ${s}`);
  return IS_WIN && /[ #]/.test(s) ? `"${s}"` : s;
}

const fromGithub = (p) => ({ url: p.url, state: GH_STATE[p.state] || null, createdAt: time(p.createdAt), closedAt: time(p.closedAt), branch: p.headRefName });
const fromAzure = (p, web) => ({
  url: `${web}/pullrequest/${p.pullRequestId}`,
  state: AZ_STATE[p.status] || null,
  createdAt: time(p.creationDate),
  closedAt: time(p.closedDate),
  branch: p.sourceRefName?.replace(/^refs\/heads\//, '') || null,
});

// The PRs from a branch of a repo (see refs.js), or null when we cannot tell
// (no gh / az, not logged in, or not a repo we know).
export async function findPrs(repo, branch) {
  if (!repo || !validBranch(branch)) return null;
  try {
    if (repo.host === 'github') {
      const list = await cli('gh', ['pr', 'list', '--repo', arg(repo.name), '--head', arg(branch), '--state', 'all', '--limit', '20', '--json', GH_FIELDS], 30e3);
      // --head is the branch name only, so it also matches forks.
      return list.filter((p) => p.headRefName === branch && !p.isCrossRepository).map(fromGithub);
    }
    if (repo.host === 'azure') {
      const org = `https://dev.azure.com/${encodeURIComponent(repo.org)}`;
      const list = await cli(
        'az',
        ['repos', 'pr', 'list', '--org', arg(org), '--project', arg(repo.projectName), '--repository', arg(repo.name), '--source-branch', arg(`refs/heads/${branch}`), '--status', 'all', '--top', '20', '-o', 'json'],
        60e3,
      );
      const same = (p) => p.sourceRefName === `refs/heads/${branch}` && (!p.repository?.name || p.repository.name.toLowerCase() === repo.name.toLowerCase());
      return list.filter(same).map((p) => fromAzure(p, repo.web));
    }
  } catch {}
  return null;
}

// One PR by its URL, or null when we cannot tell. For a PR the skipper set.
export async function prInfo(url) {
  if (typeof url !== 'string') return null;
  try {
    if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url)) return { ...fromGithub(await cli('gh', ['pr', 'view', url, '--json', GH_FIELDS], 30e3)), url };
    const m = url.match(/^https:\/\/dev\.azure\.com\/([\w.-]+)\/[^/\s]+\/_git\/[^/\s]+\/pullrequest\/(\d+)$/i);
    if (m) return { ...fromAzure(await cli('az', ['repos', 'pr', 'show', '--id', m[2], '--org', `https://dev.azure.com/${m[1]}`, '-o', 'json'], 60e3), ''), url };
  } catch {}
  return null;
}

// Of the PRs from a task's branch, the one that is the task's: not one the
// skipper cleared, not one that was merged or closed before the task began.
// An open one first, then the newest.
export function pickPr(prs, t) {
  const dropped = new Set(t.prDropped || []);
  const ok = prs.filter((p) => p.url && p.state && !dropped.has(p.url) && !doneBefore(p, t));
  return ok.sort((a, b) => (b.state === 'open') - (a.state === 'open') || (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
}

const doneBefore = (p, t) => p.state !== 'open' && (p.closedAt ?? p.createdAt ?? 0) < t.createdAt;

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
  // prs looks PRs up with gh / az: find(folder, branch) and info(url), as
  // findPrs and prInfo above. Tests give their own.
  constructor(manager, { token, pickProfile, prs = { find: async (dir, branch) => findPrs(await repoFor(dir), branch), info: prInfo } }) {
    this.manager = manager;
    this.token = token;
    this.pickProfile = pickProfile;
    this.prs = prs;
    this.checks = new Map(); // task id -> PR lookup in flight
    this.tasks = new Map();
    this.events = []; // { seq, at, task, kind, text }
    this.seq = 0;
    this.delivered = 0;
    this.skipperSession = null; // the skipper's last Claude session, to continue it
    this.seen = new Map(); // task id -> { state, turn, prs: Set of PR ref keys }
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
    if (pr !== undefined) {
      // A PR the skipper sets stays until it changes it; finding PRs by branch
      // only follows its state. One it clears or replaces is not taken again,
      // but another one from the branch is.
      if (t.pr?.url && t.pr.url !== pr) t.prDropped = [...new Set([...(t.prDropped || []), t.pr.url])];
      if (pr) t.prDropped = t.prDropped?.filter((u) => u !== pr);
      t.pr = pr ? { url: pr, state: t.pr?.url === pr ? t.pr.state : 'open', manual: true } : null;
    }
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

      // The crew mentioning a PR it has not mentioned before is a hint to look
      // the task's PR up now rather than at the next poll. The PR found is
      // the one from the task's branch, whatever the link was.
      const key = this.#key(t);
      const refs = key && refsFor(key);
      if (refs) {
        const prs = [...refs.values()].filter((r) => r.kind === 'pr').map((r) => r.key);
        if (prs.some((k) => !seen.prs?.has(k)) && this.#looksForPr(t)) this.checkPr(t.id).catch(() => {});
        seen.prs = new Set(prs);
      }
      this.seen.set(t.id, seen);
    }
    this.#push(list);
  }

  async pollPrs() {
    for (const t of this.tasks.values()) await this.checkPr(t.id).catch(() => {});
  }

  // A PR found by branch that is merged is done with. One the skipper set, or
  // one from before PRs were found by branch, is still checked.
  #looksForPr(t) {
    return t.phase !== 'closed' && !(t.pr?.by === 'branch' && t.pr.state === 'merged');
  }

  // Finds the task's PR, or how the one it has stands, and tells the skipper
  // what changed. One lookup per task at a time.
  checkPr(id) {
    if (!this.checks.has(id)) this.checks.set(id, this.#checkPr(id).finally(() => this.checks.delete(id)));
    return this.checks.get(id);
  }

  async #checkPr(id) {
    const t = this.tasks.get(id);
    if (!t || !this.#looksForPr(t)) return;
    let pr;
    if (t.pr?.manual || !t.branch) {
      if (!t.pr?.url || t.pr.state === 'merged') return;
      pr = await this.prs.info(t.pr.url);
    } else {
      const found = await this.prs.find(t.worktree || t.repo, t.branch);
      if (!found) return; // cannot tell
      pr = pickPr(found, t);
      if (!pr && t.pr) return this.#dropPr(t);
    }
    if (pr?.state && t.phase !== 'closed') this.#takePr(t, pr);
  }

  // The PR the task had is not from its branch: it was taken from a link in
  // the transcript, before PRs were found by branch. Undo what it did.
  #dropPr(t) {
    const url = t.pr.url;
    t.pr = null;
    if (['pr-open', 'merged'].includes(t.phase)) t.phase = 'working';
    this.#event(t, 'pr-dropped', `${url} is not this task's pull request (not from its branch ${t.branch}); cleared it.`);
    this.#touch(t);
  }

  #takePr(t, pr) {
    const old = t.pr?.url === pr.url ? t.pr : null;
    if (old && old.state === pr.state && (old.manual || old.by)) return;
    const changed = !old || old.state !== pr.state;
    t.pr = old?.manual ? { ...old, state: pr.state } : { url: pr.url, state: pr.state, by: 'branch' };
    // Nothing to tell about a PR that was merged or closed before the task
    // began, or what is already known about one from before.
    if (doneBefore(pr, t) || !changed) return this.#touch(t);
    if (pr.state === 'open') {
      if (['starting', 'working', 'needs-you', 'review'].includes(t.phase) || (!old && t.phase === 'merged')) t.phase = 'pr-open';
      // Not for a PR that was already there when the task was tracked.
      if (!pr.createdAt || pr.createdAt >= t.createdAt) this.#event(t, 'pr-opened', `Opened a pull request: ${pr.url}`);
    } else if (pr.state === 'merged') {
      t.phase = 'merged';
      this.#event(t, 'pr-merged', `The pull request was merged: ${pr.url}`);
    } else this.#event(t, 'pr-closed', `The pull request was closed without merging: ${pr.url}`);
    this.#touch(t);
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
