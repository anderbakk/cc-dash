import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Point cc-dash at a scratch config before anything reads it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-profiles-'));
process.env.CC_DASH_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const writeConfig = (cfg) => fs.writeFileSync(path.join(dir, 'config.json'), '\ufeff' + JSON.stringify(cfg));

const { loadProfiles, pickProfile } = await import('../server/profiles.js');
const { launchCommand } = await import('../server/hosts.js');

test('defaults: Claude and a plain terminal', () => {
  writeConfig({ token: 'x' });
  assert.deepEqual(loadProfiles().map((p) => [p.id, p.claude]), [['claude', true], ['terminal', false]]);
});

test('user profiles replace the defaults; bad ones are skipped', () => {
  writeConfig({
    profiles: [
      { name: 'Work + Claude', shell: 'pwsh', init: 'work-login' },
      { name: 'Work', shell: 'pwsh', init: 'work-login', command: null, env: { A: '1', B: 2 } },
      { shell: 'bash' },
      { name: 'Work' },
    ],
  });
  const ps = loadProfiles();
  assert.deepEqual(ps.map((p) => p.id), ['work-claude', 'work', 'work-2']);
  assert.deepEqual(ps[1].env, { A: '1' });
  assert.equal(pickProfile('work').claude, false);
  assert.equal(pickProfile(null, { claude: true }).id, 'work-claude');
  assert.throws(() => pickProfile('work', { claude: true }), /starter ikke Claude/);
  assert.throws(() => pickProfile('nope'), /Ukjent profil/);
});

test('tag and color; a bad color is dropped, not the profile', () => {
  writeConfig({
    profiles: [
      { name: 'A', tag: 'WORK', color: 'red' },
      { name: 'B', tag: 'X', color: '#C93C37' },
      { name: 'C', tag: 'Y', color: 'red; background:url(x)' },
    ],
  });
  assert.deepEqual(loadProfiles().map((p) => [p.tag, p.color]), [['WORK', 'red'], ['X', '#C93C37'], ['Y', undefined]]);
});

test('launchCommand: PowerShell', () => {
  const [file, args] = launchCommand({ shell: 'pwsh', init: 'work-login', claude: true, args: ['--resume', 'abc'] });
  assert.equal(file, 'pwsh');
  assert.equal(args[0], '-NoLogo');
  assert.ok(!args.includes('-NoExit'));
  assert.match(args.at(-1), /UTF8Encoding.*; work-login; & claude --resume abc$/);

  const [, plain] = launchCommand({ shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', init: 'work-login', claude: false });
  assert.ok(plain.includes('-NoExit'));
  assert.match(plain.at(-1), /; work-login$/);
});

test('launchCommand: POSIX and cmd', () => {
  assert.deepEqual(launchCommand({ shell: '/bin/zsh', claude: true, command: 'claude --model opus', args: ['--session-id', 'a b'] }),
    ['/bin/zsh', ['-lc', "exec claude --model opus --session-id 'a b'"]]);
  assert.deepEqual(launchCommand({ shell: '/bin/bash', init: 'source .venv/bin/activate', claude: false }),
    ['/bin/bash', ['-lc', 'source .venv/bin/activate; exec /bin/bash -l']]);
  assert.deepEqual(launchCommand({ shell: '/bin/bash', claude: false }), ['/bin/bash', ['-l']]);
  assert.deepEqual(launchCommand({ shell: 'cmd.exe', claude: false, init: 'vcvars64' }), ['cmd.exe', ['/K', 'chcp 65001 >nul & vcvars64']]);
});
