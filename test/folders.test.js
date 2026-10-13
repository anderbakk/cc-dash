import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { addTargets, newTouched, normalizePath, projectRoot, sessionRoots, toolTargets } from '../server/folders.js';
import { IS_WIN } from '../server/paths.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.cc-dash-test-')));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

test('normalizePath', () => {
  assert.equal(normalizePath('sub/x.md', tmp), path.join(tmp, 'sub', 'x.md'));
  assert.equal(normalizePath('$HOME/x'), null);
  assert.equal(normalizePath('src/*.js', tmp), null);
  assert.equal(normalizePath('relative'), null);
  if (IS_WIN) {
    assert.equal(normalizePath('/c/git/repo'), 'C:\\git\\repo');
    assert.equal(normalizePath('c:/git/repo/'), 'C:\\git\\repo');
  }
});

test('toolTargets reads writes, reads and shell folders', () => {
  const content = [
    { type: 'text', text: 'hei' },
    { type: 'tool_use', name: 'Write', input: { file_path: path.join(tmp, 'notes', 'a.md') } },
    { type: 'tool_use', name: 'Read', input: { file_path: 'b.md' } },
    { type: 'tool_use', name: 'Bash', input: { command: `cd "${tmp}" && git -C '${path.join(tmp, 'r')}' status; ls` } },
  ];
  const t = toolTargets(content, path.join(tmp, 'cwd'));
  assert.deepEqual(t.map((x) => [x.kind, x.dir]), [
    ['write', path.join(tmp, 'notes')],
    ['read', path.join(tmp, 'cwd')],
    ['shell', tmp],
    ['shell', path.join(tmp, 'r')],
  ]);
});

test('sessionRoots: cwd first, then written folders, read-only repos last', async () => {
  const main = path.join(tmp, 'main');
  const notes = path.join(tmp, 'notes');
  const other = path.join(tmp, 'other');
  for (const d of [path.join(main, 'src'), path.join(notes, 'deep'), path.join(other, 'src')]) fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', main]);
  execFileSync('git', ['init', '-q', other]);
  fs.writeFileSync(path.join(notes, 'a.md'), 'a');
  fs.writeFileSync(path.join(notes, 'deep', 'b.md'), 'b');

  const touched = newTouched();
  addTargets(touched, [
    { kind: 'write', dir: path.join(main, 'src'), file: path.join(main, 'src', 'x.js') }, // inside cwd: no extra root
    { kind: 'write', dir: path.join(notes, 'deep'), file: path.join(notes, 'deep', 'b.md') },
    { kind: 'write', dir: notes, file: path.join(notes, 'a.md') },
    { kind: 'write', dir: notes, file: path.join(notes, 'gone.md') }, // deleted since
    { kind: 'shell', dir: path.join(other, 'src') },
    { kind: 'read', dir: tmp }, // read once: ignored
  ], 1000);

  const roots = await sessionRoots(path.join(main, 'src'), touched);
  assert.deepEqual(roots.map((r) => [r.name, r.git, r.primary]), [
    ['src', true, true],
    ['notes', false, false],
    ['other', true, false],
  ]);
  assert.equal(roots[0].id, 'main');
  assert.deepEqual(roots[1].written.map((f) => f.path).sort(), ['a.md', 'deep/b.md']);
  assert.equal(roots[2].writes, 0);
});

test('projectRoot: the repo around a folder, or the folder itself', () => {
  const repo = path.join(tmp, 'proj');
  const sub = path.join(repo, 'Source', 'Server');
  const loose = path.join(tmp, 'loose', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(loose, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  assert.equal(projectRoot(sub), repo);
  assert.equal(projectRoot(repo), repo);
  assert.equal(projectRoot(loose), loose);
});
