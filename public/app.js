import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links.mjs';
import { SearchAddon } from '/vendor/addon-search.mjs';
import { Unicode11Addon } from '/vendor/addon-unicode11.mjs';
import { marked } from '/vendor/marked.esm.js';
import { t as tr, setLang, getLang, locale } from '/i18n.js';

const $ = (sel) => document.querySelector(sel);
const POLL_MS = 2000;

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`cc-dash.${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`cc-dash.${k}`, JSON.stringify(v));
    } catch {}
  },
};

const state = {
  sessions: [],
  info: {},
  selected: store.get('selected', null),
  filter: '',
  groupBy: store.get('groupBy', 'folder'), // sidebar: 'folder' | 'status'
  collapsed: new Set(store.get('collapsed', [])), // folder groups folded away
  showAll: new Set(), // groups showing all their ended sessions, not just the newest
  oldOpen: store.get('oldOpen', false), // the sidebar's "Earlier" section is unfolded
  panelOpen: store.get('panelOpen', false),
  tab: store.get('tab', 'diff') === 'preview' ? 'files' : store.get('tab', 'diff'), // Preview is part of Files now
  roots: {}, // session key -> the folders it works in (cwd first), see folders.js
  filesRoot: {}, // session key -> root id shown under Files
  filesPath: {}, // `${session key}:${root id}` -> current dir
  filesQuery: {}, // `${session key}:${root id}` -> text searched for under Files
  openRoots: new Set(), // `${session key}:${root id}` of read-only folders expanded under Diff
  preview: null, // { key, root, path }
  previewMax: store.get('previewMax', false), // the preview fills the Files tab
  resumeProfile: {}, // session key -> profile id picked for "Continue here"
  refsFilter: '',
  terms: new Map(), // managedId -> { term, fit, ws, el, exited }
  lastDiffAt: 0,
  diffData: null, // { key, roots, diffs }: the last diff fetched, redrawn as comments change
  comments: store.get('diffComments', {}), // session key -> review comments on its diff
  draft: null, // the comment being written: { key, root, rootPath, file, from, to, code, text, id? }
};

// ---- helpers ---------------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function ago(t) {
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return tr('time.now');
  if (s < 3600) return tr('time.min', Math.floor(s / 60));
  if (s < 86400) return tr('time.hours', Math.floor(s / 3600));
  return tr('time.days', Math.floor(s / 86400));
}

function money(v, incomplete) {
  if (!v) return '';
  const s = v < 0.01 ? '<$0.01' : `$${v < 10 ? v.toFixed(2) : v.toFixed(1)}`;
  return incomplete ? `${s}+` : s;
}

function shortPath(p) {
  if (!p) return '';
  return p.replace(/^\/home\/[^/]+|^\/Users\/[^/]+|^[A-Za-z]:\\Users\\[^\\]+/, '~');
}

const profiles = () => state.info.profiles || [];

const profileOf = (s) => (s?.profileId && profiles().find((x) => x.id === s.profileId)) || null;

// The color of a session's profile tag, as a CSS value (see --tag-* in style.css).
function tagColor(s) {
  const p = profileOf(s);
  if (!p?.tag && !p?.color) return null;
  const c = p.color || 'gray';
  return c.startsWith('#') ? c : `var(--tag-${c})`;
}

// For an element that should carry the profile's color stripe.
const tagAttrs = (s) => (tagColor(s) ? ` tagged" style="--tag:${esc(tagColor(s))}` : '');

// Marks the profile's tag, plain terminals, and Claude sessions started with
// another profile than the default one.
function profileBadge(s) {
  const p = profileOf(s);
  let html = '';
  if (p?.tag) html += `<span class="profile tagged" style="--tag:${esc(tagColor(s))}" title="${esc(tr('profile.title', p.name))}">${esc(p.tag)}</span>`;
  else if (p && !s.shell && p !== profiles().find((x) => x.claude)) html += `<span class="profile">${esc(p.name)}</span>`;
  if (s.shell) html += '<span class="profile">terminal</span>';
  if (s.role === 'skipper') html += '<span class="profile skipper">skipper</span>';
  if (s.task) html += `<span class="profile phase-${esc(s.task.phase)}" title="${esc(tr('fleet.badgeTitle', s.task.id, s.task.phase))}">${esc(s.task.phase)}</span>`;
  return html;
}

// How long a session has been waiting for the user: 0:42, 12:05, 1 h 20 min.
const waited = (t) => span(Date.now() - t);

function span(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return tr('time.hoursMin', Math.floor(s / 3600), Math.floor((s % 3600) / 60));
}

// A permission prompt left this long gets louder.
const LONG_WAIT_MS = 2 * 60 * 1000;

// When each session was last looked at (selected while the page is showing).
// A finished turn stands out only until you have seen it. "Mark as unread"
// puts it back, and keeps it so until you pick the session again.
const seen = new Map(Object.entries(store.get('seen', {})));
const unread = new Set(store.get('unread', []));
const isSeen = (s) => !unread.has(s.key) && seen.get(s.key) >= s.stateAt;

function saveSeen() {
  const keys = new Set(state.sessions.map((x) => x.key));
  store.set('seen', Object.fromEntries([...seen].filter(([k]) => keys.has(k))));
  store.set('unread', [...unread].filter((k) => keys.has(k)));
}

// `picked`: the user just chose this session, which ends "unread".
function markSeen(picked = false) {
  const s = current();
  if (!s?.stateAt || document.hidden) return;
  if (picked) unread.delete(s.key);
  if (isSeen(s) || unread.has(s.key)) return saveSeen();
  seen.set(s.key, Date.now());
  closeNote(s.key);
  saveSeen();
}

function setUnread(key, on) {
  if (on) unread.add(key);
  else {
    unread.delete(key);
    seen.set(key, Date.now());
  }
  saveSeen();
  renderSidebar();
  renderHead(current());
}

// Only a blocked session gets a running clock. A finished one is either new
// to you or not; the sidebar already says how long ago it finished.
// `full`: the header, which has room to say what Claude waits for and how
// long the turn took.
function stateHtml(s, full = false) {
  if (!s.state || s.state === 'ended') return '';
  const label = s.state === 'working' && s.stateDetail ? tr('state.workingOn', s.stateDetail) : tr(`state.${s.state}`);
  let cls = `state s-${s.state}`;
  let title = '';
  let extra = '';
  if (s.state === 'waiting' && s.stateAt) {
    if (Date.now() - s.stateAt > LONG_WAIT_MS) cls += ' long';
    title = s.stateDetail || '';
    extra = ` · <span class="since" data-since="${s.stateAt}" title="${esc(tr('state.waitingSince', new Date(s.stateAt).toLocaleTimeString()))}">${waited(s.stateAt)}</span>`;
    if (full && s.stateDetail) extra += ` <span class="state-detail">· ${esc(s.stateDetail)}</span>`;
  } else if (s.state === 'idle' && s.stateAt) {
    cls += isSeen(s) ? ' seen' : ' unseen';
    const took = s.turnStartedAt && s.turnStartedAt < s.stateAt ? span(s.stateAt - s.turnStartedAt) : null;
    title = tr('state.doneAt', new Date(s.stateAt).toLocaleTimeString()) + (took ? ` · ${tr('state.took', took)}` : '');
    if (full && took) extra = ` <span class="state-detail">· ${esc(tr('state.took', took))}</span>`;
  }
  return `<span class="${cls}"${title ? ` title="${esc(title)}"` : ''}><span class="dot"></span>${esc(label)}${extra}</span>`;
}

// Tick the wait counters between polls so they count by the second.
setInterval(() => {
  for (const el of document.querySelectorAll('.since')) {
    const t = Number(el.dataset.since);
    el.textContent = waited(t);
    el.closest('.state')?.classList.toggle('long', Date.now() - t > LONG_WAIT_MS);
  }
}, 1000);

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error(body?.error || res.statusText), { status: res.status });
  return body;
}

const current = () => state.sessions.find((s) => s.key === state.selected) || null;
const rawUrl = (key, root, p) => `/raw/${state.info.token}/${key}/${root}/${p.split('/').map(encodeURIComponent).join('/')}`;

async function loadRoots(s) {
  const { roots } = await api(`/api/sessions/${s.key}/roots`);
  const before = JSON.stringify(state.roots[s.key]);
  state.roots[s.key] = roots;
  if (before !== JSON.stringify(roots) && state.selected === s.key) renderHead(s);
  return roots;
}

// Folders the session changed something in. The rest it only looked at.
const changedIn = (r) => r.primary || r.writes > 0;

// ---- sidebar ---------------------------------------------------------------

const isLive = (s) => s.running || s.external;

// Where in its project a session runs: "Source/Server" for a subfolder of
// the repo, nothing at the root.
function placeIn(s) {
  if (!s.cwd || !s.projectRoot) return '';
  const rel = s.cwd.slice(s.projectRoot.length).replace(/^[\\/]+/, '');
  return rel.replace(/\\/g, '/');
}

function itemHtml(s, byFolder) {
  const title = s.title || tr(s.running ? 'session.new' : 'session.untitled');
  const place = byFolder ? placeIn(s) : s.project || '';
  const meta = [place && esc(place), s.gitBranch && `⎇ ${esc(s.gitBranch)}`].filter(Boolean).join(' · ');
  return `<div class="item${s.key === state.selected ? ' selected' : ''}${tagAttrs(s)}" data-key="${esc(s.key)}" role="button" tabindex="0">
    <div class="item-title" title="${esc(title)}">${esc(title)}</div>
    <div class="item-meta"><span class="grow" title="${esc(s.cwd)}">${profileBadge(s)}${meta}</span><span class="cost">${money(s.costUsd, s.costIncomplete)}</span></div>
    <div class="item-sub"><span class="grow">${stateHtml(s) || esc(s.lastPrompt || '')}</span><span>${ago(s.lastAt)}</span></div>
    <div class="item-actions">
      <button class="more" data-menu="${esc(s.key)}" title="${esc(tr('session.more'))}" aria-haspopup="menu">⋯</button>
      ${s.running ? `<button class="kill" data-kill="${esc(s.managedId)}" title="${esc(tr('session.kill'))}">×</button>` : ''}
    </div>
  </div>`;
}

// By folder: one group per repo (or plain folder). Groups with something
// running come first, alphabetically: ordering them by activity would make
// them jump around on every poll while Claude works. The rest follow by
// latest activity. Inside a group the server's order holds: running here,
// open elsewhere, then most recent.
// How many ended sessions a sidebar group shows before "Show N older".
const ENDED_PER_FOLDER = 5;
const ENDED_PER_STATUS = 15;

function folderGroups(list) {
  const groups = new Map();
  for (const s of list) {
    const k = s.projectRoot || '';
    if (!groups.has(k)) groups.set(k, { key: k, label: s.projectName || tr('side.unknownFolder'), title: s.projectRoot || '', items: [] });
    groups.get(k).items.push(s);
  }
  const live = (g) => g.items.some(isLive);
  const last = (g) => Math.max(...g.items.map((s) => s.lastAt || 0));
  return [...groups.values()].sort((a, b) =>
    live(b) - live(a) || (live(a) ? a.label.localeCompare(b.label, locale(), { sensitivity: 'base' }) : last(b) - last(a)));
}

function statusGroups(list) {
  return [
    { key: 'running', label: tr('side.runningHere'), items: list.filter((s) => s.running) },
    { key: 'external', label: tr('side.external'), items: list.filter((s) => s.external) },
    { key: 'recent', label: tr('side.recent'), items: list.filter((s) => !isLive(s)) },
  ].filter((g) => g.items.length);
}

// A folder group: a header that folds it, then its sessions. `key` tells the
// same folder apart in the live and the ended section.
function groupHtml(g, key, f, limit) {
  // While filtering, show every hit even in collapsed groups.
  const collapsed = !f && state.collapsed.has(key);
  let html = `<button class="group-label group-toggle" data-group="${esc(key)}" title="${esc(g.title)}" aria-expanded="${!collapsed}">
    <span class="chev">${collapsed ? '▸' : '▾'}</span><span class="grow">${esc(g.label)}</span>
    <span title="${esc(tr('side.groupCount', g.items.length))}">${g.items.length}</span></button>`;
  if (!collapsed) html += groupItemsHtml(g, key, f, limit, true);
  return html;
}

// Live sessions always show; of the ended ones only the newest few, unless
// the group is opened up, a filter is on, or it holds the selected one.
function groupItemsHtml(g, key, f, limit, byFolder) {
  const all = !!f || state.showAll.has(key);
  const old = new Set(g.items.filter((s) => !isLive(s)).slice(limit).map((s) => s.key));
  const shown = all ? g.items : g.items.filter((s) => !old.has(s.key) || s.key === state.selected);
  let html = shown.map((s) => itemHtml(s, byFolder)).join('');
  const hidden = g.items.length - shown.length;
  if (hidden) html += `<button class="show-more" data-more="${esc(key)}">${esc(tr('side.showOlder', hidden))}</button>`;
  else if (!f && old.size && state.showAll.has(key)) html += `<button class="show-more" data-more="${esc(key)}">${esc(tr('side.showFewer'))}</button>`;
  return html;
}


function renderSidebar() {
  const f = state.filter.toLowerCase();
  const match = (s) => !f || [s.title, s.cwd, s.lastPrompt, s.gitBranch, s.projectName, profileOf(s)?.tag].some((v) => v && v.toLowerCase().includes(f));
  const byFolder = state.groupBy === 'folder';
  const list = state.sessions.filter(match);
  let html = '';
  if (byFolder) {
    // Live sessions on top, by folder. The ended ones below, by folder again,
    // in a section that stays folded until asked for.
    const live = list.filter(isLive);
    const ended = list.filter((s) => !isLive(s));
    if (live.length) {
      html += `<div class="section-label">${esc(tr('side.live'))}</div>`;
      for (const g of folderGroups(live)) html += groupHtml(g, g.key, f, Infinity);
    }
    if (ended.length) {
      const open = !!f || state.oldOpen;
      html += `<button class="section-label section-toggle" data-section="old" aria-expanded="${open}">
        <span class="chev">${open ? '▾' : '▸'}</span><span class="grow">${esc(tr('side.earlier'))}</span><span>${ended.length}</span></button>`;
      // Folded, it still shows the selected session, say one found by search.
      const items = open ? ended : ended.filter((s) => s.key === state.selected);
      for (const g of folderGroups(items)) html += groupHtml(g, `old:${g.key}`, f, open ? ENDED_PER_FOLDER : Infinity);
    }
  } else {
    for (const g of statusGroups(list)) {
      html += `<div class="group-label">${esc(g.label)}</div>`;
      html += groupItemsHtml(g, g.key, f, ENDED_PER_STATUS, false);
    }
  }
  $('#session-list').innerHTML = html || `<div class="panel-msg">${tr('side.none')}</div>`;
  $('#group-btn').textContent = tr(byFolder ? 'side.byFolder' : 'side.byStatus');
  $('#group-btn').title = tr(byFolder ? 'side.byFolderTitle' : 'side.byStatusTitle');
  renderTitle();

  const live = state.sessions.filter((s) => s.running || s.external);
  const total = live.reduce((sum, s) => sum + (s.costUsd || 0), 0);
  let foot = `${tr('side.active', live.length)}${total ? ` · ${money(total)}` : ''} · ${state.info.host === 'tmux' ? 'tmux' : 'pty'}`;
  if (state.info.hooks === false) foot += `<br>${tr('side.hooks')}`;
  else if (canNotify && Notification.permission === 'default') {
    foot += `<br>${tr('side.notify')}`;
  }
  foot += `<br><button id="lang-btn" class="link-btn" title="${esc(tr('lang.switchTitle'))}">${esc(tr('lang.switch'))}</button>`;
  $('#side-foot').innerHTML = foot;
}

$('#session-list').addEventListener('click', (e) => {
  const kill = e.target.closest('[data-kill]');
  if (kill) {
    e.stopPropagation();
    if (!kill.classList.contains('armed')) {
      kill.classList.add('armed');
      kill.textContent = tr('session.killConfirm');
      setTimeout(() => {
        kill.classList.remove('armed');
        kill.textContent = '×';
      }, 3000);
      return;
    }
    api(`/api/sessions/${kill.dataset.kill}`, { method: 'DELETE' }).then(refresh, (err) => alertBox(err.message));
    return;
  }
  const more = e.target.closest('[data-menu]');
  if (more) {
    e.stopPropagation();
    return openMenu(more.dataset.menu, more.getBoundingClientRect());
  }
  const showMore = e.target.closest('[data-more]');
  if (showMore) {
    const k = showMore.dataset.more;
    if (state.showAll.has(k)) state.showAll.delete(k);
    else state.showAll.add(k);
    return renderSidebar();
  }
  if (e.target.closest('[data-section="old"]')) {
    state.oldOpen = !state.oldOpen;
    store.set('oldOpen', state.oldOpen);
    return renderSidebar();
  }
  const group = e.target.closest('[data-group]');
  if (group) {
    const k = group.dataset.group;
    if (state.collapsed.has(k)) state.collapsed.delete(k);
    else state.collapsed.add(k);
    store.set('collapsed', [...state.collapsed]);
    return renderSidebar();
  }
  const item = e.target.closest('.item');
  if (item) select(item.dataset.key);
});
$('#session-list').addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.item');
  if (!item) return;
  e.preventDefault();
  openMenu(item.dataset.key, { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });
});
$('#session-list').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('item')) select(e.target.dataset.key);
  // Shift+F10 / the menu key, as in any list with context menus.
  if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && e.target.classList.contains('item')) {
    e.preventDefault();
    openMenu(e.target.dataset.key, e.target.getBoundingClientRect());
  }
});
$('#filter').addEventListener('input', (e) => {
  state.filter = e.target.value;
  renderSidebar();
});
$('#group-btn').addEventListener('click', () => {
  state.groupBy = state.groupBy === 'folder' ? 'status' : 'folder';
  store.set('groupBy', state.groupBy);
  renderSidebar();
});

// ---- session menu ----------------------------------------------------------
// Lives outside the list, which is redrawn on every poll.

// The profile for "the same kind, but Claude" (or "but a plain terminal"):
// the session's own profile if it is that kind, else one with the same tag,
// else the default of that kind. A "Work" terminal thus gives "Work + Claude".
function siblingProfile(s, claude) {
  const p = profileOf(s);
  const kind = profiles().filter((x) => x.claude === claude);
  if (p && p.claude === claude) return p;
  return (p?.tag && kind.find((x) => x.tag === p.tag)) || kind[0] || null;
}

function openMenu(key, at) {
  const s = state.sessions.find((x) => x.key === key);
  const menu = $('#item-menu');
  if (!s || !s.cwd) return;
  const claudeP = siblingProfile(s, true);
  const shellP = siblingProfile(s, false);
  const items = [
    claudeP && `<button role="menuitem" data-act="claude">${esc(tr('menu.claude'))}<span class="hint">${esc(claudeP.name)}</span></button>`,
    shellP && `<button role="menuitem" data-act="shell">${esc(tr('menu.shell'))}<span class="hint">${esc(shellP.name)}</span></button>`,
    `<button role="menuitem" data-act="pick">${esc(tr('menu.pick'))}</button>`,
    '<hr>',
    `<button role="menuitem" data-act="copy">${esc(tr('menu.copy'))}<span class="hint">${esc(shortPath(s.cwd))}</span></button>`,
    s.state === 'idle' && s.stateAt && `<button role="menuitem" data-act="${isSeen(s) ? 'unread' : 'read'}">${esc(tr(isSeen(s) ? 'menu.unread' : 'menu.read'))}</button>`,
  ];
  menu.innerHTML = items.filter(Boolean).join('');
  menu.dataset.key = key;
  menu.dataset.claude = claudeP?.id || '';
  menu.dataset.shell = shellP?.id || '';
  menu.hidden = false;
  // Below the button, kept inside the window.
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(4, Math.min(at.right - w, innerWidth - w - 4))}px`;
  menu.style.top = `${at.bottom + h + 4 > innerHeight ? Math.max(4, at.top - h - 4) : at.bottom + 4}px`;
  menu.querySelector('button')?.focus();
}

