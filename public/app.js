import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links.mjs';
import { SearchAddon } from '/vendor/addon-search.mjs';
import { Unicode11Addon } from '/vendor/addon-unicode11.mjs';
import { marked } from '/vendor/marked.esm.js';

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
  panelOpen: store.get('panelOpen', false),
  tab: store.get('tab', 'diff'),
  roots: {}, // session key -> the folders it works in (cwd first), see folders.js
  filesRoot: {}, // session key -> root id shown under Files
  filesPath: {}, // `${session key}:${root id}` -> current dir
  openRoots: new Set(), // `${session key}:${root id}` of read-only folders expanded under Diff
  preview: null, // { key, root, path }
  resumeProfile: {}, // session key -> profile id picked for "Fortsett her"
  refsFilter: '',
  terms: new Map(), // managedId -> { term, fit, ws, el, exited }
  lastDiffAt: 0,
};

// ---- helpers ---------------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function ago(t) {
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'nå';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} t`;
  return `${Math.floor(s / 86400)} d`;
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
  if (p?.tag) html += `<span class="profile tagged" style="--tag:${esc(tagColor(s))}" title="Profil: ${esc(p.name)}">${esc(p.tag)}</span>`;
  else if (p && !s.shell && p !== profiles().find((x) => x.claude)) html += `<span class="profile">${esc(p.name)}</span>`;
  if (s.shell) html += '<span class="profile">terminal</span>';
  return html;
}

const STATE_LABEL ={ working: 'jobber', waiting: 'venter på deg', idle: 'din tur', ended: 'avsluttet' };

// How long a session has been waiting for the user: 0:42, 12:05, 1 t 20 min.
function waited(t) {
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(s / 3600)} t ${Math.floor((s % 3600) / 60)} min`;
}

function stateHtml(s) {
  if (!s.state || s.state === 'ended') return '';
  const label = s.state === 'working' && s.stateDetail ? `jobber · ${s.stateDetail}` : STATE_LABEL[s.state];
  const timer = (s.state === 'idle' || s.state === 'waiting') && s.stateAt
    ? ` · <span class="since" data-since="${s.stateAt}" title="Har ventet på deg siden ${esc(new Date(s.stateAt).toLocaleTimeString())}">${waited(s.stateAt)}</span>`
    : '';
  return `<span class="state s-${s.state}"><span class="dot"></span>${esc(label)}${timer}</span>`;
}

// Tick the wait counters between polls so they count by the second.
setInterval(() => {
  for (const el of document.querySelectorAll('.since')) el.textContent = waited(Number(el.dataset.since));
}, 1000);

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error || res.statusText);
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

function renderSidebar() {
  const f = state.filter.toLowerCase();
  const match = (s) => !f || [s.title, s.cwd, s.lastPrompt, s.gitBranch].some((v) => v && v.toLowerCase().includes(f));
  const groups = [
    ['Kjører her', state.sessions.filter((s) => s.running)],
    ['Åpne i andre terminaler', state.sessions.filter((s) => s.external)],
    ['Nylige', state.sessions.filter((s) => !s.running && !s.external)],
  ];
  let html = '';
  for (const [label, list] of groups) {
    const items = list.filter(match);
    if (!items.length) continue;
    html += `<div class="group-label">${label}</div>`;
    for (const s of items) {
      const title = s.title || (s.running ? 'Ny sesjon' : '(uten tittel)');
      html += `<div class="item${s.key === state.selected ? ' selected' : ''}${tagAttrs(s)}" data-key="${esc(s.key)}" role="button" tabindex="0">
        <div class="item-title" title="${esc(title)}">${esc(title)}</div>
        <div class="item-meta"><span class="grow" title="${esc(s.cwd)}">${profileBadge(s)}${esc(s.project || '')}${s.gitBranch ? ` · ${esc(s.gitBranch)}` : ''}</span><span class="cost">${money(s.costUsd, s.costIncomplete)}</span></div>
        <div class="item-sub"><span class="grow">${stateHtml(s) || esc(s.lastPrompt || '')}</span><span>${ago(s.lastAt)}</span></div>
        ${s.running ? `<button class="kill" data-kill="${esc(s.managedId)}" title="Avslutt sesjonen">×</button>` : ''}
      </div>`;
    }
  }
  $('#session-list').innerHTML = html || '<div class="panel-msg">Ingen sesjoner funnet.</div>';

  const live = state.sessions.filter((s) => s.running || s.external);
  const total = live.reduce((sum, s) => sum + (s.costUsd || 0), 0);
  let foot = `${live.length} aktive${total ? ` · ${money(total)}` : ''} · ${state.info.host === 'tmux' ? 'tmux' : 'pty'}`;
  if (state.info.hooks === false) foot += `<br>Live status: kjør <code>npm run setup</code>`;
  else if (canNotify && Notification.permission === 'default') {
    foot += `<br><button id="notify-btn" class="link-btn">Slå på varsler</button> når en sesjon venter på deg`;
  }
  $('#side-foot').innerHTML = foot;
}

