/// <reference path="../types/tps-ninja.d.ts" />
import { PassThrough } from 'stream';
import { PTNtoTPS, TPStoPNG } from 'tps-ninja';

// Renders the position after `plies` as a PNG buffer, highlighting the last
// ply. The PassThrough sink stops tps-ninja from writing a file to disk.
export function renderBoardPng(
  boardSize: number,
  komi: number,
  plies: string[],
  white: string,
  black: string,
): Buffer {
  const tps = PTNtoTPS({ size: boardSize, plies });
  const lastPly = plies[plies.length - 1];
  const sink = new PassThrough();
  sink.on('data', () => {});
  const canvas = TPStoPNG(
    {
      tps,
      komi,
      hl: lastPly,
      player1: white,
      player2: black,
      // `font` must be installed on the host; canvas falls back to its
      // default font otherwise.
      theme: 'discord',
      transparent: true,
      imageSize: 'md',
      font: 'Roboto',
    },
    sink,
  );
  return canvas.toBuffer();
}
