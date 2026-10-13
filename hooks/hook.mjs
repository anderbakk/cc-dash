#!/usr/bin/env node
// Claude Code hook: records each session's live state for the cc-dash sidebar.
// Installed by `npm run setup`. Must be fast, silent and never fail the session.
import fs from 'node:fs';
import path from 'node:path';
import { STATUS_DIR, safeId } from '../server/paths.js';
import { readStdin } from './stdin.mjs';

function stateFor(e) {
  switch (e.hook_event_name) {
    case 'SessionStart':
      return { state: 'idle' };
    case 'UserPromptSubmit':
      return { state: 'working', prompt: e.prompt };
    case 'PreToolUse':
      return { state: 'working', detail: e.tool_name };
    case 'PostToolUse':
      return { state: 'working' };
    case 'Notification':
      // idle_prompt fires when Claude has been waiting a while after finishing;
      // everything else (permission prompts etc.) needs the user's attention.
      return e.notification_type === 'idle_prompt' ? null : { state: 'waiting', detail: e.message };
    case 'Stop':
      return { state: 'idle' };
    case 'SessionEnd':
      return { state: 'ended' };
  }
  return null;
}

try {
  const e = JSON.parse(readStdin());
  const id = safeId(e.session_id);
  const s = id && stateFor(e);
  if (s) {
    const file = path.join(STATUS_DIR, `${id}.hook.json`);
    let prev = {};
    try {
      prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    const prompt = s.prompt ? s.prompt.replace(/\s+/g, ' ').trim().slice(0, 300) : prev.prompt;
    // When the current turn began, so the sidebar can say how long it took.
    const turnAt = e.hook_event_name === 'UserPromptSubmit' ? Date.now() : prev.turnAt || null;
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ state: s.state, detail: s.detail || null, prompt, turnAt, cwd: e.cwd, event: e.hook_event_name, ts: Date.now() }));
    fs.renameSync(tmp, file);
  }
  // In a terminal cc-dash started: which Claude session it runs now. /resume
  // and /clear switch to another session id in the same terminal.
  const dash = safeId(process.env.CC_DASH_SESSION);
  if (id && dash) {
    const ptr = path.join(STATUS_DIR, `dash-${dash}.json`);
    let was = null;
    try {
      was = JSON.parse(fs.readFileSync(ptr, 'utf8')).session;
    } catch {}
    if (was !== id) {
      fs.mkdirSync(STATUS_DIR, { recursive: true });
      const tmp = `${ptr}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ session: id, ts: Date.now() }));
      fs.renameSync(tmp, ptr);
    }
  }
} catch {}
process.exit(0);
