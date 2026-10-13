#!/usr/bin/env node
// Stops a cc-dash started in the background (scripts/start.js), which has no
// window to close. Like Ctrl+C, this ends the sessions it runs with node-pty
// (always the case on Windows); they can be continued with --resume.
//
//   --linger  keep the message on screen for a moment (for the shortcut)
import { callLocal } from '../server/local.js';

const r = await callLocal('/api/shutdown', { method: 'POST' });
if (!r) console.log('cc-dash is not running.');
else if (r.ended) console.log(`cc-dash is stopped, and ${r.ended} session${r.ended === 1 ? '' : 's'} with it.`);
else console.log('cc-dash is stopped.');
if (process.argv.includes('--linger')) await new Promise((res) => setTimeout(res, 2500));
