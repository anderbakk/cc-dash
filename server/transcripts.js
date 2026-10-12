// Reads Claude Code transcripts (~/.claude/projects/<dir>/<session-id>.jsonl)
// incrementally: each file is parsed once and afterwards only appended bytes
// are read, so polling stays cheap even with hundreds of sessions.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from './paths.js';
import { addTargets, mergeTouched, newTouched, toolTargets } from './folders.js';
import { costFor } from './pricing.js';
import { extractRefs, newRefs } from './refs.js';

const RECENT_DAYS = Number(process.env.CC_DASH_RECENT_DAYS || 14);
const CHUNK = 1 << 20;

const cache = new Map(); // file path -> entry
let lastScan = 0;

function emptyUsage() {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

function newEntry(file, parent = null) {
  return {
    file,
    parent, // set for subagent transcripts: only their usage is counted, on the parent

    size: 0,
    mtimeMs: 0,
    partial: '',
    msgIds: new Set(),
    toolNames: new Map(), // tool_use id -> tool name, to know which results are Bash output
    refs: parent ? null : newRefs(),
    touched: newTouched(), // folders used by tool calls, see folders.js
    data: {
      sessionId: path.basename(file, '.jsonl'),
      cwd: null,
      gitBranch: null,
      customTitle: null,
      agentName: null,
      aiTitle: null,
      firstPrompt: null,
      lastPrompt: null,
      model: null,
      startedAt: null,
      lastAt: null,
      usage: {}, // model -> usage
      costState: null,
    },
  };
}

function promptText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.find((c) => c && c.type === 'text');
    return t ? t.text : null;
  }
  return null;
}

function clip(s, n = 200) {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function texts(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text);
}

// Collects links, PRs and commits (see refs.js). Only what you or Claude wrote
// and command output; file contents and search results would drown it.
function collectRefs(entry, o, at) {
  const content = o.message?.content;
  if (o.type === 'assistant') {
    for (const t of texts(content)) extractRefs(entry.refs, t, 'claude', at);
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (c?.type !== 'tool_use') continue;
      entry.toolNames.set(c.id, c.name);
      if (c.name === 'WebFetch' && typeof c.input?.url === 'string') extractRefs(entry.refs, c.input.url, 'claude', at);
    }
  } else if (o.type === 'user' && !o.isMeta) {
    for (const t of texts(content)) extractRefs(entry.refs, t, 'user', at);
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (c?.type !== 'tool_result') continue;
      const name = entry.toolNames.get(c.tool_use_id);
      entry.toolNames.delete(c.tool_use_id);
      if (name !== 'Bash') continue;
      const out = typeof c.content === 'string' ? [c.content] : texts(c.content);
      for (const t of out) extractRefs(entry.refs, t, 'command', at);
    }
  }
}

function applyLine(entry, line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  const d = entry.data;
  if (entry.parent && o.type !== 'assistant') return;
  // The first cwd is where the session was started. Later lines follow the
  // shell into whatever folder Claude cd'ed to.
  if (o.cwd && !d.cwd) d.cwd = o.cwd;
  if (o.gitBranch) d.gitBranch = o.gitBranch;
  if (o.timestamp) {
    const t = Date.parse(o.timestamp);
    if (!Number.isNaN(t)) {
      if (!d.startedAt || t < d.startedAt) d.startedAt = t;
      if (!d.lastAt || t > d.lastAt) d.lastAt = t;
    }
  }
  const at = o.timestamp ? Date.parse(o.timestamp) || null : null;
  if (entry.refs) collectRefs(entry, o, at);
  if (o.type === 'assistant') addTargets(entry.touched, toolTargets(o.message?.content, o.cwd || d.cwd), at);
  switch (o.type) {
    case 'user': {
      if (o.isMeta || o.isSidechain || d.firstPrompt) break;
      const text = promptText(o.message?.content);
      // Skip slash-command wrappers and other injected markup.
      if (text && !text.startsWith('<')) d.firstPrompt = clip(text);
      break;
    }
    case 'last-prompt':
      if (o.lastPrompt) d.lastPrompt = clip(o.lastPrompt);
      break;
    case 'ai-title':
      if (o.aiTitle) d.aiTitle = o.aiTitle;
      break;
    case 'custom-title':
      if (o.customTitle) d.customTitle = o.customTitle;
      break;
    case 'agent-name':
      if (o.agentName) d.agentName = o.agentName;
      break;
    case 'cost-state':
      d.costState = { totalCostUSD: o.totalCostUSD, linesAdded: o.totalLinesAdded, linesRemoved: o.totalLinesRemoved };
      break;
    case 'assistant': {
      const m = o.message;
      if (!m || !m.usage || !m.model || m.model.startsWith('<')) break;
      // One API response is split into one transcript entry per content
      // block, each repeating the same usage. Count each message id once.
      if (m.id) {
        if (entry.msgIds.has(m.id)) break;
        entry.msgIds.add(m.id);
      }
      d.model = m.model;
      const u = (d.usage[m.model] ||= emptyUsage());
      const cw = m.usage.cache_creation;
      u.input += m.usage.input_tokens || 0;
      u.output += m.usage.output_tokens || 0;
      u.cacheRead += m.usage.cache_read_input_tokens || 0;
      if (cw && (cw.ephemeral_1h_input_tokens || cw.ephemeral_5m_input_tokens)) {
        u.cacheWrite1h += cw.ephemeral_1h_input_tokens || 0;
        u.cacheWrite5m += cw.ephemeral_5m_input_tokens || 0;
      } else {
        u.cacheWrite5m += m.usage.cache_creation_input_tokens || 0;
      }
      break;
    }
  }
}

