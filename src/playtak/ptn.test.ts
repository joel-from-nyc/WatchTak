import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeToPtn, spreadToPtn, plyToMoveLabel, moveLabelToPly, formatPtnMoveList } from './ptn';

test('placeToPtn lowercases the square and prefixes piece type', () => {
  assert.equal(placeToPtn({ square: 'A1', isCapstone: false, isWall: false }), 'a1');
  assert.equal(placeToPtn({ square: 'C3', isCapstone: true, isWall: false }), 'Cc3');
  assert.equal(placeToPtn({ square: 'D4', isCapstone: false, isWall: true }), 'Sd4');
});

test('spreadToPtn picks the direction and omits the count for a single stone', () => {
  assert.equal(spreadToPtn({ fromSquare: 'A1', toSquare: 'B1', drops: [1] }), 'a1>1');
  assert.equal(spreadToPtn({ fromSquare: 'B1', toSquare: 'A1', drops: [1] }), 'b1<1');
  assert.equal(spreadToPtn({ fromSquare: 'A1', toSquare: 'A3', drops: [1, 2] }), '3a1+12');
  assert.equal(spreadToPtn({ fromSquare: 'A3', toSquare: 'A1', drops: [2, 1] }), '3a3-21');
});

test('move labels round-trip through ply indexes', () => {
  assert.equal(plyToMoveLabel(0), '1W');
  assert.equal(plyToMoveLabel(1), '1B');
  assert.equal(plyToMoveLabel(22), '12W');
  for (let ply = 0; ply < 50; ply++) {
    const label = plyToMoveLabel(ply);
    const moveNumber = Number(label.slice(0, -1));
    const color = label.slice(-1) as 'W' | 'B';
    assert.equal(moveLabelToPly(moveNumber, color), ply);
  }
});

test('formatPtnMoveList numbers pairs and uses ellipsis for a black start', () => {
  assert.equal(formatPtnMoveList(['a1', 'f6', 'Cd4', 'Sd3']), '1. a1 f6\n2. Cd4 Sd3');
  assert.equal(formatPtnMoveList(['a1', 'f6', 'Cd4']), '1. a1 f6\n2. Cd4');
  assert.equal(formatPtnMoveList(['c3', 'd4', 'e5'], 23), '12... c3\n13. d4 e5');
  assert.equal(formatPtnMoveList([]), '');
});
