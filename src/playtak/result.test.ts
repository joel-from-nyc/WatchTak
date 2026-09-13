import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeResult } from './result';

test('describeResult', () => {
  assert.equal(describeResult('R-0', 'alice', 'bob'), 'alice wins by road!');
  assert.equal(describeResult('0-R', 'alice', 'bob'), 'bob wins by road!');
  assert.equal(describeResult('F-0', 'alice', 'bob'), 'alice wins by flats.');
  assert.equal(describeResult('0-F', 'alice', 'bob'), 'bob wins by flats.');
  assert.equal(describeResult('1-0', 'alice', 'bob'), 'alice wins. (1-0)');
  assert.equal(describeResult('0-1', 'alice', 'bob'), 'bob wins. (0-1)');
  assert.equal(describeResult('1/2-1/2', 'alice', 'bob'), 'Draw.');
  assert.equal(describeResult('0-0', 'alice', 'bob'), 'Game aborted, no result.');
  assert.equal(describeResult('??', 'alice', 'bob'), '??');
});
