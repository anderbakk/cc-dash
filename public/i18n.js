// UI strings in English and Norwegian. An entry is a string, or a function
// for the ones that take values (counts, names).

const STRINGS = {
  en: {
    'lang.name': 'English',
    'lang.switch': 'Norsk',
    'lang.switchTitle': 'Bytt til norsk',

    'time.now': 'now',
    'time.min': (n) => `${n} min`,
    'time.hours': (n) => `${n} h`,
    'time.days': (n) => `${n} d`,
    'time.hoursMin': (h, m) => `${h} h ${m} min`,

    'state.working': 'working',
    'state.waiting': 'waiting for you',
    'state.idle': 'your turn',
    'state.ended': 'ended',
    'state.workingOn': (d) => `working · ${d}`,
    'state.waitingSince': (t) => `Waiting for you since ${t}`,
    'state.doneAt': (t) => `Finished at ${t}`,
    'state.took': (d) => `took ${d}`,

    'profile.title': (name) => `Profile: ${name}`,

    'session.new': 'New session',
    'session.untitled': '(untitled)',
    'session.more': 'More options',
    'session.kill': 'End the session',
    'session.killConfirm': 'end?',

    'side.newBtn': '+ New session',
    'side.newBtnTitle': 'Start a new Claude session or terminal',
    'side.filter': 'Filter sessions…',
    'side.unknownFolder': '(unknown folder)',
    'side.runningHere': 'Running here',
    'side.external': 'Open in other terminals',
    'side.recent': 'Recent',
    'side.groupCount': (n) => `${n} sessions`,
    'side.live': 'Active',
    'side.earlier': 'Earlier',
    'side.showOlder': (n) => `Show ${n} older`,
    'side.showFewer': 'Show fewer',
    'side.none': 'No sessions found.',
    'side.byFolder': '⇅ Folder',
    'side.byStatus': '⇅ Status',
    'side.byFolderTitle': 'Grouped by folder. Click to group by status.',
    'side.byStatusTitle': 'Grouped by status. Click to group by folder.',
    'side.active': (n) => `${n} active`,
    'side.hooks': 'Live status: run <code>npm run setup</code>',
    'side.notify': '<button id="notify-btn" class="link-btn">Turn on notifications</button> when a session is waiting for you',

    'menu.claude': 'New Claude session here',
    'menu.shell': 'New terminal here',
    'menu.pick': 'New session here with another profile…',
    'menu.copy': 'Copy path',
    'menu.unread': 'Mark as unread',
    'menu.read': 'Mark as read',

    'head.panel': 'Panel',
    'head.panelTitle': 'Show/hide panel (diff, files, preview)',
    'head.alsoChanged': (paths) => `The session also changed files in:\n${paths}`,
    'head.costTitle': 'Calculated from token usage in the transcript (API list price)',
    'head.context': (n) => `${n}% context`,

    'empty.title': 'Pick a session',
    'empty.body': '…or start a new one with <b>+ New session</b>.',

    'detail.folder': 'Folder',
    'detail.session': 'Session',
    'detail.model': 'Model',
    'detail.cost': 'Cost',
    'detail.started': 'Started',
    'detail.lastActive': 'Last active',
    'detail.profile': 'Profile',
    'detail.resume': 'Continue here (claude --resume)',
    'detail.externalNote': 'This session is running in another terminal. Close it there first if you want to continue it here, so two processes are not working in the same session.',
    'detail.resumeAnyway': 'Continue here anyway',

    'term.ended': '[the session has ended]',
    'search.placeholder': 'Search the terminal…',
    'search.prev': 'Previous (Shift+Enter)',
    'search.next': 'Next (Enter)',
    'search.close': 'Close (Esc)',
    'search.none': 'no matches',

    'new.title': 'New session',
    'new.profile': 'Profile',
    'new.profileTitle': 'Profiles are added under "profiles" in ~/.cc-dash/config.json',
    'new.folder': 'Folder',
    'new.folderPlaceholder': '/path/to/project',
    'new.recent': 'Recently used folders',
    'new.recentNone': 'None yet',
    'new.cancel': 'Cancel',
    'new.start': 'Start',
    'new.terminal': ' (terminal)',

    'tab.diff': 'Diff',
    'tab.files': 'Files',
    'tab.refs': 'Links',
    'tab.refsTitle': 'Links, PRs, work items and commits from the conversation',
    'panel.refresh': 'Refresh',
    'panel.pick': 'Pick a session.',

    'diff.readOnly': '· only read from',
    'diff.notGit': 'Not a git repo',
    'diff.written': (n) => `${n} ${n === 1 ? 'file' : 'files'} changed in this session`,
    'diff.notRepo': 'The folder is not a git repo.',
    'diff.noChanges': 'no changes',
    'diff.changed': (n) => `${n} ${n === 1 ? 'file' : 'files'} changed`,
    'diff.binary': '(binary file or mode change only)',
    'diff.view': 'view',
    'diff.untracked': 'New files (not in git yet)',
    'files.read': '(read)',

    'refs.prs': 'Pull requests',
    'refs.issues': 'Issues and work items',
    'refs.commits': 'Commits',
    'refs.links': 'Links',
    'refs.src.user': 'you',
    'refs.src.claude': 'Claude',
    'refs.src.command': 'command',
    'refs.copy': 'Copy',
    'refs.copyTitle': (v) => `Copy ${v}`,
    'refs.copied': 'Copied ✓',
    'refs.noMatch': 'No matches.',
    'refs.none': 'No links, PRs, work items or commits in this conversation yet.',
    'refs.filter': 'Filter links, PRs, work items, commits…',

    'preview.pick': 'Pick a file under <b>Files</b> or <b>Diff</b> to preview it.',
    'preview.rendered': 'Show rendered',
    'preview.source': 'Show source',
    'preview.newTab': 'Open in new tab ↗',
    'preview.max': 'Large view: hide the file list',
    'preview.restore': 'Show the file list again',
    'preview.prev': 'Previous file in the folder',
    'preview.next': 'Next file in the folder',
    'preview.pdf': 'PDF opens best in a new tab.',
    'preview.mermaidError': (m) => `Could not draw the diagram: ${m}`,

    'notify.session': 'Claude session',
    'notify.waiting': 'Waiting for you',
    'notify.done': 'Done – your turn',
  },

  no: {
    'lang.name': 'Norsk',
    'lang.switch': 'English',
    'lang.switchTitle': 'Switch to English',

    'time.now': 'nå',
    'time.min': (n) => `${n} min`,
    'time.hours': (n) => `${n} t`,
    'time.days': (n) => `${n} d`,
    'time.hoursMin': (h, m) => `${h} t ${m} min`,

    'state.working': 'jobber',
    'state.waiting': 'venter på deg',
    'state.idle': 'din tur',
    'state.ended': 'avsluttet',
    'state.workingOn': (d) => `jobber · ${d}`,
    'state.waitingSince': (t) => `Har ventet på deg siden ${t}`,
    'state.doneAt': (t) => `Ferdig kl. ${t}`,
    'state.took': (d) => `tok ${d}`,

    'profile.title': (name) => `Profil: ${name}`,

    'session.new': 'Ny sesjon',
    'session.untitled': '(uten tittel)',
    'session.more': 'Flere valg',
    'session.kill': 'Avslutt sesjonen',
    'session.killConfirm': 'avslutt?',

    'side.newBtn': '+ Ny sesjon',
    'side.newBtnTitle': 'Start en ny Claude-sesjon eller terminal',
    'side.filter': 'Filtrer sesjoner…',
    'side.unknownFolder': '(ukjent mappe)',
    'side.runningHere': 'Kjører her',
    'side.external': 'Åpne i andre terminaler',
    'side.recent': 'Nylige',
    'side.groupCount': (n) => `${n} sesjoner`,
    'side.live': 'Aktive',
    'side.earlier': 'Tidligere',
    'side.showOlder': (n) => `Vis ${n} eldre`,
    'side.showFewer': 'Vis færre',
    'side.none': 'Ingen sesjoner funnet.',
    'side.byFolder': '⇅ Mappe',
    'side.byStatus': '⇅ Status',
    'side.byFolderTitle': 'Gruppert etter mappe. Klikk for å gruppere etter status.',
    'side.byStatusTitle': 'Gruppert etter status. Klikk for å gruppere etter mappe.',
    'side.active': (n) => `${n} aktive`,
    'side.hooks': 'Live status: kjør <code>npm run setup</code>',
    'side.notify': '<button id="notify-btn" class="link-btn">Slå på varsler</button> når en sesjon venter på deg',

    'menu.claude': 'Ny Claude-sesjon her',
    'menu.shell': 'Ny terminal her',
    'menu.pick': 'Ny sesjon her med annen profil…',
    'menu.copy': 'Kopier sti',
    'menu.unread': 'Merk som ulest',
    'menu.read': 'Merk som lest',

    'head.panel': 'Panel',
    'head.panelTitle': 'Vis/skjul panel (diff, filer, forhåndsvisning)',
    'head.alsoChanged': (paths) => `Sesjonen har også endret filer i:\n${paths}`,
    'head.costTitle': 'Beregnet fra tokenbruk i transkriptet (API-listepris)',
    'head.context': (n) => `${n}% kontekst`,

    'empty.title': 'Velg en sesjon',
    'empty.body': '…eller start en ny med <b>+ Ny sesjon</b>.',

    'detail.folder': 'Mappe',
    'detail.session': 'Sesjon',
    'detail.model': 'Modell',
    'detail.cost': 'Pris',
    'detail.started': 'Startet',
    'detail.lastActive': 'Sist aktiv',
    'detail.profile': 'Profil',
    'detail.resume': 'Fortsett her (claude --resume)',
    'detail.externalNote': 'Denne sesjonen kjører i en annen terminal. Lukk den der først hvis du vil fortsette den her, så ikke to prosesser jobber i samme sesjon.',
    'detail.resumeAnyway': 'Fortsett her likevel',

    'term.ended': '[sesjonen er avsluttet]',
    'search.placeholder': 'Søk i terminalen…',
    'search.prev': 'Forrige (Shift+Enter)',
    'search.next': 'Neste (Enter)',
    'search.close': 'Lukk (Esc)',
    'search.none': 'ingen treff',

    'new.title': 'Ny sesjon',
    'new.profile': 'Profil',
    'new.profileTitle': 'Profiler legges til under "profiles" i ~/.cc-dash/config.json',
    'new.folder': 'Mappe',
    'new.folderPlaceholder': '/sti/til/prosjekt',
    'new.recent': 'Nylig brukte mapper',
    'new.recentNone': 'Ingen ennå',
    'new.cancel': 'Avbryt',
    'new.start': 'Start',
    'new.terminal': ' (terminal)',

    'tab.diff': 'Diff',
    'tab.files': 'Filer',
    'tab.refs': 'Lenker',
    'tab.refsTitle': 'Lenker, PR-er, work items og commits fra samtalen',
    'panel.refresh': 'Oppdater',
    'panel.pick': 'Velg en sesjon.',

    'diff.readOnly': '· bare lest fra',
    'diff.notGit': 'Ikke et git-repo',
    'diff.written': (n) => `${n} ${n === 1 ? 'fil' : 'filer'} endret i denne sesjonen`,
    'diff.notRepo': 'Mappen er ikke et git-repo.',
    'diff.noChanges': 'ingen endringer',
    'diff.changed': (n) => `${n} ${n === 1 ? 'fil' : 'filer'} endret`,
    'diff.binary': '(binærfil eller kun modusendring)',
    'diff.view': 'vis',
    'diff.untracked': 'Nye filer (ikke i git ennå)',
    'files.read': '(lest)',

    'refs.prs': 'Pull requests',
    'refs.issues': 'Issues og work items',
    'refs.commits': 'Commits',
    'refs.links': 'Lenker',
    'refs.src.user': 'deg',
    'refs.src.claude': 'Claude',
    'refs.src.command': 'kommando',
    'refs.copy': 'Kopier',
    'refs.copyTitle': (v) => `Kopier ${v}`,
    'refs.copied': 'Kopiert ✓',
    'refs.noMatch': 'Ingen treff.',
    'refs.none': 'Ingen lenker, PR-er, work items eller commits i denne samtalen ennå.',
    'refs.filter': 'Filtrer lenker, PR-er, work items, commits…',

    'preview.pick': 'Velg en fil under <b>Filer</b> eller <b>Diff</b> for å forhåndsvise den.',
    'preview.rendered': 'Vis rendret',
    'preview.source': 'Vis kilde',
    'preview.newTab': 'Åpne i ny fane ↗',
    'preview.max': 'Stor visning: skjul fillisten',
    'preview.restore': 'Vis fillisten igjen',
    'preview.prev': 'Forrige fil i mappen',
    'preview.next': 'Neste fil i mappen',
    'preview.pdf': 'PDF åpnes best i ny fane.',
    'preview.mermaidError': (m) => `Kunne ikke tegne diagrammet: ${m}`,

    'notify.session': 'Claude-sesjon',
    'notify.waiting': 'Venter på deg',
    'notify.done': 'Ferdig – din tur',
  },
};

export const LANGS = Object.keys(STRINGS);

// Norwegian for nb/nn/no browsers, English for everyone else.
function detect() {
  const prefs = navigator.languages?.length ? navigator.languages : [navigator.language || ''];
  for (const l of prefs) {
    const base = l.toLowerCase().split('-')[0];
    if (['nb', 'nn', 'no'].includes(base)) return 'no';
    if (STRINGS[base]) return base;
  }
  return 'en';
}

let lang = 'en';

export function setLang(l) {
  lang = STRINGS[l] ? l : detect();
  document.documentElement.lang = lang;
  applyStatic();
}

export const getLang = () => lang;

// For localeCompare and the like.
export const locale = () => (lang === 'no' ? 'nb' : 'en');

export function t(key, ...args) {
  const v = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  return typeof v === 'function' ? v(...args) : v;
}

// The static markup in index.html: data-i18n sets the text, data-i18n-html
// the markup, and data-i18n-title / data-i18n-placeholder those attributes.
export function applyStatic(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
}
