import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChunkContents,
  parseChunkHeader,
  filledChunkContent,
  markChunkStale,
  chunkMoveList,
  replayThreadName,
  parseReplayThreadName,
  CHUNK_HINT,
  STALE_CHUNK_NOTE,
  CHUNK_MAX_PLIES,
} from './catchup';

const plies = Array.from({ length: 23 }, (_, i) => `p${i}`);

test('buildChunkContents splits into chunks of at most CHUNK_MAX_PLIES', () => {
  const chunks = buildChunkContents(plies, 0);
  assert.equal(chunks.length, 3);
  assert.deepEqual(parseChunkHeader(chunks[0]), { fromPly: 0, toPly: CHUNK_MAX_PLIES - 1 });
  assert.deepEqual(parseChunkHeader(chunks[1]), { fromPly: 10, toPly: 19 });
  assert.deepEqual(parseChunkHeader(chunks[2]), { fromPly: 20, toPly: 22 });
  for (const chunk of chunks) assert.ok(chunk.includes(CHUNK_HINT));
});

test('buildChunkContents starts from fromPly', () => {
  const chunks = buildChunkContents(plies, 15);
  assert.equal(chunks.length, 1);
  assert.deepEqual(parseChunkHeader(chunks[0]), { fromPly: 15, toPly: 22 });
});

test('a chunk carries exactly the move list /expand compares against', () => {
  const [chunk] = buildChunkContents(plies, 3);
  assert.ok(chunk.includes(chunkMoveList(plies, 3, 12)));
});

test('filled and stale variants', () => {
  const [chunk] = buildChunkContents(plies, 0);
  const filled = filledChunkContent(plies, 0, 9);
  assert.ok(!filled.includes(CHUNK_HINT));
  assert.deepEqual(parseChunkHeader(filled), { fromPly: 0, toPly: 9 });
  const stale = markChunkStale(chunk);
  assert.ok(stale.includes(STALE_CHUNK_NOTE));
  assert.ok(!stale.includes(CHUNK_HINT));
});

test('parseChunkHeader ignores non-chunk text', () => {
  assert.equal(parseChunkHeader('Move: 3W. a1'), undefined);
});

test('replay thread names round-trip and do not look like watch threads', () => {
  const name = replayThreadName('alice', 'bob', 77);
  assert.deepEqual(parseReplayThreadName(name), { white: 'alice', black: 'bob', gameNo: 77 });
  assert.ok(!/\(#\d+\)$/.test(name));
  assert.equal(parseReplayThreadName('alice vs bob (#77)'), undefined);
});