function closeMenu() {
  $('#item-menu').hidden = true;
}

$('#item-menu').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const menu = $('#item-menu');
  const s = state.sessions.find((x) => x.key === menu.dataset.key);
  closeMenu();
  if (!s) return;
  const act = b.dataset.act;
  if (act === 'copy') return navigator.clipboard.writeText(s.cwd);
  if (act === 'unread' || act === 'read') return setUnread(s.key, act === 'unread');
  if (act === 'pick') return openNewDialog({ cwd: s.cwd, profile: menu.dataset.claude });
  const r = await startSession({ cwd: s.cwd, profile: menu.dataset[act] });
  if (r !== true) alertBox(r);
});
$('#item-menu').addEventListener('keydown', (e) => {
  const buttons = [...$('#item-menu').querySelectorAll('button')];
  const i = buttons.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  }
});
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#item-menu, [data-menu]')) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#item-menu').hidden) closeMenu();
});
$('#session-list').addEventListener('scroll', closeMenu);
addEventListener('resize', closeMenu);

// ---- main area -------------------------------------------------------------

function select(key) {
  const changed = key !== state.selected;
  state.selected = key;
  store.set('selected', key);
  markSeen(true);
  if (changed) {
    state.preview = null;
    closeSearch();
  }
  renderSidebar();
  renderMain();
  if (changed) renderPanel();
  // For the header's "+ other folders", also when the panel is closed.
  const s = current();
  if (changed && s?.cwd && !state.panelOpen) loadRoots(s).catch(() => {});
}

