#!/usr/bin/env node
// Adds (or with --remove, removes) Start menu shortcuts for cc-dash on Windows:
// "cc-dash" starts it in the background (or opens it if it already runs) and
// "Stop cc-dash" stops it.
//
//   --autostart    also start cc-dash in the background when you log in
//   --auto-update  turn on "autoUpdate" in ~/.cc-dash/config.json, so every
//                  start pulls the latest version first
//   --remove       remove all the shortcuts again
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, DATA_DIR, IS_WIN, stripBom } from '../server/paths.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const has = (flag) => process.argv.includes(flag);
const remove = has('--remove');

if (has('--auto-update')) {
  let config = {};
  try {
    config = JSON.parse(stripBom(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch {}
  config.autoUpdate = true;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log(`autoUpdate is on in ${CONFIG_FILE}.`);
}

if (!IS_WIN) {
  console.log('Shortcuts are only made on Windows for now. Elsewhere, point a launcher or alias at:');
  console.log(`  "${process.execPath}" "${path.join(ROOT, 'scripts', 'start.js')}"`);
  process.exit(0);
}

const script = (name) => `"${path.join(ROOT, 'scripts', name)}"`;
// WindowStyle 1 is a normal window, 7 is minimized. The windows close by
// themselves; a normal one shows what happens (an update, npm ci) and stays
// open if something fails.
const shortcuts = [
  { folder: 'Programs', name: 'cc-dash', args: `${script('start.js')} --pause-on-error`, style: 1, description: 'Start or open cc-dash' },
  { folder: 'Programs', name: 'Stop cc-dash', args: `${script('stop.js')} --linger`, style: 1, description: 'Stop cc-dash and end its sessions' },
  { folder: 'Startup', name: 'cc-dash', args: `${script('start.js')} --no-open --pause-on-error`, style: 7, description: 'Start cc-dash in the background', autostart: true },
].filter((s) => remove || !s.autostart || has('--autostart'));

// WScript.Shell is the one built-in way to write a .lnk. The list goes in
// through an environment variable, so no path ever needs quoting for PowerShell.
const ps = `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
foreach ($s in ($env:CC_DASH_SHORTCUTS | ConvertFrom-Json)) {
  $file = Join-Path ([Environment]::GetFolderPath($s.folder)) ($s.name + '.lnk')
  if ($env:CC_DASH_REMOVE) {
    if (Test-Path $file) { Remove-Item $file; "Removed: $file" }
    continue
  }
  $lnk = $shell.CreateShortcut($file)
  $lnk.TargetPath = $env:CC_DASH_NODE
  $lnk.Arguments = $s.args
  $lnk.WorkingDirectory = $env:CC_DASH_ROOT
  $lnk.WindowStyle = $s.style
  $lnk.Description = $s.description
  $lnk.Save()
  "Created: $file"
}`;

const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CC_DASH_SHORTCUTS: JSON.stringify(shortcuts),
    CC_DASH_NODE: process.execPath,
    CC_DASH_ROOT: ROOT,
    CC_DASH_REMOVE: remove ? '1' : '',
  },
});
if (r.status !== 0) process.exit(r.status ?? 1);
if (!remove) {
  console.log('\nFind "cc-dash" in the Start menu; right-click it to pin it to the taskbar or Start.');
  console.log('The shortcuts point at this node and this folder: run "npm run shortcut" again if either moves.');
}
