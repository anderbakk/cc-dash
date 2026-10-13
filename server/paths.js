// Shared paths. Imported by both the server and the hook scripts, so keep it
// free of dependencies and side effects.
import os from 'node:os';
import path from 'node:path';

export const IS_WIN = process.platform === 'win32';
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
export const DATA_DIR = process.env.CC_DASH_DIR || path.join(os.homedir(), '.cc-dash');
export const STATUS_DIR = path.join(DATA_DIR, 'status');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');

// Session ids come from Claude Code and end up in file names; never trust them blindly.
export function safeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : null;
}

// Windows paths are case-insensitive, and the same folder can reach us with a
// different drive-letter case depending on who wrote it down (transcript cwd,
// realpath, the user typing it in). Compare accordingly.
export const pathKey = (p) => (IS_WIN ? p.toLowerCase() : p);

// Is `child` the folder `parent` or somewhere inside it?
export function isInside(child, parent) {
  const c = pathKey(child);
  const p = pathKey(parent).replace(/[\\/]+$/, '');
  return c === p || c.startsWith(p + path.sep);
}

// JSON.parse chokes on a UTF-8 BOM, and Notepad, `Out-File -Encoding utf8` and
// a good many editors put one in front of every file they save on Windows. Any
// hand-editable JSON we read has to go through this first.
export function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
