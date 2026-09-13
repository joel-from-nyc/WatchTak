import type { WatchState } from './watcher';
import { formatSeconds } from './format';

// "Running low on time" warnings for the player on the clock. PlayTak only
// sends clock updates at move boundaries, never while a player is thinking,
// so the moment they cross the threshold is computed from their clock at
// turn start rather than waited for. The warning is a `<t:...:R>` countdown
// that ticks client-side; it is edited to static text once something
// resolves it (a move, an undo, or the game ending).

// A player is warned once their clock drops below this.
const LOW_TIME_THRESHOLD_SECONDS = 60;

export function clearLowTimeTimer(state: WatchState): void {
  if (state.lowTimeTimer) clearTimeout(state.lowTimeTimer);
  state.lowTimeTimer = undefined;
}

export function scheduleLowTimeWarning(state: WatchState): void {
  clearLowTimeTimer(state);
  if (!state.live) return;
  // Clocks do not run until both players have made their opening move.
  if (state.plies.length < 2) return;

  const isWhite = state.plies.length % 2 === 0;
  const seconds = isWhite ? state.whiteSeconds : state.blackSeconds;
  if (seconds === undefined) return;

  const flagAtMs = Date.now() + seconds * 1000;
  const delayMs = Math.max(0, (seconds - LOW_TIME_THRESHOLD_SECONDS) * 1000);
  const generation = state.lowTimeGeneration ?? 0;
  state.lowTimeTimer = setTimeout(() => {
    state.lowTimeTimer = undefined;
    postLowTimeWarning(state, isWhite, flagAtMs, generation).catch((err) => {
      console.error(`Failed to post low-time warning for game #${state.gameNo}:`, err);
    });
  }, delayMs);
}

// Final text for a resolved warning. When the warned player's own move ended
// it (`afterMove`), the latest clock value already includes the increment
// credited for that move, so the increment is subtracted to show the clock as
// it stood when they moved.
function staleWarningText(state: WatchState, color: 'white' | 'black', afterMove: boolean): string {
  const player = color === 'white' ? state.white : state.black;
  const rawSeconds = color === 'white' ? state.whiteSeconds : state.blackSeconds;
  if (rawSeconds === undefined) return `${player} was running low on time.`;
  const seconds = afterMove ? Math.max(0, rawSeconds - state.incrementSeconds) : rawSeconds;
  return `${player} was running low on time (${formatSeconds(seconds)} left).`;
}

// If the warning was resolved while the send was in flight (the generation
// moved on), the new message is edited straight to its final text, since
// nothing else will ever resolve it.
async function postLowTimeWarning(
  state: WatchState,
  isWhite: boolean,
  flagAtMs: number,
  generation: number,
): Promise<void> {
  if (state.lowTimeWarning) return;

  const player = isWhite ? state.white : state.black;
  const message = await state.thread
    .send(`${player} will lose on time <t:${Math.floor(flagAtMs / 1000)}:R>`)
    .catch((err) => {
      console.error(`Failed to post low-time warning for game #${state.gameNo}:`, err);
      return null;
    });
  if (!message) return;

  if ((state.lowTimeGeneration ?? 0) !== generation) {
    const text = staleWarningText(state, isWhite ? 'white' : 'black', state.lastResolutionAfterMove ?? false);
    await message.edit(text).catch(() => {});
    return;
  }

  state.lowTimeWarning = { message, color: isWhite ? 'white' : 'black' };
}

// Replaces a live countdown with static text. Always bumps the generation,
// even with no warning showing, to catch one still in flight.
export async function resolveLowTimeWarning(state: WatchState, afterMove: boolean): Promise<void> {
  state.lowTimeGeneration = (state.lowTimeGeneration ?? 0) + 1;
  state.lastResolutionAfterMove = afterMove;
  clearLowTimeTimer(state);
  const warning = state.lowTimeWarning;
  if (!warning) return;
  state.lowTimeWarning = undefined;
  await warning.message.edit(staleWarningText(state, warning.color, afterMove)).catch(() => {});
}
