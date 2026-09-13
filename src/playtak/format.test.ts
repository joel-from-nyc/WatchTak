import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatKomi, formatDuration, alignedLine, formatPlayerName, formatPlayerNameBold, discordTime } from './format';

test('formatKomi converts wire half-points', () => {
  assert.equal(formatKomi(0), '0');
  assert.equal(formatKomi(1), '½');
  assert.equal(formatKomi(4), '2');
  assert.equal(formatKomi(5), '2½');
});

test('formatDuration', () => {
  assert.equal(formatDuration(20_000), 'under a minute');
  assert.equal(formatDuration(24 * 60_000), '24 minutes');
  assert.equal(formatDuration(60 * 60_000), '1 hour');
  assert.equal(formatDuration(65 * 60_000), '1 hour 5 minutes');
  assert.equal(formatDuration(121 * 60_000), '2 hours 1 minute');
});

test('alignedLine pads the label to the shared width', () => {
  assert.equal(alignedLine('Move', '1W. a1', 10), 'Move:       1W. a1');
  assert.equal(alignedLine('White Time', '9:59', 10), 'White Time: 9:59');
});

test('player names with and without ratings', () => {
  assert.equal(formatPlayerName('gruppler', 1836), 'gruppler (1836)');
  assert.equal(formatPlayerName('Guest12', undefined), 'Guest12');
  assert.equal(formatPlayerNameBold('gruppler', 1836), '**gruppler** (1836)');
  assert.equal(formatPlayerNameBold('Guest12', undefined), '**Guest12**');
});

test('discordTime emits a unix-seconds tag', () => {
  assert.equal(discordTime(1_700_000_000_500), '<t:1700000000:f>');
  assert.equal(discordTime(1_700_000_000_000, 'R'), '<t:1700000000:R>');
});