function renderHead(s) {
  $('#main-head').hidden = !s;
  if (!s) return;
  const color = tagColor(s);
  $('#main-head').classList.toggle('tagged', !!color);
  if (color) $('#main-head').style.setProperty('--tag', color);
  $('#head-title').textContent = s.title || tr(s.running ? 'session.new' : 'session.untitled');
  const extra = (state.roots[s.key] || []).filter((r) => !r.primary && r.writes);
  const meta = [
    profileBadge(s),
    s.cwd &&`<span class="path" title="${esc(s.cwd)}">${esc(shortPath(s.cwd))}</span>`,
    extra.length && `<span title="${esc(tr('head.alsoChanged', extra.map((r) => r.path).join('\n')))}">+ ${esc(extra.map((r) => r.name).join(', '))}</span>`,
    s.gitBranch && `<span>⎇ ${esc(s.gitBranch)}</span>`,
    s.model && `<span>${esc(s.model)}</span>`,
    s.costUsd && `<span title="${esc(tr('head.costTitle'))}">${money(s.costUsd, s.costIncomplete)}</span>`,
    s.contextPct != null && `<span>${esc(tr('head.context', Math.round(s.contextPct)))}</span>`,
    stateHtml(s, true),
  ].filter(Boolean);
  $('#head-meta').innerHTML = meta.join('');
}

function renderMain() {
  const s = current();
  renderHead(s);
  $('#empty').hidden = !!s;
  const showTerm = s && s.running;
  for (const [id, t] of state.terms) t.el.hidden = !(showTerm && id === s.managedId);
  $('#detail').hidden = !s || showTerm;
  if (!showTerm) closeSearch();
  if (showTerm) {
    const t = ensureTerm(s.managedId);
    requestAnimationFrame(() => {
      t.fit.fit();
      t.term.focus();
    });
  } else if (s) {
    renderDetail(s);
  }
}

function renderDetail(s) {
  const canResume = s.cwd && !s.external;
  // Continue with the profile it was started with, unless picked otherwise.
  const claudeProfiles = profiles().filter((p) => p.claude);
  const chosen = [state.resumeProfile[s.key], s.profileId].find((id) => claudeProfiles.some((p) => p.id === id)) || claudeProfiles[0]?.id;
  const picker = claudeProfiles.length > 1 && (canResume || s.external)
    ? `<select id="resume-profile" class="profile-select" title="${esc(tr('detail.profile'))}">${claudeProfiles.map((p) => `<option value="${esc(p.id)}"${p.id === chosen ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`
    : '';
  $('#detail').innerHTML = `
    <h2>${esc(s.title || tr('session.untitled'))}</h2>
    ${s.lastPrompt ? `<div class="prompt">${esc(s.lastPrompt)}</div>` : ''}
    <dl>
      <dt>${tr('detail.folder')}</dt><dd>${esc(s.cwd || '–')}</dd>
      <dt>${tr('detail.session')}</dt><dd>${esc(s.key)}</dd>
      ${s.model ? `<dt>${tr('detail.model')}</dt><dd>${esc(s.model)}</dd>` : ''}
      ${s.costUsd ? `<dt>${tr('detail.cost')}</dt><dd>${money(s.costUsd, s.costIncomplete)}</dd>` : ''}
      ${s.startedAt ? `<dt>${tr('detail.started')}</dt><dd>${new Date(s.startedAt).toLocaleString()}</dd>` : ''}
      ${s.lastAt ? `<dt>${tr('detail.lastActive')}</dt><dd>${new Date(s.lastAt).toLocaleString()}</dd>` : ''}
    </dl>
    ${canResume ? `${picker}<button class="btn primary" id="resume-btn">${tr('detail.resume')}</button>` : ''}
    ${s.external ? `<p class="note">${tr('detail.externalNote')}</p>
      ${picker}<button class="btn" id="resume-btn">${tr('detail.resumeAnyway')}</button>` : ''}
  `;
  // The detail view is redrawn on every poll; keep the pick.
  $('#resume-profile')?.addEventListener('change', (e) => (state.resumeProfile[s.key] = e.target.value));
  $('#resume-btn')?.addEventListener('click', () => startSession({ cwd: s.cwd, resumeId: s.key, profile: $('#resume-profile')?.value }));
}

function alertBox(msg) {
  const d = $('#detail');
  d.hidden = false;
  d.insertAdjacentHTML('afterbegin', `<p class="error">${esc(msg)}</p>`);
}

// ---- terminals -------------------------------------------------------------

const TERM_THEME = {
  background: '#1b1a19',
  foreground: '#e8e6e1',
  cursor: '#e8e6e1',
  selectionBackground: '#5a564e',
};

const SEARCH_DECORATIONS = {
  matchBackground: '#5a564e',
  matchOverviewRuler: '#9a968c',
  activeMatchBackground: '#d97757',
  activeMatchColorOverviewRuler: '#d97757',
};

const FONT_DEFAULT = 13;
let fontSize = store.get('fontSize', FONT_DEFAULT);

function setFontSize(size) {
  fontSize = Math.min(Math.max(size, 8), 28);
  store.set('fontSize', fontSize);
  for (const t of state.terms.values()) {
    t.term.options.fontSize = fontSize;
    if (!t.el.hidden && t.el.clientWidth) t.fit.fit();
  }
}

// Keys the terminal handles itself instead of sending to Claude.
function termKey(t, e) {
  if (e.type !== 'keydown') return true;
  // Shift+Enter inserts a newline in Claude's prompt (sent as Alt+Enter).
  if (e.key === 'Enter' && e.shiftKey) {
    send(t, { t: 'in', d: '\x1b\r' });
    return false;
  }
  const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
  // Ctrl+. is cc-dash's (see nextAttention); the document listener acts on it.
  if (mod && !e.shiftKey && e.code === 'Period') return false;
  if (mod && e.shiftKey && e.code === 'KeyF') {
    e.preventDefault();
    openSearch();
    return false;
  }
  // Ctrl +/−/0 resize the terminal font instead of zooming the page.
  if (mod && !e.shiftKey && ['=', '+', '-', '0'].includes(e.key)) {
    e.preventDefault();
    setFontSize(e.key === '0' ? FONT_DEFAULT : fontSize + (e.key === '-' ? -1 : 1));
    return false;
  }
  return true;
}

function ensureTerm(id) {
  let t = state.terms.get(id);
  if (t) return t;
  const el = document.createElement('div');
  el.className = 'term';
  $('#terms').appendChild(el);
  const term = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'),
    fontSize,
    cursorBlink: true,
    scrollback: 10000,
    theme: TERM_THEME,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon());
  // Claude's symbols (⏺ ✻ ⎿, emoji) need Unicode 11 widths to line up.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.open(el);
  fit.fit();
  // xterm measures the cell size once; re-measure when fonts finish loading.
  document.fonts?.ready.then(() => {
    const ff = term.options.fontFamily;
    term.options.fontFamily = 'monospace'; // unchanged values are ignored
    term.options.fontFamily = ff;
    if (!el.hidden && el.clientWidth) fit.fit();
  });
  t = { id, term, fit, search, el, ws: null, exited: false, retries: 0 };
  state.terms.set(id, t);

  term.attachCustomKeyEventHandler((e) => termKey(t, e));
  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    if (visibleTerm() !== t) return;
    // resultIndex is -1 when there are too many matches to number.
    $('#search-count').textContent = !$('#search-input').value ? ''
      : !resultCount ? tr('search.none') : resultIndex < 0 ? `${resultCount}+` : `${resultIndex + 1} / ${resultCount}`;
  });
  term.onData((d) => send(t, { t: 'in', d }));
  term.onResize(({ cols, rows }) => send(t, { t: 'resize', c: cols, r: rows }));
  new ResizeObserver(() => {
    if (!el.hidden && el.clientWidth) fit.fit();
  }).observe(el);
  connect(t);
  return t;
}

function send(t, msg) {
  if (t.ws && t.ws.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify(msg));
}

function connect(t) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/term/${t.id}?c=${t.term.cols}&r=${t.term.rows}`);
  ws.binaryType = 'arraybuffer';
  t.ws = ws;
  ws.onopen = () => {
    t.retries = 0;
  };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') return t.term.write(e.data);
    const msg = JSON.parse(new TextDecoder().decode(e.data));
    if (msg.t === 'exit') t.exited = true;
  };
  ws.onclose = () => {
    if (t.exited) return onExited(t);
    // Server restarted or network blip: reconnect while the session exists.
    if (t.retries++ < 10) setTimeout(() => state.terms.get(t.id) === t && connect(t), 1000 * t.retries);
  };
}

