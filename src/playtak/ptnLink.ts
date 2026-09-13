// PlayTak redirects this URL into ptn.ninja preloaded with the game's PTN.
export function buildPtnNinjaLink(gameNo: number): string {
  return `https://playtak.com/games/${gameNo}/ninjaviewer`;
}
