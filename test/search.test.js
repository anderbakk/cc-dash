import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { searchFiles } from '../server/files.js';

const made = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function tree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dash-search-'));
  made.push(dir);
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'first\nHello there\nhello again\n');
  fs.writeFileSync(path.join(dir, 'sub', 'b.md'), 'say HELLO\n');
  fs.writeFileSync(path.join(dir, 'node_modules', 'c.js'), 'hello\n');
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 104, 101, 108, 108, 111]));
  return dir;
}

test('finds text case-insensitively, skipping binaries and hidden folders', async () => {
  const dir = tree();
  const r = await searchFiles(dir, '', 'hello');
  assert.deepEqual(r.files.map((f) => f.path), ['a.txt', 'sub/b.md']);
  assert.equal(r.files[0].count, 2);
  assert.deepEqual(r.files[0].hits[0], { line: 2, text: 'Hello there' });
});

test('searches below the folder shown, with paths from the root', async () => {
  const dir = tree();
  const r = await searchFiles(dir, 'sub', 'hello');
  assert.deepEqual(r.files.map((f) => f.path), ['sub/b.md']);
});

test('refuses folders outside the root', async () => {
  assert.equal(await searchFiles(tree(), '..', 'hello'), null);
});
