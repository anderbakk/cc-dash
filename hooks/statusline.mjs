#!/usr/bin/env node
// Claude Code status line: saves the status JSON (model, context usage, …)
// for the cc-dash sidebar, then prints a status line. If you already had a
// status line, `npm run setup` stored it and its output is shown instead.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, STATUS_DIR, safeId } from '../server/paths.js';
import { readStdin } from './stdin.mjs';

const input = readStdin();
let data = {};
try {
  data = JSON.parse(input);
  const id = safeId(data.session_id);
  if (id) {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    const file = path.join(STATUS_DIR, `${id}.line.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...data, ts: Date.now() }));
    fs.renameSync(tmp, file);
  }
} catch {}

let chained = null;
try {
  chained = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).chainStatusLine?.command || null;
} catch {}

if (chained) {
  const r = spawnSync(chained, { input, shell: true, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  process.stdout.write(r.stdout || '');
} else {
  const parts = [data.model?.display_name, path.basename(data.workspace?.current_dir || data.cwd || '')];
  const pct = data.context_window?.used_percentage;
  if (pct != null) parts.push(`${Math.round(pct)}% kontekst`);
  process.stdout.write(parts.filter(Boolean).join(' · '));
}