function readAppended(entry, size) {
  if (size < entry.size) {
    // File was truncated or replaced: start over.
    Object.assign(entry, newEntry(entry.file, entry.parent));
  }
  const fd = fs.openSync(entry.file, 'r');
  try {
    let pos = entry.size;
    const buf = Buffer.alloc(CHUNK);
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const text = entry.partial + buf.toString('utf8', 0, n);
      const lines = text.split('\n');
      entry.partial = lines.pop();
      for (const line of lines) if (line) applyLine(entry, line);
    }
    entry.size = pos;
  } finally {
    fs.closeSync(fd);
  }
}

function track(file, parent, cutoff, seen) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return false;
  }
  if (st.mtimeMs < cutoff) return false;
  seen.add(file);
  let entry = cache.get(file);
  if (!entry) cache.set(file, (entry = newEntry(file, parent)));
  if (st.size !== entry.size || st.mtimeMs !== entry.mtimeMs) {
    try {
      readAppended(entry, st.size);
    } catch {
      return true;
    }
    entry.mtimeMs = st.mtimeMs;
  }
  return true;
}

export function scanTranscripts({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastScan < 1000) return;
  lastScan = now;
  const cutoff = now - RECENT_DAYS * 864e5;
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return;
  }
  const seen = new Set();
  for (const dir of dirs) {
    const full = path.join(PROJECTS_DIR, dir.name);
    let files;
    try {
      files = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(full, f);
      if (!track(file, null, cutoff, seen)) continue;
      // Subagents write their own transcripts next to the parent session.
      const subDir = path.join(full, path.basename(f, '.jsonl'), 'subagents');
      let subs = [];
      try {
        subs = fs.readdirSync(subDir).filter((s) => s.endsWith('.jsonl'));
      } catch {}
      for (const s of subs) track(path.join(subDir, s), path.basename(f, '.jsonl'), cutoff, seen);
    }
  }
  for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);
}

export function summarize(d, extraUsage = []) {
  let cost = 0;
  let unknown = false;
  let tokens = 0;
  for (const [model, u] of [...Object.entries(d.usage), ...extraUsage]) {
    const c = costFor(model, u);
    if (c == null) unknown = true;
    else cost += c;
    tokens += u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
  }
  return {
    sessionId: d.sessionId,
    cwd: d.cwd,
    gitBranch: d.gitBranch,
    title: d.customTitle || d.agentName || d.aiTitle || d.firstPrompt || null,
    firstPrompt: d.firstPrompt,
    lastPrompt: d.lastPrompt,
    model: d.model,
    startedAt: d.startedAt,
    lastAt: d.lastAt,
    costUsd: cost,
    costIncomplete: unknown,
    tokens,
    linesAdded: d.costState?.linesAdded ?? null,
    linesRemoved: d.costState?.linesRemoved ?? null,
  };
}

export function allTranscripts() {
  scanTranscripts();
  const subUsage = new Map(); // parent session id -> [[model, usage], ...]
  for (const e of cache.values()) {
    if (!e.parent) continue;
    if (!subUsage.has(e.parent)) subUsage.set(e.parent, []);
    subUsage.get(e.parent).push(...Object.entries(e.data.usage));
  }
  const out = new Map();
  for (const e of cache.values()) {
    if (e.parent) continue;
    out.set(e.data.sessionId, summarize(e.data, subUsage.get(e.data.sessionId)));
  }
  return out;
}

// Links, PRs and commits mentioned in one session (not resolved, see refs.js).
export function refsFor(sessionId) {
  scanTranscripts();
  for (const e of cache.values()) if (!e.parent && e.data.sessionId === sessionId) return e.refs;
  return null;
}

// Folders the session and its subagents used (not resolved, see folders.js).
export function touchedFor(sessionId) {
  scanTranscripts();
  const list = [];
  for (const e of cache.values()) {
    if (e.parent ? e.parent === sessionId : e.data.sessionId === sessionId) list.push(e.touched);
  }
  return list.length ? mergeTouched(list) : null;
}

// For tests: parse one file from scratch, including the raw cost-state.
export function parseFile(file) {
  const e = newEntry(file);
  readAppended(e, fs.statSync(file).size);
  return e.data;
}
