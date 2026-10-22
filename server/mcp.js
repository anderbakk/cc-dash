// MCP server for the skipper, at POST /mcp (Streamable HTTP, answered with
// plain JSON: no streams, no server-side sessions). Small enough not to need
// the SDK. Authenticated with the cc-dash token as a Bearer header; the
// skipper gets it through the --mcp-config file cc-dash writes for it.
import fs from 'node:fs';
import { repoFor, resolveRefs } from './refs.js';
import { recentMessages, refsFor } from './transcripts.js';
import { PHASES } from './fleet.js';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const str = (description) => ({ type: 'string', description });
const bool = (description) => ({ type: 'boolean', description });

export const TOOLS = [
  {
    name: 'list_sessions',
    description:
      'All Claude sessions on this machine that are open now (in cc-dash or in another terminal), with state (working / waiting / idle), folder, branch, cost, the task they belong to and the PRs and work items they mention. Set recent to also get sessions that are no longer open.',
    inputSchema: { type: 'object', properties: { recent: bool('Also list recent sessions that are not open (default false)') } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_session',
    description: 'The last messages of a session: what the user and Claude wrote, and one line per tool call. Use it to find out what a crew session did or is asking.',
    inputSchema: {
      type: 'object',
      properties: {
        session: str('Session key (or its first characters), managed id, or task id'),
        last: { type: 'integer', description: 'How many messages (default 12, max 60)' },
      },
      required: ['session'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'send_to_session',
    description:
      'Types a message into a session that runs in cc-dash and submits it, as if the captain typed it. Not possible while the session waits on a permission or other prompt: that is for the captain to answer.',
    inputSchema: {
      type: 'object',
      properties: { session: str('Session key, managed id, or task id'), text: str('The message') },
      required: ['session', 'text'],
    },
  },
  {
    name: 'list_tasks',
    description: 'The fleet: every task with its story, repo, worktree, branch, phase, PR and crew session state.',
    inputSchema: { type: 'object', properties: { closed: bool('Include closed tasks (default false)') } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'start_task',
    description:
      'Starts a crew session for a task: creates a git worktree and branch in the repo (in <repo>/.claude/worktrees/), starts Claude there and gives it the brief as its first message. Returns the task.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: str('Path to the git repo (any folder inside it)'),
        title: str('Short title, also the session name'),
        brief: str('The first message to the crew session: what to do, what done means, and how to report back'),
        story: str('The user story / issue / work item, as a URL or e.g. "AB#1234" or "owner/repo#12"'),
        branch: str('Branch to create (default task/<title>). Follow the repo\'s naming convention if it has one'),
        base: str('What to branch from (default origin/HEAD, else HEAD)'),
        worktree: bool('Create a worktree (default true). false starts the session in the repo folder itself'),
        profile: str('cc-dash profile to start Claude with (default: the first Claude profile)'),
      },
      required: ['repo', 'title', 'brief'],
    },
  },
  {
    name: 'track_session',
    description: 'Makes an existing session part of the fleet as a task, so its events are reported.',
    inputSchema: {
      type: 'object',
      properties: { session: str('Session key, its first characters, or managed id'), title: str('Task title (default: the session title)'), story: str('The user story, if known') },
      required: ['session'],
    },
  },
  {
    name: 'update_task',
    description: `Changes a task: its phase (${PHASES.join(', ')}), story, PR URL, title, or adds a note.`,
    inputSchema: {
      type: 'object',
      properties: {
        task: str('Task id'),
        phase: { type: 'string', enum: PHASES },
        story: str('User story reference'),
        pr: str('Pull request URL'),
        title: str('New title'),
        note: str('A note to keep with the task (decisions, what is left)'),
      },
      required: ['task'],
    },
  },
  {
    name: 'finish_task',
    description:
      'Closes a task: ends its crew session and removes its worktree. Fails if the worktree has changes that are not committed. Only do this when the work is merged or the captain says so.',
    inputSchema: {
      type: 'object',
      properties: {
        task: str('Task id'),
        remove_worktree: bool('Remove the worktree (default true)'),
        delete_branch: bool('Also delete the local branch (default false)'),
      },
      required: ['task'],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'fleet_events',
    description: 'Events cc-dash has noticed and not yet told you about (they are normally typed into your terminal when you are idle).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
];

export function createMcp({ manager, fleet, tokenOk }) {
  // A session by key, the start of a key, managed id or task id.
  function findSession(ref) {
    if (typeof ref !== 'string' || !ref) throw new Error('session is required');
    const list = manager.list();
    const task = fleet.get(ref);
    const key = task ? task.sessionKey : ref;
    const s = list.find((x) => x.key === key || x.managedId === key) || (key.length >= 4 && list.find((x) => x.key.startsWith(key)));
    if (!s) throw new Error(`No session "${ref}"`);
    return s;
  }

  async function prsOf(s) {
    const refs = refsFor(s.key);
    if (!refs) return [];
    return resolveRefs(refs, await repoFor(s.cwd))
      .filter((r) => (r.kind === 'pr' || r.kind === 'workitem' || r.kind === 'issue') && r.url)
      .slice(0, 6)
      .map((r) => ({ kind: r.kind, label: r.label, url: r.url }));
  }

  const tools = {
    async list_sessions({ recent = false }) {
      const byKey = new Map(fleet.list().map((t) => [t.sessionKey, t.id]));
      const list = manager.list().filter((s) => !s.shell && s.role !== 'skipper' && (recent || s.running || s.external));
      return Promise.all(
        list.slice(0, 60).map(async (s) => ({
          key: s.key,
          managedId: s.managedId,
          task: byKey.get(s.key) || null,
          title: s.title,
          where: s.running ? 'cc-dash' : s.external ? 'other terminal' : 'not open',
          state: s.state,
          detail: s.stateDetail,
          cwd: s.cwd,
          branch: s.gitBranch,
          costUsd: Math.round(s.costUsd * 100) / 100,
          lastPrompt: s.lastPrompt,
          lastAt: s.lastAt && new Date(s.lastAt).toISOString(),
          refs: await prsOf(s),
        })),
      );
    },
    read_session({ session, last = 12 }) {
      const s = findSession(session);
      const n = Math.min(Math.max(Number(last) || 12, 1), 60);
      return { key: s.key, title: s.title, state: s.state, detail: s.stateDetail, messages: recentMessages(s.key, { last: n }) || [] };
    },
    send_to_session({ session, text }) {
      if (typeof text !== 'string' || !text.trim()) throw new Error('text is required');
      const s = findSession(session);
      if (s.role === 'skipper') throw new Error('That is you');
      if (!s.running) throw new Error('The session is not running in cc-dash, so it cannot be typed into. Ask the captain, or continue it from cc-dash first.');
      if (s.state === 'waiting') throw new Error(`The session is waiting on a prompt (${s.stateDetail || 'permission'}). The captain has to answer that in cc-dash.`);
      if (!manager.type(s.managedId, text)) throw new Error('Could not type into the session');
      return { ok: true, note: s.state === 'working' ? 'It was working: the message is queued until its turn ends.' : undefined };
    },
    list_tasks({ closed = false }) {
      return fleet.list({ includeClosed: closed });
    },
    start_task(a) {
      return fleet.startTask({ repo: a.repo, title: a.title, brief: a.brief, story: a.story, branch: a.branch, base: a.base, worktree: a.worktree !== false, profile: a.profile });
    },
    track_session({ session, title, story }) {
      return fleet.track({ session, title, story });
    },
    update_task({ task, ...rest }) {
      return fleet.update(task, rest);
    },
    finish_task({ task, remove_worktree = true, delete_branch = false }) {
      return fleet.finish(task, { removeWorktree: remove_worktree, deleteBranch: delete_branch });
    },
    fleet_events() {
      return fleet.takeEvents();
    },
  };

  async function call(msg) {
    const { id, method, params = {} } = msg;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'cc-dash', version: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version },
          instructions: 'cc-dash runs the Claude sessions on this machine. You are the skipper: use these tools to see, start, message and close crew sessions and their tasks.',
        });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'tools/call': {
        const fn = tools[params.name];
        if (!fn) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params.name}` } };
        try {
          const out = await fn(params.arguments || {});
          return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] });
        } catch (e) {
          return ok({ content: [{ type: 'text', text: e.message }], isError: true });
        }
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  }

  // Returns [status, body | null].
  async function handle(req, body) {
    const auth = req.headers.authorization || '';
    if (!tokenOk(auth.replace(/^Bearer\s+/i, ''))) return [401, { error: 'Not logged in' }];
    if (req.method !== 'POST') return [405, { error: 'Only POST' }];
    const batch = Array.isArray(body);
    const msgs = batch ? body : [body];
    const replies = [];
    for (const m of msgs) {
      if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
        replies.push({ jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid request' } });
      } else if (m.id === undefined || m.id === null) {
        // A notification (e.g. notifications/initialized): nothing to answer.
      } else replies.push(await call(m));
    }
    if (!replies.length) return [202, null];
    return [200, batch ? replies : replies[0]];
  }

  return { handle };
}
