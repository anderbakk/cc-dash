// Profiles: how a new terminal is started. The defaults are Claude and a plain
// shell; anything else (a shell that logs in to another account first,
// a venv, WSL) is the user's own `profiles` list in ~/.cc-dash/config.json:
//
//   { "name": "Work + Claude", "shell": "pwsh", "init": "Use-WorkTenant" }
//   { "name": "Work", "shell": "pwsh", "init": "Use-WorkTenant", "command": null }
//
//   name     shown in the UI (required)
//   shell    shell that runs everything (default powershell.exe / $SHELL)
//   init     shell command run first, in the same shell (default none)
//   command  the command that starts Claude (default claude); null gives a
//            plain shell instead
//   env      extra environment variables
//   cwd      folder to start in when none is given
//   tag      short label shown on its sessions, e.g. "WORK"
//   color    color of the tag and of a stripe on its sessions
//
// Profiles are only ever read from that file. The API can pick one but never
// define one, or any page that got hold of the token could run any command.
import fs from 'node:fs';
import os from 'node:os';
import { CONFIG_FILE, stripBom } from './paths.js';

export const DEFAULT_PROFILES = [
  { name: 'Claude' },
  { name: 'Terminal', command: null },
];

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profil';
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

// A named color (themed in style.css) or a hex code. The value ends up in a
// style attribute, so nothing else gets through.
export const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'gray'];
function color(c, i) {
  if (c === undefined) return undefined;
  if (typeof c === 'string' && (COLORS.includes(c) || /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c))) return c;
  warn(`profiles[${i}].color must be ${COLORS.join(', ')} or a hex code like #c93c37, ignoring it`);
  return undefined;
}

// Profiles are read on every poll: say each problem once, not every two seconds.
const warned = new Set();
function warn(msg) {
  if (!warned.has(msg)) console.error(`config.json: ${msg}`);
  warned.add(msg);
}

function clean(p, i) {
  if (!p || typeof p !== 'object' || !str(p.name)) throw new Error(`profiles[${i}] is missing "name"`);
  if (p.command !== undefined && p.command !== null && !str(p.command)) throw new Error(`profiles[${i}].command must be a string or null`);
  const env = {};
  for (const [k, v] of Object.entries(p.env || {})) if (typeof v === 'string') env[k] = v;
  return {
    id: str(p.id) || slug(p.name),
    name: p.name.trim(),
    shell: str(p.shell),
    init: str(p.init),
    command: p.command === null ? null : str(p.command),
    claude: p.command !== null,
    env,
    cwd: str(p.cwd)?.replace(/^~(?=$|[\\/])/, os.homedir()),
    tag: str(p.tag)?.slice(0, 16),
    color: color(p.color, i),
  };
}

// Read on every call, so editing config.json takes effect without a restart.
export function loadProfiles() {
  let list;
  try {
    list = JSON.parse(stripBom(fs.readFileSync(CONFIG_FILE, 'utf8'))).profiles;
  } catch {}
  if (!Array.isArray(list) || !list.length) list = DEFAULT_PROFILES;
  const out = [];
  const seen = new Set();
  list.forEach((p, i) => {
    let c;
    try {
      c = clean(p, i);
    } catch (e) {
      warn(`${e.message}, skipping it`);
      return;
    }
    while (seen.has(c.id)) c.id += '-2';
    seen.add(c.id);
    out.push(c);
  });
  return out.length ? out : DEFAULT_PROFILES.map(clean);
}

// The profile to use: the one asked for, else the first that starts Claude
// (or the first at all, when wanting a shell is fine).
export function pickProfile(id, { claude } = {}) {
  const all = loadProfiles();
  if (id) {
    const p = all.find((x) => x.id === id);
    if (!p) throw new Error(`Unknown profile: ${id}`);
    if (claude && !p.claude) throw new Error(`Profile "${p.name}" does not start Claude`);
    return p;
  }
  return (claude ? all.find((p) => p.claude) : all[0]) || DEFAULT_PROFILES.map(clean)[0];
}
