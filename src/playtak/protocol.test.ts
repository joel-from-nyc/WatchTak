import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from './protocol';

test('parses a protocol-v2 seek with a bot flag and open opponent', () => {
  const event = parseLine('Seek new 42 gruppler 6 600 10 A 4 30 1 0 0 0 0 0 1');
  assert.equal(event.type, 'seekNew');
  if (event.type !== 'seekNew') return;
  assert.equal(event.seek.id, 42);
  assert.equal(event.seek.player, 'gruppler');
  assert.equal(event.seek.boardSize, 6);
  assert.equal(event.seek.timeSeconds, 600);
  assert.equal(event.seek.incrementSeconds, 10);
  assert.equal(event.seek.color, 'A');
  assert.equal(event.seek.komi, 4);
  assert.equal(event.seek.opponent, '');
  assert.equal(event.seek.isBot, true);
});

test('parses a protocol-v1 seek without a bot flag', () => {
  const event = parseLine('Seek new 7 alice 5 900 0 W 0 21 1 0 0 0 0 bob');
  assert.equal(event.type, 'seekNew');
  if (event.type !== 'seekNew') return;
  assert.equal(event.seek.opponent, 'bob');
  assert.equal(event.seek.isBot, undefined);
});

test('parses GameList Add', () => {
  const event = parseLine('GameList Add 1234 alice bob 5 600 10 0 21 1 0 0 0 0');
  assert.equal(event.type, 'gameListAdd');
  if (event.type !== 'gameListAdd') return;
  assert.equal(event.game.gameNo, 1234);
  assert.equal(event.game.white, 'alice');
  assert.equal(event.game.black, 'bob');
  assert.equal(event.game.unrated, false);
});

test('parses place moves with capstone and wall flags', () => {
  const flat = parseLine('Game#5 P A1');
  const cap = parseLine('Game#5 P C3 C');
  const wall = parseLine('Game#5 P D4 W');
  assert.deepEqual(flat, { type: 'gamePlace', gameNo: 5, move: { square: 'A1', isCapstone: false, isWall: false } });
  assert.deepEqual(cap, { type: 'gamePlace', gameNo: 5, move: { square: 'C3', isCapstone: true, isWall: false } });
  assert.deepEqual(wall, { type: 'gamePlace', gameNo: 5, move: { square: 'D4', isCapstone: false, isWall: true } });
});

test('parses spread moves with drop counts', () => {
  const event = parseLine('Game#5 M A1 A3 1 2');
  assert.deepEqual(event, {
    type: 'gameSpread',
    gameNo: 5,
    move: { fromSquare: 'A1', toSquare: 'A3', drops: [1, 2] },
  });
});

test('parses clock updates in both seconds and milliseconds', () => {
  assert.deepEqual(parseLine('Game#9 Time 300 250'), {
    type: 'gameTime',
    gameNo: 9,
    whiteSeconds: 300,
    blackSeconds: 250,
  });
  assert.deepEqual(parseLine('Game#9 Timems 300500 250000'), {
    type: 'gameTime',
    gameNo: 9,
    whiteSeconds: 300.5,
    blackSeconds: 250,
  });
});

test('parses game-over, undo, and abandoned lines', () => {
  assert.deepEqual(parseLine('Game#9 Over R-0'), { type: 'gameOver', gameNo: 9, result: 'R-0' });
  assert.deepEqual(parseLine('Game#9 Undo'), { type: 'gameUndo', gameNo: 9 });
  assert.deepEqual(parseLine('Game#9 Abandoned. alice quit'), {
    type: 'gameAbandoned',
    gameNo: 9,
    quittingPlayer: 'alice',
  });
});

test('returns unknown for unrecognized lines', () => {
  assert.deepEqual(parseLine('Something new'), { type: 'unknown', raw: 'Something new' });
});
