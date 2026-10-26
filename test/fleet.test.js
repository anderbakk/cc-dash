import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Point cc-dash at a scratch folder before anything reads it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-fleet-'));
process.env.CC_DASH_DIR = path.join(dir, 'data');
process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { Fleet, addWorktree, pickPr, slugify, validBranch } = await import('../server/fleet.js');
const { createMcp } = await import('../server/mcp.js');
const { scanTranscripts, tailMessages } = await import('../server/transcripts.js');

// Stands in for SessionManager: sessions are plain objects the test changes.
function fakeManager() {
  const typed = [];
  const m = {
    typed,
    managed: new Map(),
    lastInput: new Map(),
    sessions: [],
    list: () => m.sessions,
    get: (id) => m.managed.get(id) || null,
    type: (id, text) => (m.managed.has(id) ? typed.push({ id, text }) > 0 : false),
    kill: (id) => m.managed.delete(id),
    create({ cwd, role = null }) {
      const id = `m${m.managed.size + 1}`;
      const s = { id, claudeSessionId: `key-${id}`, cwd, role };
      m.managed.set(id, s);
      m.sessions.push({ key: s.claudeSessionId, managedId: id, running: true, role, state: null, cwd });
      return s;
    },
  };
  return m;
}
const pickProfile = () => ({ id: 'claude', name: 'Claude', claude: true });
const sessionOf = (m, id) => m.sessions.find((s) => s.managedId === id);

test('slugify and validBranch', () => {
  assert.equal(slugify('Fiks innlogging på mobil!'), 'fiks-innlogging-pa-mobil');
  assert.equal(slugify('feature/AB#12 Login'), 'feature-ab-12-login');
  assert.ok(validBranch('feature/AB#123-login'));
  assert.ok(!validBranch('-x'));
  assert.ok(!validBranch('a..b'));
  assert.ok(!validBranch('a b'));
});

test('a task gets its brief once the crew is ready, then events reach the skipper', async () => {
  const m = fakeManager();
  const fleet = new Fleet(m, { token: 't', pickProfile });
  const t = await fleet.startTask({ repo: dir, title: 'Fix login', brief: 'Do the thing', worktree: false });
  assert.equal(t.phase, 'starting');
  const crew = sessionOf(m, t.managedId);

  await fleet.tick(); // not ready yet: no brief
  assert.equal(m.typed.length, 0);
  crew.state = 'idle';
  await fleet.tick();
  assert.deepEqual(m.typed, [{ id: t.managedId, text: 'Do the thing' }]);
  assert.equal(fleet.get(t.id).phase, 'working');

  // A turn shorter than a tick: never seen working, but it began and is over.
  crew.turnStartedAt = 1000;
  await fleet.tick();
  await fleet.tick();
  assert.deepEqual(fleet.events.map((e) => e.kind), ['turn-done']);

  crew.state = 'working';
  crew.turnStartedAt = 2000;
  await fleet.tick();
  crew.state = 'waiting';
  crew.stateDetail = 'Claude needs your permission to use Bash';
  await fleet.tick();
  assert.equal(fleet.get(t.id).phase, 'needs-you');
  assert.deepEqual(fleet.events.map((e) => e.kind), ['turn-done', 'needs-input']);

  // No skipper yet: the events wait. Once it is idle they are typed in, but
  // not while the captain has just been typing there.
  const sk = m.create({ cwd: dir, role: 'skipper' });
  sessionOf(m, sk.id).state = 'idle';
  fleet.events.at(-1).at -= 10e3;
  m.lastInput.set(sk.id, Date.now());
  await fleet.tick();
  assert.equal(m.typed.length, 1);
  m.lastInput.set(sk.id, Date.now() - 60e3);
  await fleet.tick();
  assert.equal(m.typed.length, 2);
  assert.equal(m.typed[1].id, sk.id);
  assert.match(m.typed[1].text, /^\[cc-dash\] 2 events from the fleet:\n- \[fix-login-\w+\] Fix login: Finished its turn\.\n- \[fix-login-\w+\] Fix login: Is waiting: Claude needs your permission/);
  assert.deepEqual(fleet.takeEvents(), []); // delivered

  // State survives a restart.
  const again = new Fleet(m, { token: 't', pickProfile });
  assert.equal(again.get(t.id).title, 'Fix login');
  const done = await again.finish(t.id);
  assert.equal(done.task.phase, 'closed');
  assert.ok(!m.managed.has(t.managedId));
});

