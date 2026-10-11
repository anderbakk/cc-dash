#!/usr/bin/env node
// Installs (or with --remove, uninstalls) the cc-dash hooks and status line in
// Claude Code's user settings. Other settings and hooks are left untouched,
// and a backup of settings.json is written first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, DATA_DIR, SETTINGS_FILE, stripBom } from '../server/paths.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Forward slashes work for node on every platform and in every shell. The
// --cc-dash marker lets us find our own entries again, wherever the repo lives.
const MARK = '--cc-dash';
// Absolute path to the node running setup, not a bare `node`: the process
// Claude Code starts hooks from often has a different PATH (Windows services,
// nvm/fnm/asdf shims), and a hook that cannot start just fails silently.
const NODE = process.execPath.split(path.sep).join('/');
const script = (name) => `"${NODE}" "${path.join(ROOT, 'hooks', name).split(path.sep).join('/')}" ${MARK}`;
const HOOK_CMD = script('hook.mjs');
const STATUS_CMD = script('statusline.mjs');
// PostToolUse is deliberately not installed. Every hook costs a node start —
// about 220 ms on Windows — and it would double that for each tool call while
// only clearing the tool name back out of the sidebar. PreToolUse already says
// "working", and Stop clears it when the turn is over.
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse']);

const isOurs = (cmd) => typeof cmd === 'string' && cmd.includes('hook.mjs') && cmd.endsWith(MARK);
const isOurStatus = (cmd) => typeof cmd === 'string' && cmd.includes('statusline.mjs') && cmd.endsWith(MARK);

function readJson(file, fallback) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`Klarte ikke å lese ${file}: ${e.message}`);
  }
}

function removeOurHooks(settings) {
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h.command)) }))
      .filter((g) => g.hooks.length);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
}

const remove = process.argv.includes('--remove');
const settings = readJson(SETTINGS_FILE, {});
const config = readJson(CONFIG_FILE, {});

// Keep the very first backup: that is the one without any cc-dash changes.
const backup = `${SETTINGS_FILE}.cc-dash-backup`;
if (fs.existsSync(SETTINGS_FILE) && !fs.existsSync(backup)) {
  fs.copyFileSync(SETTINGS_FILE, backup);
  console.log(`Backup: ${backup}`);
}

removeOurHooks(settings);

if (remove) {
  if (isOurStatus(settings.statusLine?.command)) {
    if (config.chainStatusLine) settings.statusLine = config.chainStatusLine;
    else delete settings.statusLine;
  }
  delete config.chainStatusLine;
} else {
  settings.hooks ||= {};
  for (const event of EVENTS) {
    const group = { hooks: [{ type: 'command', command: HOOK_CMD, timeout: 10 }] };
    if (TOOL_EVENTS.has(event)) group.matcher = '*';
    (settings.hooks[event] ||= []).push(group);
  }
  // Keep an existing status line working by running it from ours.
  const current = settings.statusLine;
  if (current && !isOurStatus(current.command)) config.chainStatusLine = current;
  settings.statusLine = { ...(config.chainStatusLine || {}), type: 'command', command: STATUS_CMD };
}

fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });

console.log(remove ? 'cc-dash hooks og statusline er fjernet.' : 'cc-dash hooks og statusline er installert.');
console.log(`Endret: ${SETTINGS_FILE}`);
if (!remove) console.log('Gjelder for nye Claude-sesjoner. Kjør "npm run setup:remove" for å angre.');