function onExited(t) {
  t.term.write(`\r\n\x1b[2m${tr('term.ended')}\x1b[0m\r\n`);
  setTimeout(() => {
    disposeTerm(t.id);
    refresh();
  }, 1500);
}

function disposeTerm(id) {
  const t = state.terms.get(id);
  if (!t) return;
  t.exited = true;
  t.ws?.close();
  t.term.dispose();
  t.el.remove();
  state.terms.delete(id);
}

// ---- terminal search -------------------------------------------------------

const visibleTerm = () => [...state.terms.values()].find((t) => !t.el.hidden) || null;

function openSearch() {
  if (!visibleTerm()) return;
  $('#term-search').hidden = false;
  $('#search-input').select();
  if ($('#search-input').value) findInTerm(1, true);
}

function closeSearch() {
  if ($('#term-search').hidden) return;
  $('#term-search').hidden = true;
  $('#search-count').textContent = '';
  for (const t of state.terms.values()) t.search.clearDecorations();
  visibleTerm()?.term.focus();
}

function findInTerm(dir, incremental = false) {
  const t = visibleTerm();
  const q = $('#search-input').value;
  if (!t) return;
  if (!q) {
    t.search.clearDecorations();
    $('#search-count').textContent = '';
    return;
  }
  const opts = { incremental, decorations: SEARCH_DECORATIONS };
  const found = dir > 0 ? t.search.findNext(q, opts) : t.search.findPrevious(q, opts);
  if (!found) $('#search-count').textContent = tr('search.none');
}

$('#search-input').addEventListener('input', () => findInTerm(1, true));
$('#search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    findInTerm(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSearch();
  }
});
$('#search-next').addEventListener('click', () => findInTerm(1));
$('#search-prev').addEventListener('click', () => findInTerm(-1));
$('#search-close').addEventListener('click', closeSearch);
// Also when focus is outside the terminal (sidebar, panel).
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyF' && visibleTerm()) {
    e.preventDefault();
    openSearch();
  }
});

// ---- new session -----------------------------------------------------------

async function startSession(body) {
  try {
    const r = await api('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
    await refresh();
    select(r.key);
    $('#session-list .item.selected')?.scrollIntoView({ block: 'nearest' });
    return true;
  } catch (e) {
    return e.message;
  }
}

// Opens "New session", optionally filled in (from a session's menu).
async function openNewDialog(prefill = {}) {
  const dlg = $('#new-dialog');
  $('#new-error').hidden = true;
  const cur = current();
  const sel = $('#new-profile');
  const want = prefill.profile || store.get('profile', null);
  sel.innerHTML = profiles()
    .map((p) => `<option value="${esc(p.id)}"${p.id === want ? ' selected' : ''}>${esc(p.name)}${p.claude ? '' : tr('new.terminal')}</option>`)
    .join('');
  const prof = profiles().find((p) => p.id === sel.value);
  $('#new-cwd').value = prefill.cwd || prof?.cwd || cur?.cwd || '';
  markProfileSelect();
  $('#recent-dirs').innerHTML = '';
  dlg.showModal();
  $('#new-cwd').select();
  try {
    const { dirs } = await api('/api/dirs');
    $('#recent-dirs').innerHTML = dirs.map((d) => `<button type="button" data-dir="${esc(d)}">${esc(shortPath(d))}</button>`).join('')
      || `<div class="panel-msg">${tr('new.recentNone')}</div>`;
  } catch {}
}
$('#new-btn').addEventListener('click', () => openNewDialog());

// The skipper runs the fleet (see server/fleet.js): start it, or open the one that runs.
$('#skipper-btn').addEventListener('click', async () => {
  try {
    const r = await api('/api/skipper', { method: 'POST', body: '{}' });
    await refresh();
    select(r.key);
  } catch (e) {
    alert(e.message);
  }
});
$('#recent-dirs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-dir]');
  if (b) $('#new-cwd').value = b.dataset.dir;
});
$('#recent-dirs').addEventListener('dblclick', (e) => {
  if (e.target.closest('[data-dir]')) $('#new-form').requestSubmit();
});
// The picker takes the color of a tagged profile, so it is clear which one
// you are about to start.
function markProfileSelect() {
  const sel = $('#new-profile');
  const color = tagColor({ profileId: sel.value });
  sel.classList.toggle('tagged', !!color);
  sel.style.setProperty('--tag', color || '');
}

// A profile with its own folder fills it in.
$('#new-profile').addEventListener('change', (e) => {
  const p = profiles().find((x) => x.id === e.target.value);
  if (p?.cwd) $('#new-cwd').value = p.cwd;
  markProfileSelect();
});
$('#new-cancel').addEventListener('click', () => $('#new-dialog').close());
$('#new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const profile = $('#new-profile').value || undefined;
  store.set('profile', profile);
  const r = await startSession({ cwd: $('#new-cwd').value.trim(), profile });
  if (r === true) $('#new-dialog').close();
  else {
    $('#new-error').textContent = r;
    $('#new-error').hidden = false;
  }
});

// ---- panel: diff / files / preview -----------------------------------------

function setPanel(open) {
  state.panelOpen = open;
  store.set('panelOpen', open);
  $('#panel').hidden = !open;
  $('#splitter').hidden = !open;
  $('#panel-btn').classList.toggle('active', open);
  if (open) renderPanel();
}

function setTab(tab) {
  state.tab = tab;
  store.set('tab', tab);
  renderPanel();
}

$('#panel-btn').addEventListener('click', () => setPanel(!state.panelOpen));
$('#panel-refresh').addEventListener('click', () => renderPanel());
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

async function renderPanel() {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  if (!state.panelOpen) return;
  const s = current();
  const body = $('#panel-body');
  if (!s || !s.cwd) {
    body.innerHTML = `<div class="panel-msg">${tr('panel.pick')}</div>`;
    return;
  }
  const key = s.key;
  try {
    if (state.tab === 'diff') await renderDiff(s, body);
    else if (state.tab === 'files') await renderFiles(s, body);
    else await renderRefs(s, body);
  } catch (e) {
    if (state.selected === key) body.innerHTML = `<div class="panel-msg error">${esc(e.message)}</div>`;
  }
}

// One section per folder: those the session changed things in, then the ones
// it only read from, collapsed (they may hold someone else's unrelated work).
async function renderDiff(s, body) {
  state.lastDiffAt = Date.now();
  const roots = await loadRoots(s);
  const isOpen = (r) => changedIn(r) || state.openRoots.has(`${s.key}:${r.id}`);
  const diffs = await Promise.all(roots.map((r) => (r.git && isOpen(r) ? api(`/api/sessions/${s.key}/diff?root=${r.id}`) : null)));
  if (state.selected !== s.key || state.tab !== 'diff') return;
  state.diffData = { key: s.key, roots, diffs };
  paintDiff(s, body);
}

