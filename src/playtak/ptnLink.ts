// PlayTak's own server redirects this path straight into ptn.ninja, preloaded
// with that game's real PTN pulled from its own archive - confirmed by
// loading this URL for a real finished game id in a browser. No need to
// build a PTN document or call ptn.ninja's own link-shortening service
// ourselves; every caller already has the real PlayTak game number.
export function buildPtnNinjaLink(gameNo: number): string {
  return `https://playtak.com/games/${gameNo}/ninjaviewer`;
}
