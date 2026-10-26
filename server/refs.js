// Pulls the small details that are hard to find again in a long session out
// of the transcript: links, pull requests, issues/work items and commits.
// Understands GitHub and Azure DevOps (dev.azure.com and *.visualstudio.com).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_REFS = 500; // per session; the least recently mentioned are dropped

const URL_RE = /https?:\/\/[^\s<>"'`\]}|\\]+/g;
const MD_LINK_RE = /\[([^\]\n]{1,120})\]\((https?:\/\/[^\s)]+)\)/g;
const COMMIT_RE = /^\[([^\]\s]+) (?:\(root-commit\) )?([0-9a-f]{7,40})\] (.+)$/gm;

// Mentions without a URL; the repo is filled in later from the git remote.
const TEXT_RES = [
  [/\b(PR|pull request|issue|work ?item|WI)\s*#?(\d{1,6})\b/gi, (m) => KIND_WORDS[m[1].toLowerCase().replace(' ', '')] || 'pr'],
  [/\bAB#(\d{1,7})\b/g, () => 'workitem'], // Azure Boards mention
  [/(?<![\w!])!(\d{1,6})\b/g, () => 'pr'], // Azure DevOps PR mention
  [/"pullRequestId":\s*(\d+)/g, () => 'pr'], // az repos pr create/show
];
const KIND_WORDS = { pr: 'pr', pullrequest: 'pr', issue: 'issue', workitem: 'workitem', wi: 'workitem' };

export function newRefs() {
  return new Map(); // key -> { kind, key, url, num, repo, hash, label, context, source, firstAt, lastAt, count }
}

function add(refs, ref, at) {
  const prev = refs.get(ref.key);
  if (prev) {
    refs.delete(ref.key); // re-insert so the map stays ordered by last mention
    prev.lastAt = at || prev.lastAt;
    prev.count++;
    for (const f of ['url', 'label', 'branch', 'repo']) if (!prev[f] && ref[f]) prev[f] = ref[f];
    refs.set(ref.key, prev);
    return;
  }
  refs.set(ref.key, { ...ref, firstAt: at, lastAt: at, count: 1 });
  if (refs.size > MAX_REFS) refs.delete(refs.keys().next().value);
}

// The line around a match, so you can tell what it was about.
function contextAt(text, index, len) {
  const start = text.lastIndexOf('\n', index) + 1;
  let end = text.indexOf('\n', index + len);
  if (end < 0) end = text.length;
  let line = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (line.length > 160) {
    const at = Math.max(0, index - start - 60);
    line = (at > 0 ? '…' : '') + line.slice(at, at + 160) + '…';
  }
  return line;
}

function cleanUrl(u) {
  u = u.replace(/[.,;:!?*_~'"…]+$/, '');
  // Drop a trailing ")" unless the URL itself opened one (Wikipedia-style).
  while (u.endsWith(')') && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) u = u.slice(0, -1);
  return u;
}

const dec = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// ---- repositories ----------------------------------------------------------
// A repo is { host, id, name, web, boards }: id is the stable key used to merge
// mentions, web the repo's browser URL, boards where work items live (Azure).
// Azure repos also keep org and projectName, for `az --org --project`.

function githubRepo(owner, name) {
  return { host: 'github', id: `github:${owner}/${name}`.toLowerCase(), name: `${owner}/${name}`, web: `https://github.com/${owner}/${name}` };
}

function azureRepo(org, project, name) {
  [org, project, name] = [org, project, name].map(dec);
  const base = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}`;
  return {
    host: 'azure',
    id: `azure:${org}/${project}/${name}`.toLowerCase(),
    project: `azure:${org}/${project}`.toLowerCase(),
    name,
    org,
    projectName: project,
    web: `${base}/_git/${encodeURIComponent(name)}`,
    boards: `${base}/_workitems/edit/`,
  };
}

// dev.azure.com/org/project/... or org.visualstudio.com[/DefaultCollection]/project/...
const AZURE_RE = /^https?:\/\/(?:dev\.azure\.com\/([^/?#]+)|([\w-]+)\.visualstudio\.com(?:\/DefaultCollection)?)\/([^/?#]+)\/(.*)$/i;

// Classifies a URL as a PR, issue, work item or commit, or returns null.
function parseUrl(url) {
  let m = url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues|commit)\/(\w+)/);
  if (m) {
    const repo = githubRepo(m[1], m[2]);
    if (m[3] === 'commit') return /^[0-9a-f]{7,40}$/.test(m[4]) ? { kind: 'commit', hash: m[4].slice(0, 7), repo } : null;
    return /^\d+$/.test(m[4]) ? { kind: m[3] === 'pull' ? 'pr' : 'issue', num: Number(m[4]), repo } : null;
  }
  m = url.match(AZURE_RE);
  if (!m) return null;
  const [, org1, org2, project, rest] = m;
  const org = org1 || org2;
  let r;
  if ((r = rest.match(/^_git\/([^/?#]+)\/pullrequest\/(\d+)/i))) return { kind: 'pr', num: Number(r[2]), repo: azureRepo(org, project, r[1]) };
  if ((r = rest.match(/^_git\/([^/?#]+)\/commit\/([0-9a-f]{7,40})/i))) return { kind: 'commit', hash: r[2].slice(0, 7).toLowerCase(), repo: azureRepo(org, project, r[1]) };
  if ((r = rest.match(/^_workitems\/edit\/(\d+)/i))) return { kind: 'workitem', num: Number(r[1]), repo: azureRepo(org, project, '') };
  // REST API URLs (az CLI output) use GUIDs for the repo: keep just the number.
  if ((r = rest.match(/^_apis\/git\/repositories\/[^/]+\/pullRequests\/(\d+)/i))) return { kind: 'pr', num: Number(r[1]), repo: null };
  if ((r = rest.match(/^_apis\/wit\/workItems\/(\d+)/i))) return { kind: 'workitem', num: Number(r[1]), repo: null };
  return null;
}

// Parses `git remote get-url origin` output.
export function parseRemote(url) {
  url = url.trim();
  let m = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (m) return githubRepo(m[1], m[2]);
  m = url.match(/(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/);
  if (m) return azureRepo(m[1], m[2], m[3]);
  m = url.replace(/^(https?:\/\/)[^/@]+@/, '$1').match(AZURE_RE);
  const r = m && m[4].match(/^_git\/([^/?#]+?)\/?$/);
  if (r) return azureRepo(m[1] || m[2], m[3], r[1]);
  return null;
}

// Where the stable key of a numbered ref comes from: work items belong to an
// Azure project, everything else to a repo.
const scopeOf = (kind, repo) => (kind === 'workitem' ? repo.project : repo.id);

function keyOf(kind, num, repo) {
  return `${kind}:${repo ? scopeOf(kind, repo) : ''}#${num}`;
}

// ---- extraction ------------------------------------------------------------

// source: 'user' | 'claude' | 'command'
export function extractRefs(refs, text, source, at) {
  if (!text || typeof text !== 'string') return;
  text = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''); // terminal colors in command output
  if (text.length > 200_000) text = text.slice(0, 200_000);

  const titles = new Map();
  for (const m of text.matchAll(MD_LINK_RE)) titles.set(cleanUrl(m[2]), m[1].trim());

  for (const m of text.matchAll(URL_RE)) {
    // Drop "user@" (git remotes) and skip template placeholders like https://${host}.
    const url = cleanUrl(m[0]).replace(/^(https?:\/\/)[^/@\s]+@/, '$1');
    if (url.length < 12 || !/^https?:\/\/[\w[]/.test(url) || url.includes('${')) continue;
    const context = contextAt(text, m.index, m[0].length);
    const p = parseUrl(url);
    // API URLs are not for browsers; the resolved repo link replaces them.
    const webUrl = p && !p.repo ? null : url;
    if (p?.kind === 'commit') {
      add(refs, { kind: 'commit', key: `commit:${p.hash}`, url: webUrl, hash: p.hash, repo: p.repo, label: null, context, source }, at);
    } else if (p) {
      add(refs, { kind: p.kind, key: keyOf(p.kind, p.num, p.repo), url: webUrl, num: p.num, repo: p.repo, label: titles.get(url) || null, context, source }, at);
    } else {
      add(refs, { kind: 'url', key: `url:${url}`, url, label: titles.get(url) || null, context, source }, at);
    }
  }

  for (const [re, kindOf] of TEXT_RES) {
    for (const m of text.matchAll(re)) {
      const kind = kindOf(m);
      const num = Number(m[m.length - 1]);
      add(refs, { kind, key: keyOf(kind, num, null), url: null, num, repo: null, label: null, context: contextAt(text, m.index, m[0].length), source }, at);
    }
  }

  // `git commit` output: "[main a6e94ae] Message".
  if (source === 'command') {
    for (const m of text.matchAll(COMMIT_RE)) {
      const hash = m[2].slice(0, 7);
      add(refs, { kind: 'commit', key: `commit:${hash}`, url: null, hash, branch: m[1], repo: null, label: m[3].trim(), context: null, source }, at);
    }
  }
}

// ---- resolving against the session's own repo ------------------------------

const remotes = new Map(); // cwd -> Promise<repo | null>

export function repoFor(cwd) {
  if (!cwd) return Promise.resolve(null);
  if (!remotes.has(cwd)) {
    const p = run('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { windowsHide: true })
      .then(({ stdout }) => parseRemote(stdout))
      .catch(() => null);
    remotes.set(cwd, p);
    setTimeout(() => remotes.delete(cwd), 60_000); // remotes can change
  }
  return remotes.get(cwd);
}

function webUrl(kind, num, repo) {
  if (repo.host === 'github') return `${repo.web}/${kind === 'pr' ? 'pull' : 'issues'}/${num}`;
  if (kind === 'pr') return `${repo.web}/pullrequest/${num}`;
  return `${repo.boards}${num}`;
}

function refName(r) {
  if (r.kind === 'workitem') return `#${r.num}`;
  if (!r.repo) return `#${r.num}`;
  if (r.repo.host === 'azure') return `${r.repo.name} !${r.num}`;
  return `${r.repo.name}#${r.num}`;
}

// Newest first. Bare mentions ("PR #12", "!12", "AB#34") are tied to the
// session's repo so they merge with full links to the same thing.
export function resolveRefs(refs, repo) {
  const out = new Map();
  for (const r of refs.values()) {
    const ref = { ...r };
    if (ref.num != null && !ref.repo && repo) {
      // GitHub has no work items and Azure DevOps no issues: map one onto the other.
      if (repo.host === 'azure' && ref.kind === 'issue') ref.kind = 'workitem';
      if (repo.host === 'github' && ref.kind === 'workitem') ref.kind = 'issue';
      ref.repo = repo;
      ref.key = keyOf(ref.kind, ref.num, repo);
    }
    if (ref.num != null && ref.repo && !ref.url) ref.url = webUrl(ref.kind, ref.num, ref.repo);
    if (ref.kind === 'commit' && !ref.url && (ref.repo || repo)) ref.url = `${(ref.repo || repo).web}/commit/${ref.hash}`;
    if (ref.num != null) {
      ref.title = ref.label; // a Markdown link text, if any
      ref.label = refName(ref);
    }
    const prev = out.get(ref.key);
    if (prev) {
      prev.count += ref.count;
      prev.url ||= ref.url;
      prev.title ||= ref.title;
      if (ref.kind === 'commit') prev.label ||= ref.label;
      if ((ref.lastAt || 0) > (prev.lastAt || 0)) Object.assign(prev, { lastAt: ref.lastAt, context: ref.context || prev.context, source: ref.source });
    } else out.set(ref.key, ref);
  }
  return [...out.values()]
    .map(({ repo: rp, ...rest }) => ({ ...rest, repo: rp?.name || null, host: rp?.host || null }))
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}