// Draws the fetched diff with the review comments in it. Adding or editing a
// comment redraws from here, without asking git again.
function paintDiff(s, body = $('#panel-body')) {
  const dd = state.diffData;
  if (!dd || dd.key !== s.key || state.tab !== 'diff') return;
  const { roots, diffs } = dd;
  const isOpen = (r) => changedIn(r) || state.openRoots.has(`${s.key}:${r.id}`);
  const placed = new Set(); // comments (and the draft) drawn at their line
  let html = '';
  if (roots.length === 1) html = rootDiffHtml(s, roots[0], diffs[0], placed);
  else {
    roots.forEach((r, i) => {
      const head = `${esc(r.name)}<span class="root-path">${esc(shortPath(r.path))}</span>`;
      if (changedIn(r)) html += `<section class="root"><div class="root-head" title="${esc(r.path)}">${head}</div>${rootDiffHtml(s, r, diffs[i], placed)}</section>`;
      else {
        html += `<details class="root" data-root-toggle="${esc(r.id)}"${isOpen(r) ? ' open' : ''}>
          <summary class="root-head" title="${esc(r.path)}">${head} <span class="muted">${tr('diff.readOnly')}</span></summary>
          ${isOpen(r) ? rootDiffHtml(s, r, diffs[i], placed) : ''}</details>`;
      }
    });
  }
  body.innerHTML = commentBar(s, placed) + html;
  const ta = body.querySelector('.dc-edit textarea');
  if (ta) {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
}

// data-root tells the click handler which folder the paths inside belong to.
function rootDiffHtml(s, r, d, placed) {
  return `<div data-root="${esc(r.id)}">${r.git ? diffHtml(s, r, d, placed) : writtenHtml(r)}</div>`;
}

// A folder without git: the files the session wrote there, newest first.
function writtenHtml(r) {
  const files = r.written || [];
  let html = `<div class="diff-head">${tr('diff.notGit')}${files.length ? ` · ${tr('diff.written', files.length)}` : ''}</div>`;
  for (const f of files) {
    html += `<button class="file-row" data-open="${esc(f.path)}"><span class="icon"></span><span class="grow">${esc(f.path)}</span><span class="badge">${ago(f.at)}</span></button>`;
  }
  return html;
}

function diffHtml(s, root, d, placed) {
  if (!d.repo) return `<div class="panel-msg">${tr('diff.notRepo')}</div>`;
  if (!d.files.length) return `<div class="diff-head">⎇ ${esc(d.branch)} · ${tr('diff.noChanges')}</div>`;
  const untracked = d.files.filter((f) => f.status === '??');
  const blocks = d.diff.split(/^(?=diff --git )/m).filter((b) => b.startsWith('diff --git'));
  let html = `<div class="diff-head">⎇ ${esc(d.branch)} · ${tr('diff.changed', d.files.length)}</div>`;
  const toCwd = (f) => (d.prefix ? `${d.prefix}/${f}` : f);
  const comments = (state.comments[s.key] || []).filter((c) => c.root === root.id);
  const draft = state.draft?.key === s.key && state.draft.root === root.id ? state.draft : null;
  let lines = 0;
  for (const b of blocks) {
    const m = b.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const file = m ? m[2] : '?';
    const path = toCwd(file);
    const f = d.files.find((x) => x.path === file) || {};
    const here = comments.filter((c) => c.file === path);
    const draftHere = draft?.file === path ? draft : null;
    const rows = b.split('\n');
    const start = rows.findIndex((r) => r.startsWith('@@'));
    let body = '';
    if (start < 0) body = `<div class="hunk">${tr('diff.binary')}</div>`;
    else {
      // Line numbers from the hunk headers, old (o) and new (n); a comment
      // is pinned to the numbers of the line it was written on.
      let o = 0;
      let n = 0;
      let inDraft = false;
      for (const r of rows.slice(start)) {
        if (++lines > 20000) break;
        const h = r.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
        if (h) {
          o = Number(h[1]);
          n = Number(h[2]);
          body += `<div class="hunk">${esc(r)}</div>`;
          continue;
        }
        if (!r) continue; // what follows the last newline
        if (r.startsWith('\\')) {
          body += `<div class="hunk">${esc(r)}</div>`; // \ No newline at end of file
          continue;
        }
        const at = r[0] === '+' ? { o: null, n: n++ } : r[0] === '-' ? { o: o++, n: null } : { o: o++, n: n++ };
        const cls = r[0] === '+' ? 'add' : r[0] === '-' ? 'del' : '';
        if (draftHere && !draftHere.id && sameLine(draftHere.from, at)) inDraft = true;
        body += `<div class="${cls}${inDraft ? ' sel' : ''}" data-o="${at.o ?? ''}" data-n="${at.n ?? ''}"><button class="ln" data-dc="line" tabindex="-1" title="${esc(tr('dc.comment'))}">${at.n ?? at.o}</button>${esc(r)}</div>`;
        for (const c of here) {
          if (!sameLine(c.to, at)) continue;
          placed.add(c.id);
          body += draftHere?.id === c.id ? draftHtml(draftHere) : commentHtml(c);
        }
        if (draftHere && !draftHere.id && sameLine(draftHere.to, at)) {
          inDraft = false;
          placed.add('draft');
          body += draftHtml(draftHere);
        }
      }
    }
    html += `<details class="diff-file" open data-file="${esc(path)}"><summary>
      <span class="st st-${esc(f.status || 'M')}">${esc(f.status || 'M')}</span>
      <span class="grow">${esc(file)}</span>
      <span class="badge"><span class="a">+${f.add ?? 0}</span> <span class="d">−${f.del ?? 0}</span></span>
      <a data-open="${esc(toCwd(file))}">${tr('diff.view')}</a></summary><div class="diff-lines">${body}</div></details>`;
  }
  if (untracked.length) {
    html += `<div class="group-label" style="padding:12px">${tr('diff.untracked')}</div>`;
    for (const f of untracked) {
      html += `<button class="file-row" data-open="${esc(toCwd(f.path))}"><span class="st st-??">??</span><span class="grow">${esc(f.path)}</span></button>`;
    }
  }
  return html;
}

// ---- panel: review comments on the diff ------------------------------------
// Click a line number in the diff to comment on it, Shift+click another to
// cover the lines between. The comments are sent to Claude together, as one
// message pasted into its prompt, each with the lines it is about.

const sameLine = (a, b) => a.o === b.o && a.n === b.n;
const lineNo = (a) => a.n ?? a.o;

function commentWhere(c) {
  const [a, b] = [lineNo(c.from), lineNo(c.to)];
  return `${c.file}:${a === b ? a : `${a}-${b}`}`;
}

function commentHtml(c, moved = false) {
  return `<div class="dc" data-dc-id="${esc(c.id)}">
    <div class="dc-where">${esc(commentWhere(c))}${moved ? ` <span class="muted">· ${esc(tr('dc.moved'))}</span>` : ''}</div>
    <div class="dc-text">${esc(c.text)}</div>
    <div class="dc-actions"><button class="btn small" data-dc="edit">${esc(tr('dc.edit'))}</button><button class="btn small" data-dc="delete">${esc(tr('dc.delete'))}</button></div></div>`;
}

function draftHtml(d) {
  return `<div class="dc dc-edit">
    <div class="dc-where">${esc(commentWhere(d))}</div>
    <textarea rows="3" placeholder="${esc(tr('dc.placeholder'))}">${esc(d.text)}</textarea>
    <div class="dc-actions"><span class="muted grow">${esc(tr('dc.hint'))}</span><button class="btn small" data-dc="cancel">${esc(tr('dc.cancel'))}</button><button class="btn small primary" data-dc="save">${esc(tr('dc.save'))}</button></div></div>`;
}

// Why the comments can't be sent from here right now, or null.
function cantSend(s) {
  if (!s.running || !state.terms.get(s.managedId)) return tr('dc.notHere');
  if (s.state === 'waiting') return tr('dc.busy');
  return null;
}

// Above the diff: the count, the buttons, and comments whose line has gone.
function commentBar(s, placed) {
  const list = state.comments[s.key] || [];
  const draft = state.draft?.key === s.key ? state.draft : null;
  const lost = list.filter((c) => !placed.has(c.id));
  const lostDraft = draft && !placed.has(draft.id || 'draft');
  if (!list.length && !lostDraft) return '';
  const why = cantSend(s);
  let html = `<div class="dc-bar"><span class="grow">${esc(tr('dc.count', list.length))}</span>
    <button class="btn small" data-dc="clear">${esc(tr('dc.clear'))}</button>
    <button class="btn small" data-dc="copy">${esc(tr('dc.copy'))}</button>
    <button class="btn small primary" data-dc="send" title="${esc(why || tr('dc.sendTitle'))}"${why || !list.length ? ' disabled' : ''}>${esc(tr('dc.send'))}</button></div>`;
  if (lost.length || lostDraft) {
    html += '<div class="dc-lost">';
    for (const c of lost) html += draft?.id === c.id ? draftHtml(draft) : commentHtml(c, true);
    if (lostDraft && !draft.id) html += draftHtml(draft);
    html += '</div>';
  }
  return html;
}

// The message for Claude. Paths are as seen from the session's folder;
// those in its other folders are full paths.
function commentsPrompt(s) {
  let text = tr('dc.prompt');
  const list = [...(state.comments[s.key] || [])].sort((a, b) => a.root.localeCompare(b.root) || a.file.localeCompare(b.file) || lineNo(a.from) - lineNo(b.from));
  for (const c of list) {
    const file = c.root === 'main' ? c.file : joinPath(c.rootPath, c.file);
    const where = commentWhere({ ...c, file });
    text += `\n\n${where}\n\`\`\`diff\n${c.code.join('\n')}\n\`\`\`\n${c.text}`;
  }
  return text;
}

function joinPath(dir, rel) {
  const out = dir.replace(/\\/g, '/').split('/');
  for (const part of rel.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

function saveComments() {
  store.set('diffComments', Object.fromEntries(Object.entries(state.comments).filter(([, v]) => v.length)));
}

// Start a comment on a line, or with Shift stretch the one being written to it.
function commentLine(s, btn, extend) {
  const row = btn.parentElement;
  const block = row.closest('.diff-file');
  const rootEl = row.closest('[data-root]');
  const rows = [...block.querySelectorAll('.diff-lines > [data-n]')];
  const at = (el) => ({ o: el.dataset.o ? Number(el.dataset.o) : null, n: el.dataset.n ? Number(el.dataset.n) : null });
  const d = state.draft;
  let from = row;
  let to = row;
  if (extend && d && !d.id && d.key === s.key && d.root === rootEl.dataset.root && d.file === block.dataset.file) {
    const first = rows.find((r) => sameLine(at(r), d.from));
    if (first) [from, to] = rows.indexOf(first) <= rows.indexOf(row) ? [first, row] : [row, first];
  }
  const span = rows.slice(rows.indexOf(from), rows.indexOf(to) + 1);
  const code = span.map((r) => r.textContent.slice(r.querySelector('.ln').textContent.length));
  const root = (state.roots[s.key] || []).find((r) => r.id === rootEl.dataset.root);
  state.draft = {
    key: s.key,
    root: rootEl.dataset.root,
    rootPath: root?.path || s.cwd,
    file: block.dataset.file,
    from: at(from),
    to: at(to),
    code: code.length > 40 ? [...code.slice(0, 40), '…'] : code,
    text: d && !d.id && d.key === s.key ? d.text : '',
  };
  paintDiff(s);
}

function saveDraft(s) {
  const d = state.draft;
  if (!d || d.key !== s.key) return;
  const text = d.text.trim();
  const list = (state.comments[s.key] ||= []);
  const i = list.findIndex((c) => c.id === d.id);
  if (!text) {
    if (i >= 0) list.splice(i, 1); // emptied: same as deleting it
  } else {
    const { key, ...c } = { ...d, text, id: d.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` };
    if (i >= 0) list[i] = c;
    else list.push(c);
  }
  state.draft = null;
  saveComments();
  paintDiff(s);
}

function sendComments(s) {
  if (cantSend(s) || !state.comments[s.key]?.length) return;
  const t = state.terms.get(s.managedId);
  // paste() wraps it as a bracketed paste, so the newlines don't submit it;
  // the Enter that does comes on its own, after Claude has taken the paste.
  t.term.paste(commentsPrompt(s));
  setTimeout(() => send(t, { t: 'in', d: '\r' }), 250);
  state.comments[s.key] = [];
  state.draft = null;
  saveComments();
  paintDiff(s);
  t.term.focus();
}

function commentAction(s, b, e) {
  const act = b.dataset.dc;
  const id = b.closest('[data-dc-id]')?.dataset.dcId;
  const list = state.comments[s.key] || [];
  if (act === 'line') return commentLine(s, b, e.shiftKey);
  if (act === 'save') return saveDraft(s);
  if (act === 'cancel') state.draft = null;
  else if (act === 'edit') {
    const c = list.find((x) => x.id === id);
    if (c) state.draft = { ...c, key: s.key };
  } else if (act === 'delete') {
    state.comments[s.key] = list.filter((x) => x.id !== id);
    saveComments();
  } else if (act === 'clear') {
    if (!confirm(tr('dc.clearConfirm', list.length))) return;
    state.comments[s.key] = [];
    state.draft = null;
    saveComments();
  } else if (act === 'copy') {
    return navigator.clipboard.writeText(commentsPrompt(s)).then(() => {
      b.textContent = tr('dc.copied');
      setTimeout(() => (b.textContent = tr('dc.copy')), 1500);
    });
  } else if (act === 'send') return sendComments(s);
  paintDiff(s);
}

// Files and the preview share a tab: the list on top, or to the left when the
// panel is wide enough (see .files-split in style.css). Each half redraws on
// its own, so the preview stays put while you browse folders and vice versa.
async function renderFiles(s, body) {
  if (!filesPane(s, 'files-split')) {
    body.innerHTML = `<div class="files-split" data-key="${esc(s.key)}" style="--files-list: ${store.get('filesSplit', 35)}%">
      <div class="files-list"><div class="files-search"><input type="search" class="files-q" placeholder="${esc(tr('files.search'))}" spellcheck="false"></div><div class="files-entries"></div></div><div class="files-gutter" role="separator"></div><div class="files-preview"></div></div>`;
  }
  await Promise.all([renderFileList(s), renderPreview(s)]);
}

const filesPane = (s, cls) => $(`#panel-body .files-split[data-key="${CSS.escape(s.key)}"]${cls === 'files-split' ? '' : ` .${cls}`}`);
const onFiles = (s) => state.selected === s.key && state.tab === 'files';
const rowPath = (row) => row?.dataset.open ?? row?.dataset.dir;
const SEARCH_MIN = 2; // shorter text lists the folder instead

// A line of a search hit with each match marked.
function markHits(text, q) {
  const lower = text.toLowerCase();
  q = q.toLowerCase();
  let html = '';
  let at = 0;
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, at)) {
    html += `${esc(text.slice(at, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>`;
    at = i + q.length;
  }
  return html + esc(text.slice(at));
}
let listSeq = 0;

// `focus`: the path of the row to focus afterwards, or true for the first.
// Without it, a row that had focus keeps it across the redraw.
async function renderFileList(s, focus) {
  const roots = await loadRoots(s);
  const root = roots.find((r) => r.id === state.filesRoot[s.key]) || roots[0];
  const dir = state.filesPath[`${s.key}:${root.id}`] || '';
  const q = (state.filesQuery[`${s.key}:${root.id}`] || '').trim();
  const searching = q.length >= SEARCH_MIN;
  const seq = ++listSeq;
  const d = await api(`/api/sessions/${s.key}/${searching ? 'search' : 'files'}?root=${root.id}&path=${encodeURIComponent(dir)}${searching ? `&q=${encodeURIComponent(q)}` : ''}`);
  const el = filesPane(s, 'files-entries');
  if (seq !== listSeq || !onFiles(s) || !el) return;
  const input = filesPane(s, 'files-q');
  if (input && document.activeElement !== input) input.value = state.filesQuery[`${s.key}:${root.id}`] || '';
  if (focus == null && el.contains(document.activeElement)) focus = rowPath(document.activeElement.closest('.file-row'));
  const pv = state.preview?.key === s.key && state.preview.root === root.id ? state.preview.path : null;
  const parts = d.path ? d.path.split('/') : [];
  let crumbs = `<a data-dir="">${esc(shortPath(d.cwd).split(/[\\/]/).pop() || d.cwd)}</a>`;
  parts.forEach((p, i) => (crumbs += ` / <a data-dir="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</a>`));
  let html = '';
  if (roots.length > 1) {
    html += `<div class="roots">${roots.map((r) => `<button class="chip${r.id === root.id ? ' active' : ''}" data-pick-root="${esc(r.id)}" title="${esc(r.path)}">${esc(r.name)}${changedIn(r) ? '' : ` <span class="muted">${tr('files.read')}</span>`}</button>`).join('')}</div>`;
  }
  html += `<div data-root="${esc(root.id)}"><div class="crumbs">${crumbs}</div>`;
  if (searching) {
    html += `<div class="crumbs">${crumbs} <span class="muted">· ${tr(d.truncated ? 'files.foundMany' : 'files.found', d.files.length)}</span></div>`;
    const strip = d.path ? d.path.length + 1 : 0;
    for (const f of d.files) {
      html += `<button class="file-row${f.path === pv ? ' active' : ''}" data-open="${esc(f.path)}"><span class="icon"></span><span class="grow">${esc(f.path.slice(strip))}</span><span class="badge">${f.count}</span></button>`;
      html += f.hits.map((h) => `<div class="hit" data-hit="${esc(f.path)}"><span class="hit-ln">${h.line}</span>${markHits(h.text, q)}</div>`).join('');
      if (f.count > f.hits.length) html += `<div class="hit muted" data-hit="${esc(f.path)}"><span class="hit-ln"></span>${tr('files.more', f.count - f.hits.length)}</div>`;
    }
    if (!d.files.length) html += `<div class="panel-msg">${tr('files.none')}</div>`;
  } else if (d.path) html += `<button class="file-row up" data-dir="${esc(parts.slice(0, -1).join('/'))}"><span class="icon">↑</span><span class="grow">..</span></button>`;
  for (const e of searching ? [] : d.entries) {
    const p = d.path ? `${d.path}/${e.name}` : e.name;
    html += e.dir
      ? `<button class="file-row" data-dir="${esc(p)}"><span class="icon">▸</span><span class="grow">${esc(e.name)}/</span></button>`
      : `<button class="file-row${p === pv ? ' active' : ''}" data-open="${esc(p)}"><span class="icon"></span><span class="grow">${esc(e.name)}</span></button>`;
  }
  el.innerHTML = html + '</div>';
  renderNav(s);
  if (focus == null) return;
  const rows = [...el.querySelectorAll('.file-row')];
  const row = focus === true ? rows.find((r) => !r.classList.contains('up')) || rows[0] : rows.find((r) => rowPath(r) === focus);
  row?.focus();
  row?.scrollIntoView({ block: 'nearest' });
}

function openDir(s, root, dir, focus) {
  state.filesPath[`${s.key}:${root}`] = dir;
  return renderFileList(s, focus);
}

function openPreview(s, root, path) {
  state.preview = { key: s.key, root, path, source: false };
  const list = filesPane(s, 'files-list');
  const inRoot = list?.querySelector(`[data-root="${CSS.escape(root)}"]`);
  list?.querySelectorAll('.file-row.active').forEach((r) => r.classList.remove('active'));
  const row = inRoot && [...inRoot.querySelectorAll('[data-open]')].find((r) => r.dataset.open === path);
  row?.classList.add('active');
  row?.scrollIntoView({ block: 'nearest' });
  return renderPreview(s);
}

// The previewed file's place among the files of the folder the list shows,
// or null when the list is somewhere else.
function siblings(s) {
  const pv = state.preview;
  const list = pv?.key === s.key && filesPane(s, 'files-list')?.querySelector(`[data-root="${CSS.escape(pv.root)}"]`);
  if (!list) return null;
  const paths = [...list.querySelectorAll('[data-open]')].map((r) => r.dataset.open);
  const i = paths.indexOf(pv.path);
  return i < 0 ? null : { paths, i };
}

// ‹ 3 / 12 › in the preview bar, to step through the folder without the list.
function renderNav(s) {
  const el = filesPane(s, 'files-preview')?.querySelector('.pv-nav');
  if (!el) return;
  const at = siblings(s);
  el.innerHTML = at && at.paths.length > 1
    ? `<button class="btn small" data-step="-1" title="${esc(tr('preview.prev'))}"${at.i === 0 ? ' disabled' : ''}>‹</button><span class="muted">${at.i + 1} / ${at.paths.length}</span><button class="btn small" data-step="1" title="${esc(tr('preview.next'))}"${at.i === at.paths.length - 1 ? ' disabled' : ''}>›</button>`
    : '';
}

function stepPreview(s, step) {
  const at = siblings(s);
  const path = at?.paths[at.i + step];
  if (path) openPreview(s, state.preview.root, path);
}

// While arrowing through a folder, wait for a pause before loading the file.
let previewTimer = null;
function previewSoon(s, root, path) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => openPreview(s, root, path).catch(() => {}), 120);
}

const REF_GROUPS = [
  ['refs.prs', (r) => r.kind === 'pr'],
  ['refs.issues', (r) => r.kind === 'issue' || r.kind === 'workitem'],
  ['refs.commits', (r) => r.kind === 'commit'],
  ['refs.links', (r) => r.kind === 'url'],
];
const REF_KIND = { pr: 'PR', issue: 'Issue', workitem: 'Work item' };

function refHtml(r) {
  const link = (text, cls = '') => (r.url ? `<a class="ref-label ${cls}" href="${esc(r.url)}" target="_blank" rel="noopener">${text}</a>` : `<span class="ref-label ${cls}">${text}</span>`);
  let main;
  let sub = r.context;
  let copy = r.url || r.label;
  if (r.kind === 'commit') {
    main = `${link(`<code>${esc(r.hash)}</code>`)} <span class="ref-text">${esc(r.label || '')}</span>`;
    sub = r.branch ? `⎇ ${r.branch}` : r.context;
    copy = r.hash;
  } else if (r.kind === 'url') {
    main = link(esc(r.label || r.url.replace(/^https?:\/\//, '')), r.label ? '' : 'mono');
    if (r.label) sub = r.url;
  } else {
    main = `${link(`${REF_KIND[r.kind]} ${esc(r.label)}`)}${r.title ? ` <span class="ref-text">${esc(r.title)}</span>` : ''}`;
  }
  const when = `${r.source ? tr(`refs.src.${r.source}`) : ''}${r.lastAt ? ` · ${ago(r.lastAt)}` : ''}${r.count > 1 ? ` · ${r.count}×` : ''}`;
  return `<div class="ref-row">
    <div class="ref-main"><span class="grow">${main}</span><button class="btn small" data-copy="${esc(copy)}" title="${esc(tr('refs.copyTitle', copy))}">${tr('refs.copy')}</button></div>
    <div class="ref-sub"><span class="grow" title="${esc(sub || '')}">${esc(sub || '')}</span><span>${esc(when)}</span></div>
  </div>`;
}

function renderRefList(refs) {
  const f = state.refsFilter.toLowerCase();
  const match = (r) => !f || [r.label, r.title, r.url, r.context, r.hash, r.repo].some((v) => v && v.toLowerCase().includes(f));
  let html = '';
  for (const [label, test] of REF_GROUPS) {
    const items = refs.filter((r) => test(r) && match(r));
    if (items.length) html += `<div class="group-label ref-group">${tr(label)} <span>${items.length}</span></div>${items.map(refHtml).join('')}`;
  }
  if (html) return html;
  return `<div class="panel-msg">${tr(refs.length ? 'refs.noMatch' : 'refs.none')}</div>`;
}

async function renderRefs(s, body) {
  const d = await api(`/api/sessions/${s.key}/refs`);
  if (state.selected !== s.key || state.tab !== 'refs') return;
  state.refs = d.refs;
  // Keep the filter field (and its focus) when the list refreshes.
  if (body.querySelector(`#refs-filter[data-key="${CSS.escape(s.key)}"]`)) {
    $('#refs-list').innerHTML = renderRefList(d.refs);
    return;
  }
  body.innerHTML = `<div class="crumbs"><input id="refs-filter" data-key="${esc(s.key)}" type="search" placeholder="${esc(tr('refs.filter'))}" value="${esc(state.refsFilter)}" autocomplete="off" spellcheck="false"></div>
    <div id="refs-list">${renderRefList(d.refs)}</div>`;
}

const ext = (p) => (p.match(/\.([^./]+)$/)?.[1] || '').toLowerCase();
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);

const MD_STYLE = `<style>
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 860px; margin: 0 auto; padding: 24px; color: #1f1e1c; background: #fff; }
  pre { background: #f4f3ef; padding: 12px; overflow-x: auto; border-radius: 6px; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .9em; }
  :not(pre) > code { background: #f4f3ef; padding: 1px 4px; border-radius: 3px; }
  table { border-collapse: collapse; } td, th { border: 1px solid #ddd; padding: 4px 8px; }
  img { max-width: 100%; } blockquote { border-left: 3px solid #ddd; margin: 0; padding-left: 12px; color: #555; }
  a { color: #c2603f; }
  .mermaid { margin: 1em 0; text-align: center; overflow-x: auto; } .mermaid svg { max-width: 100%; height: auto; }
  .mermaid-error { color: #b3261e; font-size: .85em; margin: -.5em 0 1em; }
</style>`;

// Mermaid is large, so it loads the first time a preview has a diagram.
let mermaidLib = null;
function loadMermaid() {
  mermaidLib ||= import('/vendor/mermaid/mermaid.esm.min.mjs').then(({ default: m }) => {
    m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
    return m;
  });
  return mermaidLib;
}

// Draw the ```mermaid blocks in rendered markdown as SVG here, so the preview
// frame itself still runs no scripts. A diagram that fails keeps its source.
let mermaidSeq = 0;
async function drawMermaid(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const blocks = [...tpl.content.querySelectorAll('pre > code.language-mermaid')];
  if (!blocks.length) return html;
  const m = await loadMermaid();
  for (const code of blocks) {
    const id = `mmd-${++mermaidSeq}`;
    const pre = code.parentElement;
    try {
      const { svg } = await m.render(id, code.textContent);
      const div = document.createElement('div');
      div.className = 'mermaid';
      div.innerHTML = svg;
      pre.replaceWith(div);
    } catch (err) {
      document.getElementById(`d${id}`)?.remove(); // mermaid's scratch element
      const note = document.createElement('div');
      note.className = 'mermaid-error';
      note.textContent = tr('preview.mermaidError', String(err?.message || err).split('\n')[0]);
      pre.after(note);
    }
  }
  return tpl.innerHTML;
}

let previewSeq = 0; // the newest preview asked for; older ones that load late are dropped

async function renderPreview(s) {
  const body = filesPane(s, 'files-preview');
  if (!body) return;
  const seq = ++previewSeq;
  const pv = state.preview?.key === s.key ? state.preview : null;
  // "Large view" hides the list; it only makes sense with something to show.
  filesPane(s, 'files-split').classList.toggle('max', !!pv && !!state.previewMax);
  if (!pv) {
    body.innerHTML = `<div class="panel-msg">${tr('preview.pick')}</div>`;
    return;
  }
  const url = rawUrl(s.key, pv.root, pv.path);
  const e = ext(pv.path);
  const isMd = e === 'md' || e === 'markdown' || e === 'mmd' || e === 'mermaid';
  const isHtml = e === 'html' || e === 'htm';
  const rootName = pv.root !== 'main' && (state.roots[s.key] || []).find((r) => r.id === pv.root)?.name;
  const bar = `<div class="preview-bar"><span class="grow">${rootName ? `${esc(rootName)} / ` : ''}${esc(pv.path)}</span>
    ${isMd || isHtml ? `<button class="btn small" id="src-btn">${tr(pv.source ? 'preview.rendered' : 'preview.source')}</button>` : ''}
    <span class="pv-nav"></span>
    <a href="${esc(url)}" target="_blank" rel="noopener">${tr('preview.newTab')}</a>
    <button class="btn small" id="max-btn" title="${esc(tr(state.previewMax ? 'preview.restore' : 'preview.max'))}">${state.previewMax ? '⤡' : '⤢'}</button></div>`;
  const show = (html) => (body.innerHTML = `${bar}<div class="preview-body">${html}</div>`);

  if (isHtml && !pv.source) {
    show(`<iframe class="preview-frame" sandbox="allow-scripts allow-forms" src="${esc(url)}"></iframe>`);
  } else if (IMAGE.has(e)) {
    show(`<img class="preview-img" src="${esc(url)}" alt="${esc(pv.path)}">`);
  } else if (e === 'pdf') {
    show(`<div class="panel-msg">${tr('preview.pdf')}</div>`);
  } else {
    const text = await api(`/api/sessions/${s.key}/file?root=${pv.root}&path=${encodeURIComponent(pv.path)}`).then((t) => (typeof t === 'string' ? t : JSON.stringify(t, null, 2)));
    if (seq !== previewSeq || !onFiles(s)) return;
    if (isMd && !pv.source) {
      // Rendered without scripts; <base> makes relative images resolve to the session's files.
      const dir = pv.path.includes('/') ? pv.path.slice(0, pv.path.lastIndexOf('/') + 1) : '';
      // A .mmd file is one diagram: render it as a markdown block holding it.
      const md = e === 'mmd' || e === 'mermaid' ? `<pre><code class="language-mermaid">${esc(text)}</code></pre>` : marked.parse(text);
      const html = await drawMermaid(md);
      if (seq !== previewSeq || !onFiles(s)) return;
      const doc = `<!doctype html><meta charset="utf-8"><base href="${esc(location.origin + rawUrl(s.key, pv.root, dir || '.') + (dir ? '' : '/'))}" target="_blank">${MD_STYLE}${html}`;
      show('<iframe class="preview-frame" sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe>');
      body.querySelector('iframe').srcdoc = doc;
    } else {
      show(`<pre class="preview-text">${esc(text)}</pre>`);
    }
  }
  renderNav(s);
  body.querySelector('#src-btn')?.addEventListener('click', () => {
    pv.source = !pv.source;
    renderPreview(s);
  });
  body.querySelector('#max-btn').addEventListener('click', () => {
    state.previewMax = !state.previewMax;
    store.set('previewMax', state.previewMax);
    renderPreview(s);
  });
}

// The comment being written: keep its text, Ctrl+Enter saves, Esc drops it.
$('#panel-body').addEventListener('keydown', (e) => {
  const s = current();
  if (!e.target.matches('.dc-edit textarea') || !s) return;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveDraft(s);
  else if (e.key === 'Escape') {
    state.draft = null;
    paintDiff(s);
  } else return;
  e.preventDefault();
});
// The search box above the file list: a pause in typing searches the folder
// the list shows, ↓/Enter moves into the hits, Esc clears it.
let searchTimer = null;
function searchSoon(value) {
  const s = current();
  if (!s) return;
  const root = filesPane(s, 'files-entries')?.querySelector('[data-root]')?.dataset.root || 'main';
  state.filesQuery[`${s.key}:${root}`] = value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderFileList(s).catch(() => {}), 250);
}
$('#panel-body').addEventListener('keydown', (e) => {
  if (!e.target.matches('.files-q')) return;
  const s = current();
  if (!s) return;
  if (e.key === 'ArrowDown' || e.key === 'Enter') {
    const row = e.target.closest('.files-list').querySelector('.files-entries .file-row:not(.up)');
    row?.focus();
    if (row?.dataset.open) previewSoon(s, row.closest('[data-root]').dataset.root, row.dataset.open);
  } else if (e.key === 'Escape' && e.target.value) {
    e.target.value = '';
    searchSoon('');
  } else return;
  e.preventDefault();
});
// Shift+click on a line number stretches the comment; don't select text too.
$('#panel-body').addEventListener('mousedown', (e) => {
  if (e.shiftKey && e.target.closest('.ln')) e.preventDefault();
});

$('#panel-body').addEventListener('input', (e) => {
  if (e.target.matches('.dc-edit textarea')) {
    if (state.draft) state.draft.text = e.target.value;
    return;
  }
  if (e.target.matches('.files-q')) return searchSoon(e.target.value);
  if (e.target.id !== 'refs-filter') return;
  state.refsFilter = e.target.value;
  $('#refs-list').innerHTML = renderRefList(state.refs || []);
});

$('#panel-body').addEventListener('click', (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    navigator.clipboard.writeText(copy.dataset.copy).then(() => {
      copy.textContent = tr('refs.copied');
      setTimeout(() => (copy.textContent = tr('refs.copy')), 1500);
    });
    return;
  }
  const s = current();
  const dc = e.target.closest('[data-dc]');
  if (dc && s) return commentAction(s, dc, e);
  const step = e.target.closest('[data-step]');
  if (step && s) return stepPreview(s, Number(step.dataset.step));
  const pick = e.target.closest('[data-pick-root]');
  if (pick && s) {
    state.filesRoot[s.key] = pick.dataset.pickRoot;
    return renderFileList(s);
  }
  const root = e.target.closest('[data-root]')?.dataset.root || 'main';
  const hit = e.target.closest('[data-hit]');
  if (hit && s) return openPreview(s, root, hit.dataset.hit);
  const open = e.target.closest('[data-open]');
  if (open && s) {
    e.preventDefault();
    const path = open.dataset.open;
    if (state.tab === 'files') return openPreview(s, root, path);
    // From Diff: show the file under Files, with the list in its folder.
    state.preview = { key: s.key, root, path, source: false };
    state.filesRoot[s.key] = root;
    state.filesPath[`${s.key}:${root}`] = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    return setTab('files');
  }
  const dir = e.target.closest('[data-dir]');
  // e.detail is 0 for Enter/Space, so the keyboard lands in the new folder.
  if (dir && s) openDir(s, root, dir.dataset.dir, e.detail === 0 ? true : undefined);
});

// Arrow keys in the file list: ↑/↓ move and preview, →/Enter open a folder,
// ←/Backspace go up a level.
$('#panel-body').addEventListener('keydown', (e) => {
  const row = e.target.closest?.('.files-list .file-row');
  const s = current();
  if (!row || !s || e.altKey || e.ctrlKey || e.metaKey) return;
  const rows = [...row.closest('.files-list').querySelectorAll('.file-row')];
  const root = row.closest('[data-root]').dataset.root;
  const dir = state.filesPath[`${s.key}:${root}`] || '';
  const go = (r) => {
    if (!r) return;
    r.focus();
    r.scrollIntoView({ block: 'nearest' });
    if (r.dataset.open) previewSoon(s, root, r.dataset.open);
  };
  const i = rows.indexOf(row);
  if (e.key === 'ArrowDown') go(rows[i + 1]);
  else if (e.key === 'ArrowUp') i ? go(rows[i - 1]) : row.closest('.files-list').querySelector('.files-q')?.focus();
  else if (e.key === 'Home') go(rows[0]);
  else if (e.key === 'End') go(rows.at(-1));
  else if (e.key === 'ArrowRight' && row.dataset.dir != null && !row.classList.contains('up')) openDir(s, root, row.dataset.dir, true);
  else if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && dir) openDir(s, root, dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '', dir);
  else return;
  e.preventDefault();
});

// The split between the file list and the preview, along whichever way it runs.
$('#panel-body').addEventListener('pointerdown', (e) => {
  const gutter = e.target.closest('.files-gutter');
  if (!gutter) return;
  const split = gutter.parentElement;
  const across = getComputedStyle(split).flexDirection === 'row';
  const box = split.getBoundingClientRect();
  let pct = null;
  gutter.setPointerCapture(e.pointerId);
  gutter.classList.add('dragging');
  const move = (ev) => {
    const at = across ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height;
    pct = Math.round(Math.min(Math.max(at, 0.15), 0.85) * 100);
    split.style.setProperty('--files-list', `${pct}%`);
  };
  gutter.addEventListener('pointermove', move);
  gutter.addEventListener('pointerup', () => {
    gutter.classList.remove('dragging');
    gutter.removeEventListener('pointermove', move);
    if (pct != null) store.set('filesSplit', pct);
  }, { once: true });
});

// Read-only folders under Diff load their diff when expanded. `toggle` does
// not bubble, hence the capture.
$('#panel-body').addEventListener('toggle', (e) => {
  const r = e.target.dataset?.rootToggle;
  const s = current();
  if (!r || !s) return;
  const k = `${s.key}:${r}`;
  if (e.target.open === state.openRoots.has(k)) return; // set by our own render
  if (e.target.open) state.openRoots.add(k);
  else state.openRoots.delete(k);
  if (e.target.open) renderPanel();
}, true);

// Resizable panel.
(() => {
  const split = $('#splitter');
  const saved = store.get('panelWidth', null);
  if (saved) $('#panel').style.setProperty('--panel-w', `${saved}px`);
  split.addEventListener('pointerdown', (e) => {
    split.setPointerCapture(e.pointerId);
    split.classList.add('dragging');
    const ws = $('#workspace').getBoundingClientRect();
    const move = (ev) => {
      const w = Math.min(Math.max(ws.right - ev.clientX, 260), ws.width - 200);
      $('#panel').style.setProperty('--panel-w', `${w}px`);
    };
    const up = () => {
      split.classList.remove('dragging');
      split.removeEventListener('pointermove', move);
      store.set('panelWidth', $('#panel').getBoundingClientRect().width);
    };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', up, { once: true });
  });
})();

// ---- attention: tab title + desktop notifications --------------------------

const canNotify = 'Notification' in window && window.isSecureContext;
let lastStates = null; // session key -> state, from the previous poll

const notes = new Map(); // session key -> its open desktop notification

function notify(s, text) {
  if (!canNotify || Notification.permission !== 'granted') return;
  if (!document.hidden && s.key === state.selected) return;
  const n = new Notification(s.title || s.project || tr('notify.session'), { body: text, tag: s.key });
  notes.set(s.key, n);
  n.onclose = () => notes.get(s.key) === n && notes.delete(s.key);
  n.onclick = () => {
    window.focus();
    select(s.key);
    n.close();
  };
}

// Once you have seen the session, its notification has done its job.
function closeNote(key) {
  notes.get(key)?.close();
}

// Sessions that need you: blocked ones first, then finished turns you have
// not seen yet, each longest-waiting first.
function needsYou() {
  const rank = (s) => (s.state === 'waiting' ? 0 : s.state === 'idle' && s.stateAt && !isSeen(s) ? 1 : -1);
  return state.sessions
    .filter((s) => rank(s) >= 0)
    .sort((a, b) => rank(a) - rank(b) || (a.stateAt || 0) - (b.stateAt || 0));
}

// Ctrl+. jumps to the next session that needs you, in turn.
function nextAttention() {
  const list = needsYou();
  if (!list.length) return;
  const i = list.findIndex((s) => s.key === state.selected);
  select(list[(i + 1) % list.length].key);
  $('#session-list .item.selected')?.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'Period') {
    e.preventDefault();
    nextAttention();
  }
});

