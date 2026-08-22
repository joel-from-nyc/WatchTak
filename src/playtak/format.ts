// Shared text formatting for game/seek details shown in Discord messages
// (the /watch thread intro and /announce's seek posts).

// `halfKomi` is the raw wire value - double the real komi, e.g. 4 means 2
// komi, 5 means 2.5 komi (see Seek.java: `.komi(komi / 2.f)`). Half-point
// values are shown as "½" to match the convention tps-ninja's own board
// rendering uses.
export function formatKomi(halfKomi: number): string {
  const whole = Math.floor(halfKomi / 2);
  const isHalf = halfKomi % 2 !== 0;
  if (!isHalf) return String(whole);
  return whole > 0 ? `${whole}½` : '½';
}

export function formatGameType(unrated: boolean, tournament: boolean): string {
  if (tournament) return 'Tournament';
  return unrated ? 'Unrated' : 'Rated';
}

export function formatSeekColor(color: 'A' | 'W' | 'B'): string {
  if (color === 'A') return 'Random Color';
  return color === 'W' ? 'white' : 'black';
}
