// When this process saw each game begin, so a "started at" / "lasted this
// long" line can be shown on game notices and in watch threads.
//
// PlayTak's wire protocol carries no start timestamp at all - a `GameList Add`
// line is just the game's settings (see protocol.ts's GameListEntry), and the
// public archive only gains a record once the game has *finished*, so there's
// nothing to look a live game's start time up in either. The only games whose
// start time is knowable are the ones this process actually watched begin, via
// seekToGame.ts's seek/game correlation - so that's what's recorded here.
//
// A game already in progress when the bot connects (or restarts) therefore has
// no entry, and callers omit the line entirely rather than guessing or showing
// the time the bot happened to notice it.
//
// Deliberately not persisted and never evicted: one small entry per game
// started during this process's lifetime, same as watcher.ts's watchedThreads.
const startedAtByGame = new Map<number, number>();

export function noteGameStarted(gameNo: number, atMs: number = Date.now()): void {
  if (!startedAtByGame.has(gameNo)) startedAtByGame.set(gameNo, atMs);
}

export function getGameStartedAt(gameNo: number): number | undefined {
  return startedAtByGame.get(gameNo);
}