function watchStates(sessions) {
  if (lastStates) {
    for (const s of sessions) {
      const before = lastStates.get(s.key);
      if (before === s.state) continue;
      if (s.state === 'waiting') notify(s, tr('notify.waiting'));
      else if (s.state === 'idle' && before === 'working') notify(s, tr('notify.done'));
    }
  }
  lastStates = new Map(sessions.map((s) => [s.key, s.state]));
}

// The tab title counts what needs you: "(1! 2✓) cc-dash" for one blocked
// session and two finished turns you have not seen.
function renderTitle() {
  const waiting = state.sessions.filter((s) => s.state === 'waiting').length;
  const done = state.sessions.filter((s) => s.state === 'idle' && s.stateAt && !isSeen(s)).length;
  const parts = [waiting && `${waiting}!`, done && `${done}✓`].filter(Boolean);
  document.title = parts.length ? `(${parts.join(' ')}) cc-dash` : 'cc-dash';
}

$('#side-foot').addEventListener('click', (e) => {
  if (e.target.closest('#lang-btn')) return switchLang();
  if (!e.target.closest('#notify-btn')) return;
  Notification.requestPermission().then(renderSidebar);
});

// ---- language --------------------------------------------------------------

function switchLang() {
  setLang(getLang() === 'no' ? 'en' : 'no');
  store.set('lang', getLang());
  closeMenu();
  renderSidebar();
  renderMain();
  renderPanel();
}

