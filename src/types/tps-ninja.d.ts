// tps-ninja ships no type declarations. Only the two functions used here are
// typed. See https://github.com/gruppler/TPS-Ninja for the full option set.
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
    // Highlights the squares touched by this ply; `tps` should already
    // reflect the position after it.
    hl?: string;
    player1?: string;
    player2?: string;
    // Theme id from tps-ninja's themes.js.
    theme?: string;
    // Transparent background instead of the theme's background color.
    transparent?: boolean;
    // Canvas font-family string; must be installed on the host.
    font?: string;
  }

  export interface TakCanvas {
    toBuffer(): Buffer;
  }

  export function TPStoPNG(options: TPStoPNGOptions, streamTo?: NodeJS.WritableStream | null): TakCanvas;
}
