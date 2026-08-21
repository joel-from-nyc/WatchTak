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
  }

  export interface TakCanvas {
    toBuffer(): Buffer;
  }

  export function TPStoPNG(options: TPStoPNGOptions, streamTo?: NodeJS.WritableStream | null): TakCanvas;
}
