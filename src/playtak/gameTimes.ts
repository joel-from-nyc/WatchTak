// When this process saw each game start. The protocol carries no start
// timestamp, so only games that began while the bot was connected have one;
// callers omit the "started" line for the rest. Not persisted.
const startedAtByGame = new Map<number, number>();

export function noteGameStarted(gameNo: number, atMs: number = Date.now()): void {
  if (!startedAtByGame.has(gameNo)) startedAtByGame.set(gameNo, atMs);
}

export function getGameStartedAt(gameNo: number): number | undefined {
  return startedAtByGame.get(gameNo);
}