$('#session-list').addEventListener('click', (e) => {
  const kill = e.target.closest('[data-kill]');
  if (kill) {
    e.stopPropagation();
    if (!kill.classList.contains('armed')) {
      kill.classList.add('armed');
      kill.textContent = 'avslutt?';
      setTimeout(() => {
        kill.classList.remove('armed');
        kill.textContent = '×';
      }, 3000);
      return;
    }
    api(`/api/sessions/${kill.dataset.kill}`, { method: 'DELETE' }).then(refresh, (err) => alertBox(err.message));
    return;
  }
  const item = e.target.closest('.item');
  if (item) select(item.dataset.key);
});
$('#session-list').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('item')) select(e.target.dataset.key);
});
$('#filter').addEventListener('input', (e) => {
  state.filter = e.target.value;
  renderSidebar();
});

// ---- main area -------------------------------------------------------------

function select(key) {
  const changed = key !== state.selected;
  state.selected = key;
  store.set('selected', key);
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
  $('#head-title').textContent = s.title || (s.running ? 'Ny sesjon' : '(uten tittel)');
  const extra = (state.roots[s.key] || []).filter((r) => !r.primary && r.writes);
  const meta = [
    profileBadge(s),
    s.cwd &&`<span class="path" title="${esc(s.cwd)}">${esc(shortPath(s.cwd))}</span>`,
    extra.length && `<span title="Sesjonen har også endret filer i:\n${esc(extra.map((r) => r.path).join('\n'))}">+ ${esc(extra.map((r) => r.name).join(', '))}</span>`,
    s.gitBranch && `<span>⎇ ${esc(s.gitBranch)}</span>`,
    s.model && `<span>${esc(s.model)}</span>`,
    s.costUsd && `<span title="Beregnet fra tokenbruk i transkriptet (API-listepris)">${money(s.costUsd, s.costIncomplete)}</span>`,
    s.contextPct != null && `<span>${Math.round(s.contextPct)}% kontekst</span>`,
    stateHtml(s),
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
    ? `<select id="resume-profile" class="profile-select" title="Profil">${claudeProfiles.map((p) => `<option value="${esc(p.id)}"${p.id === chosen ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`
    : '';
  $('#detail').innerHTML = `
    <h2>${esc(s.title || '(uten tittel)')}</h2>
    ${s.lastPrompt ? `<div class="prompt">${esc(s.lastPrompt)}</div>` : ''}
    <dl>
      <dt>Mappe</dt><dd>${esc(s.cwd || '–')}</dd>
      <dt>Sesjon</dt><dd>${esc(s.key)}</dd>
      ${s.model ? `<dt>Modell</dt><dd>${esc(s.model)}</dd>` : ''}
      ${s.costUsd ? `<dt>Pris</dt><dd>${money(s.costUsd, s.costIncomplete)}</dd>` : ''}
      ${s.startedAt ? `<dt>Startet</dt><dd>${new Date(s.startedAt).toLocaleString()}</dd>` : ''}
      ${s.lastAt ? `<dt>Sist aktiv</dt><dd>${new Date(s.lastAt).toLocaleString()}</dd>` : ''}
    </dl>
    ${canResume ? `${picker}<button class="btn primary" id="resume-btn">Fortsett her (claude --resume)</button>` : ''}
    ${s.external ? `<p class="note">Denne sesjonen kjører i en annen terminal. Lukk den der først hvis du vil fortsette den her, så ikke to prosesser jobber i samme sesjon.</p>
      ${picker}<button class="btn" id="resume-btn">Fortsett her likevel</button>` : ''}
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
      : !resultCount ? 'ingen treff' : resultIndex < 0 ? `${resultCount}+` : `${resultIndex + 1} / ${resultCount}`;
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
  t.term.write('\r\n\x1b[2m[sesjonen er avsluttet]\x1b[0m\r\n');
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
  if (!found) $('#search-count').textContent = 'ingen treff';
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
    return true;
  } catch (e) {
    return e.message;
  }
}

$('#new-btn').addEventListener('click', async () => {
  const dlg = $('#new-dialog');
  $('#new-error').hidden = true;
  const cur = current();
  const sel = $('#new-profile');
  const last = store.get('profile', null);
  sel.innerHTML = profiles()
    .map((p) => `<option value="${esc(p.id)}"${p.id === last ? ' selected' : ''}>${esc(p.name)}${p.claude ? '' : ' (terminal)'}</option>`)
    .join('');
  const prof = profiles().find((p) => p.id === sel.value);
  $('#new-cwd').value = prof?.cwd || cur?.cwd || '';
  markProfileSelect();
  $('#recent-dirs').innerHTML = '';
  dlg.showModal();
  $('#new-cwd').select();
  try {
    const { dirs } = await api('/api/dirs');
    $('#recent-dirs').innerHTML = dirs.map((d) => `<button type="button" data-dir="${esc(d)}">${esc(shortPath(d))}</button>`).join('')
      || '<div class="panel-msg">Ingen ennå</div>';
  } catch {}
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
    body.innerHTML = '<div class="panel-msg">Velg en sesjon.</div>';
    return;
  }
  const key = s.key;
  try {
    if (state.tab === 'diff') await renderDiff(s, body);
    else if (state.tab === 'files') await renderFiles(s, body);
    else if (state.tab === 'refs') await renderRefs(s, body);
    else await renderPreview(s, body);
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
  if (roots.length === 1) {
    body.innerHTML = rootDiffHtml(roots[0], diffs[0]);
    return;
  }
  let html = '';
  roots.forEach((r, i) => {
    const head = `${esc(r.name)}<span class="root-path">${esc(shortPath(r.path))}</span>`;
    if (changedIn(r)) html += `<section class="root"><div class="root-head" title="${esc(r.path)}">${head}</div>${rootDiffHtml(r, diffs[i])}</section>`;
    else {
      html += `<details class="root" data-root-toggle="${esc(r.id)}"${isOpen(r) ? ' open' : ''}>
        <summary class="root-head" title="${esc(r.path)}">${head} <span class="muted">· bare lest fra</span></summary>
        ${isOpen(r) ? rootDiffHtml(r, diffs[i]) : ''}</details>`;
    }
  });
  body.innerHTML = html;
}

// data-root tells the click handler which folder the paths inside belong to.
function rootDiffHtml(r, d) {
  return `<div data-root="${esc(r.id)}">${r.git ? diffHtml(d) : writtenHtml(r)}</div>`;
}

// A folder without git: the files the session wrote there, newest first.
function writtenHtml(r) {
  const files = r.written || [];
  let html = `<div class="diff-head">Ikke et git-repo${files.length ? ` · ${files.length} ${files.length === 1 ? 'fil' : 'filer'} endret i denne sesjonen` : ''}</div>`;
  for (const f of files) {
    html += `<button class="file-row" data-open="${esc(f.path)}"><span class="icon"></span><span class="grow">${esc(f.path)}</span><span class="badge">${ago(f.at)}</span></button>`;
  }
  return html;
}

function diffHtml(d) {
  if (!d.repo) return '<div class="panel-msg">Mappen er ikke et git-repo.</div>';
  if (!d.files.length) return `<div class="diff-head">⎇ ${esc(d.branch)} · ingen endringer</div>`;
  const untracked = d.files.filter((f) => f.status === '??');
  const blocks = d.diff.split(/^(?=diff --git )/m).filter((b) => b.startsWith('diff --git'));
  let html = `<div class="diff-head">⎇ ${esc(d.branch)} · ${d.files.length} filer endret</div>`;
  const toCwd = (f) => (d.prefix ? `${d.prefix}/${f}` : f);
  let lines = 0;
  for (const b of blocks) {
    const m = b.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const file = m ? m[2] : '?';
    const f = d.files.find((x) => x.path === file) || {};
    const rows = b.split('\n');
    const start = rows.findIndex((r) => r.startsWith('@@'));
    let body = '';
    if (start < 0) body = '<div class="hunk">(binærfil eller kun modusendring)</div>';
    else {
      for (const r of rows.slice(start)) {
        if (++lines > 20000) break;
        const cls = r.startsWith('@@') ? 'hunk' : r.startsWith('+') ? 'add' : r.startsWith('-') ? 'del' : '';
        body += `<div class="${cls}">${esc(r) || ' '}</div>`;
      }
    }
    html += `<details class="diff-file" open><summary>
      <span class="st st-${esc(f.status || 'M')}">${esc(f.status || 'M')}</span>
      <span class="grow">${esc(file)}</span>
      <span class="badge"><span class="a">+${f.add ?? 0}</span> <span class="d">−${f.del ?? 0}</span></span>
      <a data-open="${esc(toCwd(file))}">vis</a></summary><div class="diff-lines">${body}</div></details>`;
  }
  if (untracked.length) {
    html += `<div class="group-label" style="padding:12px">Nye filer (ikke i git ennå)</div>`;
    for (const f of untracked) {
      html += `<button class="file-row" data-open="${esc(toCwd(f.path))}"><span class="st st-??">??</span><span class="grow">${esc(f.path)}</span></button>`;
    }
  }
  return html;
}

async function renderFiles(s, body) {
  const roots = await loadRoots(s);
  const root = roots.find((r) => r.id === state.filesRoot[s.key]) || roots[0];
  const dir = state.filesPath[`${s.key}:${root.id}`] || '';
  const d = await api(`/api/sessions/${s.key}/files?root=${root.id}&path=${encodeURIComponent(dir)}`);
  if (state.selected !== s.key || state.tab !== 'files') return;
  const parts = d.path ? d.path.split('/') : [];
  let crumbs = `<a data-dir="">${esc(shortPath(d.cwd).split(/[\\/]/).pop() || d.cwd)}</a>`;
  parts.forEach((p, i) => (crumbs += ` / <a data-dir="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</a>`));
  let html = '';
  if (roots.length > 1) {
    html += `<div class="roots">${roots.map((r) => `<button class="chip${r.id === root.id ? ' active' : ''}" data-pick-root="${esc(r.id)}" title="${esc(r.path)}">${esc(r.name)}${changedIn(r) ? '' : ' <span class="muted">(lest)</span>'}</button>`).join('')}</div>`;
  }
  html += `<div data-root="${esc(root.id)}"><div class="crumbs">${crumbs}</div>`;
  if (d.path) html += `<button class="file-row" data-dir="${esc(parts.slice(0, -1).join('/'))}"><span class="icon">↑</span><span class="grow">..</span></button>`;
  for (const e of d.entries) {
    const p = d.path ? `${d.path}/${e.name}` : e.name;
    html += e.dir
      ? `<button class="file-row" data-dir="${esc(p)}"><span class="icon">▸</span><span class="grow">${esc(e.name)}/</span></button>`
      : `<button class="file-row" data-open="${esc(p)}"><span class="icon"></span><span class="grow">${esc(e.name)}</span></button>`;
  }
  body.innerHTML = html + '</div>';
}

const REF_GROUPS = [
  ['Pull requests', (r) => r.kind === 'pr'],
  ['Issues og work items', (r) => r.kind === 'issue' || r.kind === 'workitem'],
  ['Commits', (r) => r.kind === 'commit'],
  ['Lenker', (r) => r.kind === 'url'],
];
const REF_SOURCE = { user: 'deg', claude: 'Claude', command: 'kommando' };
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
  const when = `${REF_SOURCE[r.source] || ''}${r.lastAt ? ` · ${ago(r.lastAt)}` : ''}${r.count > 1 ? ` · ${r.count}×` : ''}`;
  return `<div class="ref-row">
    <div class="ref-main"><span class="grow">${main}</span><button class="btn small" data-copy="${esc(copy)}" title="Kopier ${esc(copy)}">Kopier</button></div>
    <div class="ref-sub"><span class="grow" title="${esc(sub || '')}">${esc(sub || '')}</span><span>${esc(when)}</span></div>
  </div>`;
}

function renderRefList(refs) {
  const f = state.refsFilter.toLowerCase();
  const match = (r) => !f || [r.label, r.title, r.url, r.context, r.hash, r.repo].some((v) => v && v.toLowerCase().includes(f));
  let html = '';
  for (const [label, test] of REF_GROUPS) {
    const items = refs.filter((r) => test(r) && match(r));
    if (items.length) html += `<div class="group-label ref-group">${label} <span>${items.length}</span></div>${items.map(refHtml).join('')}`;
  }
  if (html) return html;
  return `<div class="panel-msg">${refs.length ? 'Ingen treff.' : 'Ingen lenker, PR-er, work items eller commits i denne samtalen ennå.'}</div>`;
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
  body.innerHTML = `<div class="crumbs"><input id="refs-filter" data-key="${esc(s.key)}" type="search" placeholder="Filtrer lenker, PR-er, work items, commits…" value="${esc(state.refsFilter)}" autocomplete="off" spellcheck="false"></div>
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
</style>`;

async function renderPreview(s, body) {
  const pv = state.preview;
  if (!pv || pv.key !== s.key) {
    body.innerHTML = '<div class="panel-msg">Velg en fil under <b>Filer</b> eller <b>Diff</b> for å forhåndsvise den.</div>';
    return;
  }
  const url = rawUrl(s.key, pv.root, pv.path);
  const e = ext(pv.path);
  const isMd = e === 'md' || e === 'markdown';
  const isHtml = e === 'html' || e === 'htm';
  const rootName = pv.root !== 'main' && (state.roots[s.key] || []).find((r) => r.id === pv.root)?.name;
  const bar = `<div class="preview-bar"><span class="grow">${rootName ? `${esc(rootName)} / ` : ''}${esc(pv.path)}</span>
    ${isMd || isHtml ? `<button class="btn small" id="src-btn">${pv.source ? 'Vis rendret' : 'Vis kilde'}</button>` : ''}
    <a href="${esc(url)}" target="_blank" rel="noopener">Åpne i ny fane ↗</a></div>`;

  if (isHtml && !pv.source) {
    body.innerHTML = `${bar}<iframe class="preview-frame" sandbox="allow-scripts allow-forms" src="${esc(url)}"></iframe>`;
  } else if (IMAGE.has(e)) {
    body.innerHTML = `${bar}<img class="preview-img" src="${esc(url)}" alt="${esc(pv.path)}">`;
  } else if (e === 'pdf') {
    body.innerHTML = `${bar}<div class="panel-msg">PDF åpnes best i ny fane.</div>`;
  } else {
    const text = await api(`/api/sessions/${s.key}/file?root=${pv.root}&path=${encodeURIComponent(pv.path)}`).then((t) => (typeof t === 'string' ? t : JSON.stringify(t, null, 2)));
    if (state.selected !== s.key || state.tab !== 'preview') return;
    if (isMd && !pv.source) {
      // Rendered without scripts; <base> makes relative images resolve to the session's files.
      const dir = pv.path.includes('/') ? pv.path.slice(0, pv.path.lastIndexOf('/') + 1) : '';
      const doc = `<!doctype html><meta charset="utf-8"><base href="${esc(location.origin + rawUrl(s.key, pv.root, dir || '.') + (dir ? '' : '/'))}" target="_blank">${MD_STYLE}${marked.parse(text)}`;
      body.innerHTML = `${bar}<iframe class="preview-frame" sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe>`;
      body.querySelector('iframe').srcdoc = doc;
    } else {
      body.innerHTML = `${bar}<pre class="preview-text">${esc(text)}</pre>`;
    }
  }
  $('#src-btn')?.addEventListener('click', () => {
    pv.source = !pv.source;
    renderPanel();
  });
}

$('#panel-body').addEventListener('input', (e) => {
  if (e.target.id !== 'refs-filter') return;
  state.refsFilter = e.target.value;
  $('#refs-list').innerHTML = renderRefList(state.refs || []);
});

$('#panel-body').addEventListener('click', (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    navigator.clipboard.writeText(copy.dataset.copy).then(() => {
      copy.textContent = 'Kopiert ✓';
      setTimeout(() => (copy.textContent = 'Kopier'), 1500);
    });
    return;
  }
  const s = current();
  const pick = e.target.closest('[data-pick-root]');
  if (pick && s) {
    state.filesRoot[s.key] = pick.dataset.pickRoot;
    return renderPanel();
  }
  const root = e.target.closest('[data-root]')?.dataset.root || 'main';
  const open = e.target.closest('[data-open]');
  if (open && s) {
    e.preventDefault();
    state.preview = { key: s.key, root, path: open.dataset.open, source: false };
    return setTab('preview');
  }
  const dir = e.target.closest('[data-dir]');
  if (dir && s) {
    state.filesPath[`${s.key}:${root}`] = dir.dataset.dir;
    renderPanel();
  }
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

function notify(s, text) {
  if (!canNotify || Notification.permission !== 'granted') return;
  if (!document.hidden && s.key === state.selected) return;
  const n = new Notification(s.title || s.project || 'Claude-sesjon', { body: text, tag: s.key });
  n.onclick = () => {
    window.focus();
    select(s.key);
    n.close();
  };
}

function watchStates(sessions) {
  if (lastStates) {
    for (const s of sessions) {
      const before = lastStates.get(s.key);
      if (before === s.state) continue;
      if (s.state === 'waiting') notify(s, 'Venter på deg');
      else if (s.state === 'idle' && before === 'working') notify(s, 'Ferdig – din tur');
    }
  }
  lastStates = new Map(sessions.map((s) => [s.key, s.state]));
  const waiting = sessions.filter((s) => s.state === 'waiting').length;
  document.title = waiting ? `(${waiting}) cc-dash` : 'cc-dash';
}

$('#side-foot').addEventListener('click', (e) => {
  if (!e.target.closest('#notify-btn')) return;
  Notification.requestPermission().then(renderSidebar);
});

// ---- polling ---------------------------------------------------------------

async function refresh() {
  let data;
  try {
    data = await api('/api/sessions');
  } catch (e) {
    if (String(e.message).includes('innlogget')) location.reload();
    return;
  }
  const prev = current();
  state.sessions = data.sessions;
  state.info = { host: data.host, platform: data.platform, hooks: data.hooks, token: data.token, profiles: data.profiles };
  watchStates(state.sessions);

  // Drop terminals for sessions that are gone.
  const runningIds = new Set(state.sessions.filter((s) => s.running).map((s) => s.managedId));
  for (const id of [...state.terms.keys()]) if (!runningIds.has(id)) disposeTerm(id);

  renderSidebar();
  const s = current();
  const runningChanged = (prev?.running ?? null) !== (s?.running ?? null);
  if (runningChanged || !s || !s.running) renderMain();
  else renderHead(s);

  // Keep the diff fresh while Claude is working on the selected session.
  if (state.panelOpen && state.tab === 'diff' && s && (s.lastAt !== prev?.lastAt || s.state !== prev?.state) && Date.now() - state.lastDiffAt > 3000) {
    renderPanel();
  }
  // New messages may have new links.
  if (state.panelOpen && state.tab === 'refs' && s && s.lastAt !== prev?.lastAt) renderPanel();
}

setPanel(state.panelOpen);
await refresh();
renderMain();
setInterval(refresh, POLL_MS);
