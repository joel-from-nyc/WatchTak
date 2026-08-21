/// <reference path="../types/tps-ninja.d.ts" />
import { PassThrough } from 'stream';
import { PTNtoTPS, TPStoPNG } from 'tps-ninja';

// Renders the current board position (from the full PTN move list) as a PNG
// buffer. Passing a dummy PassThrough as tps-ninja's `streamTo` argument
// prevents its default behavior of writing a file to disk as a side effect
// (see TPStoPNG.js) - we only want the in-memory buffer.
export function renderBoardPng(boardSize: number, komi: number, plies: string[]): Buffer {
  const tps = PTNtoTPS({ size: boardSize, plies });
  const lastPly = plies[plies.length - 1];
  const sink = new PassThrough();
  sink.on('data', () => {});
  const canvas = TPStoPNG({ tps, komi, imageSize: 'sm', hl: lastPly }, sink);
  return canvas.toBuffer();
}
