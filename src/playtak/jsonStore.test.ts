import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createJsonStore } from './jsonStore';

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtak-store-'));
  process.env.DATA_DIR = dir;
  process.env.DISCORD_GUILD_ID = '123';
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('returns the empty value when no file exists', () => {
  const store = createJsonStore<{ [k: string]: number }>('missing', () => ({}));
  assert.deepEqual(store.get(), {});
});

test('writes a guild-namespaced file into DATA_DIR and reads it back', () => {
  const store = createJsonStore<{ [k: string]: number }>('counts', () => ({}));
  store.set({ a: 1 });
  const file = path.join(dir, 'counts.123.json');
  assert.ok(fs.existsSync(file));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
  assert.ok(!fs.existsSync(`${file}.${process.pid}.tmp`));

  const fresh = createJsonStore<{ [k: string]: number }>('counts', () => ({}));
  assert.deepEqual(fresh.get(), { a: 1 });
});

test('a corrupt file falls back to the empty value', () => {
  fs.writeFileSync(path.join(dir, 'broken.123.json'), '{not json');
  const store = createJsonStore<{ [k: string]: number }>('broken', () => ({}));
  assert.deepEqual(store.get(), {});
});
