/// <reference path="../types/tps-ninja.d.ts" />
import { PassThrough } from 'stream';
import { PTNtoTPS, TPStoPNG } from 'tps-ninja';

// Renders the current board position (from the full PTN move list) as a PNG
// buffer. Passing a dummy PassThrough as tps-ninja's `streamTo` argument
// prevents its default behavior of writing a file to disk as a side effect
// (see TPStoPNG.js) - we only want the in-memory buffer.
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
      // `theme`/`transparent`/`imageSize` fixed per feedback from tps-ninja's
      // own author on how the library is meant to be embedded in a Discord
      // message. `font` assumes Roboto is installed as a system font on the
      // host running this bot (confirmed on the current Windows host) -
      // would fall back silently to canvas's default font on a host without
      // it, e.g. a future Linux/Docker deployment.
      theme: 'discord',
      transparent: true,
      imageSize: 'md',
      font: 'Roboto',
    },
    sink,
  );
  return canvas.toBuffer();
}