// ---- polling ---------------------------------------------------------------

async function refresh() {
  let data;
  try {
    data = await api('/api/sessions');
  } catch (e) {
    if (e.status === 401) location.reload();
    return;
  }
  const prev = current();
  state.sessions = data.sessions;
  state.info = { host: data.host, platform: data.platform, hooks: data.hooks, token: data.token, profiles: data.profiles };
  // After /resume or /clear the terminal runs another session: stay with it.
  const moved = !current() && prev?.managedId && state.sessions.find((s) => s.managedId === prev.managedId);
  if (moved) {
    state.selected = moved.key;
    store.set('selected', moved.key);
  }
  watchStates(state.sessions);
  markSeen();

  // Drop terminals for sessions that are gone.
  const runningIds = new Set(state.sessions.filter((s) => s.running).map((s) => s.managedId));
  for (const id of [...state.terms.keys()]) if (!runningIds.has(id)) disposeTerm(id);

  renderSidebar();
  const s = current();
  const runningChanged = (prev?.running ?? null) !== (s?.running ?? null);
  if (runningChanged || !s || !s.running) renderMain();
  else renderHead(s);
  if (moved && state.panelOpen) renderPanel();

  // Keep the diff fresh while Claude is working on the selected session, but
  // not under a comment being written.
  const writing = state.draft?.key === s?.key;
  if (state.panelOpen && state.tab === 'diff' && s && !writing && (s.lastAt !== prev?.lastAt || s.state !== prev?.state) && Date.now() - state.lastDiffAt > 3000) {
    renderPanel();
  } else if (state.panelOpen && state.tab === 'diff' && s && s.state !== prev?.state && state.comments[s.key]?.length) {
    paintDiff(s); // the Send button depends on the state
  }
  // New messages may have new links.
  if (state.panelOpen && state.tab === 'refs' && s && s.lastAt !== prev?.lastAt) renderPanel();
}

setLang(store.get('lang', null));
setPanel(state.panelOpen);
await refresh();
renderMain();
setInterval(refresh, POLL_MS);

// Coming back to the tab counts as seeing the selected session.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  markSeen();
  renderSidebar();
  renderHead(current());
});
