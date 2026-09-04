// tps-ninja ships no type declarations. Only the two functions this project
// actually uses are typed here, and only loosely - see
// https://github.com/gruppler/TPS-Ninja for the full option set.
declare module 'tps-ninja' {
  export interface PTNtoTPSOptions {
    tps?: string;
    size?: number;
    plies: string[];
    opening?: 'swap' | 'no-swap';
  }

  export function PTNtoTPS(options: PTNtoTPSOptions): string;

  export interface TPStoPNGOptions {
    tps: string;
    komi?: number;
    imageSize?: 'sm' | 'md' | 'lg';
    name?: string;
    // Highlights the squares touched by this ply without re-applying it -
    // `tps` should already reflect the position after the move.
    hl?: string;
    // Shown next to the flat count on each side of the board header.
    player1?: string;
    player2?: string;
    // Built-in theme id from tps-ninja's own themes.js - 'discord' is a
    // theme the library ships specifically to blend into Discord's UI.
    theme?: string;
    // Renders on a transparent background (zeroes tps-ninja's own bgAlpha)
    // instead of painting the theme's background color, so the board blends
    // into whichever side of a viewer's light/dark toggle they're on.
    transparent?: boolean;
    // Canvas font-family string, trusted as-is - tps-ninja has no font
    // bundling/registration mechanism, so this only renders as intended on a
    // host that already has the named font installed.
    font?: string;
  }

  export interface TakCanvas {
    toBuffer(): Buffer;
  }

  export function TPStoPNG(options: TPStoPNGOptions, streamTo?: NodeJS.WritableStream | null): TakCanvas;
}