test('worktrees go under .claude/worktrees and are kept out of git status', async () => {
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' }).toString().trim();
  g('init', '-q', '-b', 'main');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const w = await addWorktree(repo, { branch: 'task/fix-login' });
  assert.equal(fs.realpathSync.native(w.worktree), path.join(fs.realpathSync.native(repo), '.claude', 'worktrees', 'task-fix-login'));
  assert.equal(w.base, 'HEAD');
  assert.equal(execFileSync('git', ['-C', w.worktree, 'branch', '--show-current']).toString().trim(), 'task/fix-login');
  assert.equal(g('status', '--porcelain'), '');
  await assert.rejects(addWorktree(repo, { branch: 'task/fix-login' }), /already exists/);
});

test('tailMessages: prompts, replies and one line per tool call', () => {
  const file = path.join(dir, 's.jsonl');
  const lines = [
    { type: 'user', message: { content: 'Fix the login bug' } },
    { type: 'user', isMeta: true, message: { content: 'meta' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'DONE: https://github.com/a/b/pull/1' }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.deepEqual(
    tailMessages(file, { last: 10 }).map((m) => [m.role, m.text]),
    [
      ['user', 'Fix the login bug'],
      ['claude', 'On it.'],
      ['tool', 'Bash: npm test'],
      ['claude', 'DONE: https://github.com/a/b/pull/1'],
    ],
  );
  assert.equal(tailMessages(file, { last: 1 }).length, 1);
});

test('mcp: auth, initialize, notifications, tools', async () => {
  const m = fakeManager();
  const fleet = new Fleet(m, { token: 't', pickProfile });
  const mcp = createMcp({ manager: m, fleet, tokenOk: (t) => t === 'secret' });
  const req = (auth = 'Bearer secret') => ({ method: 'POST', headers: { authorization: auth } });

  assert.equal((await mcp.handle(req('Bearer nope'), {}))[0], 401);
  const [, init] = await mcp.handle(req(), { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'cc-dash');
  assert.deepEqual(await mcp.handle(req(), { jsonrpc: '2.0', method: 'notifications/initialized' }), [202, null]);

  const [, list] = await mcp.handle(req(), { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(list.result.tools.some((t) => t.name === 'start_task'));

  const call = async (name, args) => (await mcp.handle(req(), { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }))[1].result;
  const crew = m.create({ cwd: dir });
  sessionOf(m, crew.id).state = 'waiting';
  const refused = await call('send_to_session', { session: crew.id, text: 'hi' });
  assert.ok(refused.isError);
  assert.match(refused.content[0].text, /waiting on a prompt/);
  sessionOf(m, crew.id).state = 'idle';
  assert.ok(!(await call('send_to_session', { session: crew.claudeSessionId.slice(0, 6), text: 'hi' })).isError);
  assert.deepEqual(m.typed.at(-1), { id: crew.id, text: 'hi' });

  const tracked = JSON.parse((await call('track_session', { session: crew.id, title: 'Adopted' })).content[0].text);
  assert.equal(tracked.title, 'Adopted');
  const tasks = JSON.parse((await call('list_tasks', {})).content[0].text);
  assert.ok(tasks.some((t) => t.id === tracked.id));
});

// Stands in for gh / az: the PRs of each branch (null: cannot tell), and of each URL.
function fakePrs() {
  const p = {
    byBranch: {},
    byUrl: {},
    looked: [],
    async find(dir, branch) {
      p.looked.push(branch);
      return p.byBranch[branch] === undefined ? [] : p.byBranch[branch];
    },
    info: async (url) => p.byUrl[url] || null,
  };
  return p;
}
const AZ = 'https://dev.azure.com/poweroffice/PowerOfficeGo/_git';
const OLD_PR = `${AZ}/PowerOfficeGo/pullrequest/54546`;
const HOUR = 3600e3;

// Adds a reply to a session's transcript.
function crewSays(key, text) {
  const project = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'p');
  fs.mkdirSync(project, { recursive: true });
  const line = { type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }] } };
  fs.appendFileSync(path.join(project, `${key}.jsonl`), JSON.stringify(line) + '\n');
  scanTranscripts({ force: true });
}

async function crewTask(fleet, m, branch) {
  const t = await fleet.startTask({ repo: dir, title: `Task ${branch}`, brief: 'b', worktree: false });
  Object.assign(fleet.get(t.id), { branch, brief: null, phase: 'working' });
  sessionOf(m, t.managedId).state = 'idle';
  return fleet.get(t.id);
}
const settle = (fleet) => Promise.all(fleet.checks.values());
const kinds = (fleet, t) => fleet.events.filter((e) => e.task === t.id).map((e) => e.kind);

test("a PR is the task's only when it is from the task's branch", async () => {
  const m = fakeManager();
  const prs = fakePrs();
  const fleet = new Fleet(m, { token: 't', pickProfile, prs });
  const t = await crewTask(fleet, m, 'anderbakk/99539-batch-overlapp');

  // The story the crew reads links an old PR from another branch and repo:
  // that only makes cc-dash look, and the branch has no PR.
  crewSays(t.sessionKey, `The story says: see ${OLD_PR} and PR 54546.`);
  await fleet.tick();
  await settle(fleet);
  assert.deepEqual(prs.looked, ['anderbakk/99539-batch-overlapp']);
  assert.equal(t.pr, null);
  assert.equal(t.phase, 'working');

  // A PR from the branch that was merged before the task began is not its.
  const old = { url: OLD_PR, state: 'merged', createdAt: t.createdAt - 72 * HOUR, closedAt: t.createdAt - HOUR };
  prs.byBranch[t.branch] = [old];
  await fleet.pollPrs();
  assert.equal(t.pr, null);
  assert.deepEqual(kinds(fleet, t), []);

  // The real one is found, with the URL of the repo it is in, and followed.
  const real = { url: `${AZ}/golog/pullrequest/54700`, state: 'open', createdAt: Date.now(), closedAt: null };
  prs.byBranch[t.branch] = [old, real];
  await fleet.pollPrs();
  assert.deepEqual(t.pr, { url: real.url, state: 'open', by: 'branch' });
  assert.equal(t.phase, 'pr-open');
  assert.deepEqual(kinds(fleet, t), ['pr-opened']);
  await fleet.pollPrs(); // nothing new
  assert.deepEqual(kinds(fleet, t), ['pr-opened']);
  prs.byBranch[t.branch] = [old, { ...real, state: 'merged', closedAt: Date.now() }];
  await fleet.pollPrs();
  assert.equal(t.phase, 'merged');
  assert.deepEqual(kinds(fleet, t), ['pr-opened', 'pr-merged']);

  // Merged is done with: no more lookups.
  const n = prs.looked.length;
  await fleet.pollPrs();
  assert.equal(prs.looked.length, n);

  // Without gh / az nothing changes.
  const u = await crewTask(fleet, m, 'task/no-cli');
  prs.byBranch[u.branch] = null;
  Object.assign(u, { pr: { url: real.url, state: 'open', by: 'branch' }, phase: 'pr-open' });
  await fleet.pollPrs();
  assert.equal(u.pr.url, real.url);
  assert.deepEqual(kinds(fleet, u), []);
});

test('a PR taken from a link earlier is dropped, and the real one is still found', async () => {
  const m = fakeManager();
  const prs = fakePrs();
  const fleet = new Fleet(m, { token: 't', pickProfile, prs });
  // As fleet.json had it: a PR from a link, with the wrong repo, merged.
  const t = await crewTask(fleet, m, 'anderbakk/99539-write-grense');
  Object.assign(t, { pr: { url: `${AZ}/golog/pullrequest/54546`, state: 'merged' }, phase: 'merged' });
  await fleet.pollPrs();
  assert.equal(t.pr, null);
  assert.equal(t.phase, 'working');
  assert.deepEqual(kinds(fleet, t), ['pr-dropped']);

  const real = { url: `${AZ}/PowerOfficeGo/pullrequest/54800`, state: 'open', createdAt: Date.now(), closedAt: null };
  prs.byBranch[t.branch] = [real];
  await fleet.pollPrs();
  assert.equal(t.pr.url, real.url);
  assert.equal(t.phase, 'pr-open');
  assert.deepEqual(kinds(fleet, t), ['pr-dropped', 'pr-opened']);
});

test('a PR the skipper clears or sets is not changed by the lookup', async () => {
  const m = fakeManager();
  const prs = fakePrs();
  const fleet = new Fleet(m, { token: 't', pickProfile, prs });
  const t = await crewTask(fleet, m, 'task/cleared');
  const wrong = { url: `${AZ}/golog/pullrequest/1`, state: 'open', createdAt: Date.now(), closedAt: null };
  prs.byBranch[t.branch] = [wrong];
  await fleet.pollPrs();
  assert.equal(t.pr.url, wrong.url);

  // Cleared: it does not come back, from the branch or from a link.
  fleet.update(t.id, { pr: '', phase: 'working' });
  crewSays(t.sessionKey, `Back to ${wrong.url}`);
  await fleet.tick();
  await settle(fleet);
  await fleet.pollPrs();
  assert.equal(t.pr, null);
  assert.equal(t.phase, 'working');

  // But the next PR from the branch is found.
  const next = { ...wrong, url: `${AZ}/golog/pullrequest/2` };
  prs.byBranch[t.branch] = [wrong, next];
  await fleet.pollPrs();
  assert.equal(t.pr.url, next.url);

  // Set by hand: kept, and only its state is followed. One that was merged
  // before the task began tells nothing.
  const u = await crewTask(fleet, m, 'task/by-hand');
  const mine = `${AZ}/golog/pullrequest/3`;
  prs.byBranch[u.branch] = [next];
  prs.byUrl[mine] = { url: mine, state: 'merged', createdAt: u.createdAt - 48 * HOUR, closedAt: u.createdAt - HOUR };
  fleet.update(u.id, { pr: mine, phase: 'pr-open' });
  await fleet.pollPrs();
  assert.deepEqual(u.pr, { url: mine, state: 'merged', manual: true });
  assert.equal(u.phase, 'pr-open');
  assert.deepEqual(kinds(fleet, u), []);
});

test('pickPr: open first, then the newest; not one done with before the task', () => {
  const t = { createdAt: 1000, prDropped: ['d'] };
  const pr = (url, state, createdAt, closedAt = null) => ({ url, state, createdAt, closedAt });
  assert.equal(pickPr([pr('a', 'closed', 1100, 1200), pr('b', 'open', 1050)], t).url, 'b');
  assert.equal(pickPr([pr('a', 'closed', 1100, 1200), pr('c', 'merged', 1300, 1400)], t).url, 'c');
  assert.equal(pickPr([pr('old', 'merged', 500, 900), pr('d', 'open', 1100)], t), null);
  assert.equal(pickPr([pr('kept', 'open', 500)], t).url, 'kept'); // tracked with its PR open
});
