import { Client, TextChannel, ThreadChannel, AttachmentBuilder, Message } from 'discord.js';
import { PlaytakClient } from './client';
import { GameListEntry, PlaytakEvent } from './protocol';
import { GameRegistry } from './registry';
import { placeToPtn, spreadToPtn, moveLabelToPly } from './ptn';
import { renderBoardPng } from './boardImage';
import { describeResult } from './result';
import { buildPtnNinjaLink } from './ptnLink';
import { formatGameType, formatKomi, formatPlayerName, discordTime, formatDuration, codeBlock, alignedLine } from './format';
import {
  buildChunkContents,
  moveOnlyText,
  parseChunkHeader,
  INLINE_CATCHUP_MAX_PLIES,
  MOVE_LABEL_WIDTH,
} from './catchup';
import { fetchArchivedGame } from './gameArchive';
import { getRating } from './ratings';
import { getGameStartedAt } from './gameTimes';

// On Observe, PlayTak replays the game's full move history using the same
// message shapes as live moves. Moves are buffered as history until none has
// arrived for this long; only then does live posting start.
const HISTORY_SETTLE_MS = 500;

const THREAD_CLOSE_DELAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

// A finished game's thread carries one close-lifecycle message, in one of two
// states: the pending warning (with a `<t:...:R>` deadline), or the archived
// record closeThread() rewrites it into.
const CLOSE_WARNING_PREFIX = 'This thread will be archived';
const CLOSE_ARCHIVED_PREFIX = 'This thread was archived on';
const CLOSE_MARKER_PATTERN = new RegExp(`^(?:${CLOSE_WARNING_PREFIX}|${CLOSE_ARCHIVED_PREFIX})`);

// Extracts the close deadline (Unix seconds) from a pending warning message.
const CLOSE_WARNING_DEADLINE_PATTERN = /<t:(\d+):R>/;

// A warning is only rewritten when its deadline moves by more than this.
const CLOSE_DEADLINE_SLOP_MS = 60 * 1000;

// Every watch thread's name ends in "(#<gameNo>)", so threads can be matched
// back to games from Discord's thread list alone after a restart.
const THREAD_NAME_PATTERN = /\(#(\d+)\)$/;

// A player is warned once their clock drops below this.
const LOW_TIME_THRESHOLD_SECONDS = 60;

interface WatchState {
  gameNo: number;
  thread: ThreadChannel;
  white: string;
  black: string;
  boardSize: number;
  komi: number;
  incrementSeconds: number;
  plies: string[];
  live: boolean;
  // Remaining time from the most recent clock event; undefined until one arrives.
  whiteSeconds?: number;
  blackSeconds?: number;
  settleTimer?: NodeJS.Timeout;
  // What to post once the history replay settles:
  //   'newThread' - the full history as chunk summaries plus the current board.
  //   'reconnect' - only the moves after `catchupFromPly`, which the thread
  //                 already shows: drawn inline for small gaps, chunked otherwise.
  //   'resume'    - the thread's existing content is unknown; post the current
  //                 board only.
  historyMode: 'newThread' | 'reconnect' | 'resume';
  // Ply count the thread already shows ('reconnect' mode only).
  catchupFromPly?: number;
  // The live low-time countdown message, if one is showing. Only the player
  // on the clock can have one. Cleared by resolveLowTimeWarning().
  lowTimeWarning?: { message: Message; color: 'white' | 'black' };
  // Fires when the player on the clock crosses the threshold.
  lowTimeTimer?: NodeJS.Timeout;
  // Incremented each time a warning is resolved, so a warning whose send was
  // still in flight at that moment can detect it is already stale.
  lowTimeGeneration?: number;
  // Whether the last resolution was caused by the warned player's own move
  // (which affects the clock value shown - see staleWarningText()).
  lastResolutionAfterMove?: boolean;
  // A /expand new replay thread receiving a copy of every post. In-memory
  // only; a restart drops the link.
  mirrorThread?: ThreadChannel;
}

// Keyed by PlayTak game number. One bot instance serves one Discord server,
// so a game is only ever watched in one thread.
const activeWatches = new Map<number, WatchState>();

// Thread creation in progress per game, so two simultaneous watch requests
// share one thread instead of each creating their own.
const inFlightWatches = new Map<number, Promise<{ thread: ThreadChannel; alreadyWatching: boolean }>>();
const inFlightReconstructs = new Map<number, Promise<ThreadChannel | undefined>>();

// Every thread this process has opened, kept after the game ends so a
// finished game's notice can still link to it. Not persisted.
const watchedThreads = new Map<number, ThreadChannel>();

export function getWatchedThread(gameNo: number): ThreadChannel | undefined {
  return watchedThreads.get(gameNo);
}

export function isGameActivelyWatched(gameNo: number): boolean {
  return activeWatches.has(gameNo);
}

// Read-only copy of a watched game's position. `plies` is a snapshot, and
// `live` is false while a history replay is still settling.
export interface WatchSnapshot {
  plies: string[];
  boardSize: number;
  komi: number;
  white: string;
  black: string;
  live: boolean;
}

export function getActiveWatchSnapshot(gameNo: number): WatchSnapshot | undefined {
  const state = activeWatches.get(gameNo);
  if (!state) return undefined;
  return {
    plies: [...state.plies],
    boardSize: state.boardSize,
    komi: state.komi,
    white: state.white,
    black: state.black,
    live: state.live,
  };
}

// Attaches a replay thread as the game's live mirror. Returns false if the
// game is not actively watched or already has a mirror.
export function attachMirrorThread(gameNo: number, thread: ThreadChannel): boolean {
  const state = activeWatches.get(gameNo);
  if (!state || state.mirrorThread) return false;
  state.mirrorThread = thread;
  return true;
}

function threadName(white: string, black: string, gameNo: number): string {
  return `${white} vs ${black} (#${gameNo})`;
}

// Reverses threadName(). PlayTak usernames contain no spaces, so " vs " is an
// unambiguous separator.
export function parseThreadName(name: string): { white: string; black: string; gameNo: number } | undefined {
  const match = /^(.+) vs (.+) \(#(\d+)\)$/.exec(name);
  if (!match) return undefined;
  return { white: match[1], black: match[2], gameNo: Number(match[3]) };
}

function formatSeconds(totalSeconds: number): string {
  const clamped = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// "White Time"/"Black Time" lines, or none if the clocks are not known yet.
function timeLines(state: WatchState): string[] {
  if (state.whiteSeconds === undefined || state.blackSeconds === undefined) return [];
  return [
    alignedLine('White Time', formatSeconds(state.whiteSeconds), MOVE_LABEL_WIDTH),
    alignedLine('Black Time', formatSeconds(state.blackSeconds), MOVE_LABEL_WIDTH),
  ];
}

// A move post. The "Move:" line starts with "<number><W|B>", which
// findKnownPlyCount() parses back out of thread history after a restart.
function moveText(state: WatchState, ply: number, ptn: string): string {
  const isWhite = ply % 2 === 0;
  const moveNumber = Math.floor(ply / 2) + 1;
  const colorLetter = isWhite ? 'W' : 'B';
  const lines = [
    alignedLine('Move', `${moveNumber}${colorLetter}. ${ptn}`, MOVE_LABEL_WIDTH),
    ...timeLines(state),
  ];
  return codeBlock(lines);
}

// A board post with no specific move: the first board of a game, or the
// position after an undo empties the ply list.
function currentPositionText(state: WatchState): string {
  const time = timeLines(state);
  return codeBlock(time.length > 0 ? ['Current position', '', ...time] : ['Current position']);
}

interface WatchStartOptions {
  white: string;
  black: string;
  gameNo: number;
  boardSize: number;
  minutes: number;
  incrementSeconds: number;
  komi: string;
  gameType: string;
  startedAtMs?: number;
  note?: string;
}

// The thread's opening message. Player names arrive already formatted with
// ratings. The start time goes after the code block because Discord does not
// render `<t:...>` timestamps inside one.
function watchStartText(options: WatchStartOptions): string {
  const width = Math.max('Board'.length, 'Time'.length, 'Komi'.length, 'Type'.length);
  const lines = [`${options.white} vs ${options.black} (#${options.gameNo})`];
  if (options.note) lines.push(options.note);
  lines.push(
    '',
    alignedLine('Board', `${options.boardSize}x${options.boardSize}`, width),
    alignedLine('Time', `${options.minutes}+${options.incrementSeconds}`, width),
    alignedLine('Komi', options.komi, width),
    alignedLine('Type', options.gameType, width),
  );
  const block = codeBlock(lines);
  return options.startedAtMs === undefined ? block : `${block}\nStarted ${discordTime(options.startedAtMs)}`;
}

function clearLowTimeTimer(state: WatchState): void {
  if (state.lowTimeTimer) clearTimeout(state.lowTimeTimer);
  state.lowTimeTimer = undefined;
}

// Schedules the low-time warning for the player on the clock. PlayTak only
// sends clock updates at move boundaries, never while a player is thinking,
// so the moment they cross the threshold is computed from their clock at turn
// start rather than waited for.
function scheduleLowTimeWarning(state: WatchState): void {
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

// Posts the countdown (`<t:...:R>` ticks client-side with no further edits).
// If the warning was resolved while the send was in flight - the generation
// moved on - the new message is edited straight to its final text, since
// nothing else will ever resolve it.
async function postLowTimeWarning(state: WatchState, isWhite: boolean, flagAtMs: number, generation: number): Promise<void> {
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
async function resolveLowTimeWarning(state: WatchState, afterMove: boolean): Promise<void> {
  state.lowTimeGeneration = (state.lowTimeGeneration ?? 0) + 1;
  state.lastResolutionAfterMove = afterMove;
  clearLowTimeTimer(state);
  const warning = state.lowTimeWarning;
  if (!warning) return;
  state.lowTimeWarning = undefined;
  await warning.message.edit(staleWarningText(state, warning.color, afterMove)).catch(() => {});
}

// Archives and locks the thread, then rewrites the close marker to record
// when that happened. Archive and lock go in one edit so a message cannot
// land between them and reopen the thread. Locking needs Manage Threads;
// if the combined edit is refused, archive alone. Safe to call repeatedly.
async function closeThread(thread: ThreadChannel, marker: CloseMarker | undefined): Promise<void> {
  const archived = await thread
    .edit({ archived: true, locked: true })
    .then(() => true)
    .catch(async (err) => {
      console.error(`Failed to archive+lock thread ${thread.id}, trying archive alone:`, err);
      return thread
        .setArchived(true)
        .then(() => true)
        .catch((fallbackErr) => {
          console.error(`Failed to archive thread ${thread.id}:`, fallbackErr);
          return false;
        });
    });
  if (!archived || !marker || marker.alreadyArchived) return;
  await marker.message.edit(`${CLOSE_ARCHIVED_PREFIX} <t:${Math.floor(Date.now() / 1000)}:D>.`).catch(() => {});
}

// Posts text and board image as one message. `plies` defaults to the current
// position; the last ply given is highlighted. Returns the PNG so a mirror
// post can reuse it.
async function postBoard(state: WatchState, content: string, plies: string[] = state.plies): Promise<Buffer> {
  const png = renderBoardPng(state.boardSize, state.komi, plies, state.white, state.black);
  const attachment = new AttachmentBuilder(png, { name: 'board.png' });
  await state.thread.send({ content, files: [attachment] });
  return png;
}

// Copies a post into the replay thread, if one is attached. Failures are
// logged and never affect the main thread.
async function mirrorSend(state: WatchState, content: string, png?: Buffer): Promise<void> {
  const mirror = state.mirrorThread;
  if (!mirror) return;
  try {
    if (png) {
      await mirror.send({ content, files: [new AttachmentBuilder(png, { name: 'board.png' })] });
    } else {
      await mirror.send(content);
    }
  } catch (err) {
    console.error(`Failed to mirror a post into the replay thread for game #${state.gameNo}:`, err);
  }
}

// (Re)starts the settle timer. When it fires, the buffered history is posted
// according to `historyMode` and the watch goes live.
function armSettleTimer(state: WatchState): void {
  if (state.settleTimer) clearTimeout(state.settleTimer);
  state.settleTimer = setTimeout(async () => {
    state.live = true;
    try {
      if (state.historyMode === 'newThread' && state.plies.length > 0) {
        for (const content of buildChunkContents(state.plies, 0)) {
          await state.thread.send(content);
        }
        await postBoard(state, currentPositionText(state));
      } else if (state.historyMode === 'reconnect') {
        const fromPly = state.catchupFromPly ?? 0;
        const missed = state.plies.slice(fromPly);
        if (missed.length > 0) {
          if (missed.length <= INLINE_CATCHUP_MAX_PLIES) {
            // Clock values are unknown for missed moves, so bare Move lines.
            // The last board drawn is the current position.
            for (let k = fromPly; k < state.plies.length; k++) {
              await postBoard(state, moveOnlyText(k, state.plies[k]), state.plies.slice(0, k + 1));
            }
          } else {
            for (const content of buildChunkContents(state.plies, fromPly)) {
              await state.thread.send(content);
            }
            await postBoard(state, currentPositionText(state));
          }
          // A replay thread always gets board-per-move.
          if (state.mirrorThread) {
            for (let k = fromPly; k < state.plies.length; k++) {
              const png = renderBoardPng(state.boardSize, state.komi, state.plies.slice(0, k + 1), state.white, state.black);
              await mirrorSend(state, moveOnlyText(k, state.plies[k]), png);
            }
          }
        }
      } else {
        await postBoard(state, currentPositionText(state));
      }
    } catch (err) {
      console.error(`Failed to post caught-up position for game #${state.gameNo}:`, err);
    }
    // The player to move may already be deep into their think.
    scheduleLowTimeWarning(state);
  }, HISTORY_SETTLE_MS);
}

function beginObserving(playtak: PlaytakClient, state: WatchState): void {
  activeWatches.set(state.gameNo, state);
  watchedThreads.set(state.gameNo, state.thread);
  armSettleTimer(state);
  playtak.send(`Observe ${state.gameNo}`);
}

function warningText(deadlineMs: number): string {
  return `${CLOSE_WARNING_PREFIX} <t:${Math.floor(deadlineMs / 1000)}:R>.`;
}

// Runs reconcileClose() at `atMs`. The marker is re-read at that point rather
// than trusted from when the timer was armed, since the deadline may have
// moved; a missing marker is left for the sweep.
function armCloseTimer(thread: ThreadChannel, atMs: number): void {
  setTimeout(
    () => {
      findCloseMarker(thread)
        .then((marker) => (marker ? reconcileClose(thread, marker) : undefined))
        .catch((err) => console.error(`Failed to close thread ${thread.id} on schedule:`, err));
    },
    Math.max(0, atMs - Date.now()),
  );
}

async function scheduleClose(thread: ThreadChannel): Promise<void> {
  const deadlineMs = Date.now() + THREAD_CLOSE_DELAY_MS;
  await thread.send(warningText(deadlineMs)).catch(() => {});
  armCloseTimer(thread, deadlineMs);
}

// When the thread should close: 24h after its most recent message, or the
// deadline its warning already shows, whichever is later. Ongoing discussion
// keeps pushing the close out, and a reopened thread gets a fresh 24h.
function closeDueAt(marker: CloseMarker): number {
  const fromActivity = marker.lastActivityMs + THREAD_CLOSE_DELAY_MS;
  return marker.deadlineMs === undefined ? fromActivity : Math.max(marker.deadlineMs, fromActivity);
}

// Closes the thread if due; otherwise rewrites the marker in place when its
// deadline has moved (or it still reads "was archived" after a reopen) and
// re-arms the timer. Shared by the close timer and the sweep.
async function reconcileClose(thread: ThreadChannel, marker: CloseMarker): Promise<void> {
  const dueAt = closeDueAt(marker);
  if (Date.now() >= dueAt) {
    await closeThread(thread, marker);
    return;
  }
  const shown = marker.alreadyArchived ? undefined : marker.deadlineMs;
  if (shown !== undefined && Math.abs(dueAt - shown) <= CLOSE_DEADLINE_SLOP_MS) return;
  await marker.message.edit(warningText(dueAt)).catch(() => {});
  armCloseTimer(thread, dueAt);
}

async function handleGameEnd(playtak: PlaytakClient, state: WatchState, resultText: string): Promise<void> {
  const ptnLink = buildPtnNinjaLink(state.gameNo);
  // No move ended the game, so no increment was credited: show the raw clock.
  await resolveLowTimeWarning(state, false);
  // Link and timestamp stay outside the code block, where Discord renders them.
  const endedAt = Date.now();
  const startedAt = getGameStartedAt(state.gameNo);
  const endedLine =
    startedAt === undefined
      ? `Ended ${discordTime(endedAt)}`
      : `Ended ${discordTime(endedAt)} · lasted ${formatDuration(endedAt - startedAt)}`;
  const gameOverText = `${codeBlock(['Game Over', '', resultText])}\n${endedLine}\n[View full game on ptn.ninja](${ptnLink})`;
  await state.thread.send(gameOverText).catch(() => {});
  await mirrorSend(state, gameOverText);
  await scheduleClose(state.thread);
  if (state.mirrorThread) await scheduleClose(state.mirrorThread);

  activeWatches.delete(state.gameNo);
  playtak.send(`Unobserve ${state.gameNo}`);
}

// Handles one PlayTak event. Called strictly one at a time (see
// registerWatcher()) so two events for the same game never read and mutate
// the same WatchState concurrently.
async function handleWatcherEvent(playtak: PlaytakClient, event: PlaytakEvent): Promise<void> {
  if (
    event.type !== 'gamePlace' &&
    event.type !== 'gameSpread' &&
    event.type !== 'gameOver' &&
    event.type !== 'gameAbandoned' &&
    event.type !== 'gameTime' &&
    event.type !== 'gameUndo'
  ) {
    return;
  }

  const state = activeWatches.get(event.gameNo);
  if (!state) return;

  if (event.type === 'gameTime') {
    state.whiteSeconds = event.whiteSeconds;
    state.blackSeconds = event.blackSeconds;
    return;
  }

  if (event.type === 'gameOver') {
    await handleGameEnd(playtak, state, describeResult(event.result, state.white, state.black));
    return;
  }
  if (event.type === 'gameAbandoned') {
    await handleGameEnd(playtak, state, `${event.quittingPlayer} abandoned the game.`);
    return;
  }

  if (event.type === 'gameUndo') {
    if (state.plies.length === 0) return;

    const undonePly = state.plies.length - 1;
    const undoingPlayer = undonePly % 2 === 0 ? state.white : state.black;
    state.plies.pop();

    // Still replaying history: just correct the buffer.
    if (!state.live) {
      armSettleTimer(state);
      return;
    }

    try {
      // An undo credits no increment: show the raw clock.
      await resolveLowTimeWarning(state, false);
      const undoText = codeBlock(['Move taken back', '', `${undoingPlayer} took back their move.`]);
      await state.thread.send(undoText);
      await mirrorSend(state, undoText);
      if (state.plies.length === 0) {
        const png = await postBoard(state, currentPositionText(state));
        await mirrorSend(state, currentPositionText(state), png);
      } else {
        const ply = state.plies.length - 1;
        const content = moveText(state, ply, state.plies[ply]);
        const png = await postBoard(state, content);
        await mirrorSend(state, content, png);
      }
    } catch (err) {
      console.error(`Failed to post undo for game #${event.gameNo}:`, err);
    }
    scheduleLowTimeWarning(state);
    return;
  }

  const ptn = event.type === 'gamePlace' ? placeToPtn(event.move) : spreadToPtn(event.move);

  if (!state.live) {
    state.plies.push(ptn);
    armSettleTimer(state);
    return;
  }

  const ply = state.plies.length;
  state.plies.push(ptn);
  try {
    // The mover's clock already has this move's increment credited.
    await resolveLowTimeWarning(state, true);
    const content = moveText(state, ply, ptn);
    const png = await postBoard(state, content);
    await mirrorSend(state, content, png);
  } catch (err) {
    console.error(`Failed to post move to thread for game #${event.gameNo}:`, err);
  }
  scheduleLowTimeWarning(state);
}

export function registerWatcher(playtak: PlaytakClient, discordClient: Client, registry: GameRegistry): void {
  // Events are chained through one promise so handlers never overlap.
  let eventQueue: Promise<void> = Promise.resolve();
  playtak.on('event', (event) => {
    eventQueue = eventQueue
      .then(() => handleWatcherEvent(playtak, event))
      .catch((err) => {
        console.error('Error handling PlayTak event in watcher:', err);
      });
  });

  // A reconnect loses every server-side Observe. Re-observe each watched
  // game; history replays again and the moves missed while disconnected are
  // posted once it settles ('reconnect' mode).
  playtak.on('connected', () => {
    for (const state of activeWatches.values()) {
      // Only a live watch knows what the thread already shows. If a previous
      // replay was still in flight, keep its catchupFromPly and mode.
      if (state.live) {
        state.catchupFromPly = state.plies.length;
        state.historyMode = 'reconnect';
      }
      state.live = false;
      state.plies = [];
      clearLowTimeTimer(state);
      beginObserving(playtak, state);
    }
  });

  // First sweep shortly after the initial connect (after the GameList replay
  // lands), then periodically.
  playtak.once('connected', () => {
    const runSweep = () => {
      sweepThreads(discordClient, playtak, registry).catch((err) => {
        console.error('Thread sweep failed:', err);
      });
    };
    setTimeout(runSweep, 2000);
    setInterval(runSweep, SWEEP_INTERVAL_MS);
  });
}

// Re-fetches the thread: deleted threads throw, and a manually archived one
// is not reused.
async function isThreadUsable(thread: ThreadChannel): Promise<boolean> {
  try {
    const fresh = await thread.fetch();
    return !fresh.archived;
  } catch {
    return false;
  }
}

// Reuses a thread from before a restart if Discord still has one for this
// game; otherwise creates a new thread and starts observing.
async function createOrReattachThread(
  playtak: PlaytakClient,
  parentChannel: TextChannel,
  game: GameListEntry,
): Promise<{ thread: ThreadChannel; alreadyWatching: boolean }> {
  const botId = parentChannel.client.user?.id;
  const found = await findExistingThread(parentChannel, game.gameNo, botId, false);
  if (found) {
    await resumeWatchingThread(playtak, found, game);
    return { thread: found, alreadyWatching: true };
  }

  const thread = await parentChannel.threads.create({
    name: threadName(game.white, game.black, game.gameNo),
    autoArchiveDuration: 1440,
  });

  await thread.send(
    watchStartText({
      white: formatPlayerName(game.white, getRating(game.white)),
      black: formatPlayerName(game.black, getRating(game.black)),
      gameNo: game.gameNo,
      boardSize: game.boardSize,
      minutes: Math.floor(game.timeSeconds / 60),
      incrementSeconds: game.incrementSeconds,
      komi: formatKomi(game.komi),
      gameType: formatGameType(game.unrated, game.tournament),
      startedAtMs: getGameStartedAt(game.gameNo),
    }),
  );

  const state: WatchState = {
    gameNo: game.gameNo,
    thread,
    white: game.white,
    black: game.black,
    boardSize: game.boardSize,
    // Wire komi is in half-points.
    komi: game.komi / 2,
    incrementSeconds: game.incrementSeconds,
    plies: [],
    live: false,
    historyMode: 'newThread',
  };
  beginObserving(playtak, state);

  return { thread, alreadyWatching: false };
}

// One thread per game: reuse the active watch's thread, or an in-flight
// creation, or a thread Discord already has, before creating a new one.
export async function watchGame(
  playtak: PlaytakClient,
  parentChannel: TextChannel,
  game: GameListEntry,
): Promise<{ thread: ThreadChannel; alreadyWatching: boolean }> {
  const existing = activeWatches.get(game.gameNo);
  if (existing) {
    if (await isThreadUsable(existing.thread)) {
      return { thread: existing.thread, alreadyWatching: true };
    }
    if (existing.settleTimer) clearTimeout(existing.settleTimer);
    clearLowTimeTimer(existing);
    activeWatches.delete(game.gameNo);
    playtak.send(`Unobserve ${game.gameNo}`);
  }

  const inFlight = inFlightWatches.get(game.gameNo);
  if (inFlight) {
    const { thread } = await inFlight;
    return { thread, alreadyWatching: true };
  }

  const promise = createOrReattachThread(playtak, parentChannel, game);
  inFlightWatches.set(game.gameNo, promise);
  try {
    return await promise;
  } finally {
    inFlightWatches.delete(game.gameNo);
  }
}

// Builds a thread for a finished game from PlayTak's archive. Never sends
// Observe or arms timers. Returns undefined if the archive has no record.
export async function reconstructThread(parentChannel: TextChannel, gameNo: number): Promise<ThreadChannel | undefined> {
  const inFlight = inFlightReconstructs.get(gameNo);
  if (inFlight) return inFlight;

  const promise = createReconstructedThread(parentChannel, gameNo);
  inFlightReconstructs.set(gameNo, promise);
  try {
    return await promise;
  } finally {
    inFlightReconstructs.delete(gameNo);
  }
}

async function createReconstructedThread(parentChannel: TextChannel, gameNo: number): Promise<ThreadChannel | undefined> {
  // A finished game's thread is likely archived, so archived threads are
  // searched too.
  const botId = parentChannel.client.user?.id;
  const found = await findExistingThread(parentChannel, gameNo, botId, true);
  if (found) {
    watchedThreads.set(gameNo, found);
    return found;
  }

  const archived = await fetchArchivedGame(gameNo);
  if (!archived) return undefined;

  const thread = await parentChannel.threads.create({
    name: threadName(archived.white, archived.black, gameNo),
    autoArchiveDuration: 1440,
  });
  watchedThreads.set(gameNo, thread);

  // Just enough state for postBoard() to render the final position.
  const state: WatchState = {
    gameNo,
    thread,
    white: archived.white,
    black: archived.black,
    boardSize: archived.boardSize,
    komi: archived.komi / 2,
    incrementSeconds: archived.incrementSeconds,
    plies: archived.plies,
    live: true,
    historyMode: 'newThread',
  };

  await thread.send(
    watchStartText({
      white: formatPlayerName(archived.white, archived.ratingWhite),
      black: formatPlayerName(archived.black, archived.ratingBlack),
      gameNo,
      boardSize: archived.boardSize,
      minutes: Math.floor(archived.timeSeconds / 60),
      incrementSeconds: archived.incrementSeconds,
      komi: formatKomi(archived.komi),
      gameType: formatGameType(archived.unrated, archived.tournament),
      startedAtMs: archived.startedAtMs,
      note: "Reconstructed from PlayTak's archive - nobody was watching this game live.",
    }),
  );

  if (archived.plies.length > 0) {
    for (const content of buildChunkContents(archived.plies, 0)) {
      await thread.send(content);
    }
  }
  await postBoard(state, currentPositionText(state));

  const ptnLink = buildPtnNinjaLink(gameNo);
  await thread.send(
    `${codeBlock(['Game Over', '', describeResult(archived.result, archived.white, archived.black)])}\n` +
      `[View full game on ptn.ninja](${ptnLink})`,
  );

  return thread;
}

// A thread's close-lifecycle message and what the close decision needs from it.
interface CloseMarker {
  message: Message;
  alreadyArchived: boolean;
  // Deadline shown by a pending warning. Undefined once archived or if
  // unparseable, in which case closeDueAt() uses activity alone, so a broken
  // marker can only delay a close.
  deadlineMs?: number;
  // Timestamp of the thread's newest message.
  lastActivityMs: number;
}

// Finds the thread's close marker among its last 100 messages (post-game
// discussion can run long, and missing the marker would post a duplicate).
async function findCloseMarker(thread: ThreadChannel): Promise<CloseMarker | undefined> {
  const recent = await thread.messages.fetch({ limit: 100 }).catch(() => null);
  const message = recent?.find((m) => CLOSE_MARKER_PATTERN.test(m.content));
  if (!recent || !message) return undefined;
  const lastActivityMs = Math.max(...recent.map((m) => m.createdTimestamp));
  if (message.content.startsWith(CLOSE_ARCHIVED_PREFIX)) return { message, alreadyArchived: true, lastActivityMs };

  const match = CLOSE_WARNING_DEADLINE_PATTERN.exec(message.content);
  return {
    message,
    alreadyArchived: false,
    deadlineMs: match ? Number(match[1]) * 1000 : undefined,
    lastActivityMs,
  };
}

// The "Move: <number><W|B>. <ptn>" line of a move post (see moveText()).
const MOVE_LINE_PATTERN = /^Move:\s+(\d+)([WB])\b/m;

// Recovers how many plies a thread already shows from its own messages: the
// highest ply in any move post or chunk summary header. Returns undefined
// when nothing carries a ply number.
async function findKnownPlyCount(thread: ThreadChannel): Promise<number | undefined> {
  const recent = await thread.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return undefined;

  let highestPly: number | undefined;
  for (const message of recent.values()) {
    const match = MOVE_LINE_PATTERN.exec(message.content);
    if (match) {
      const ply = moveLabelToPly(Number(match[1]), match[2] as 'W' | 'B');
      if (highestPly === undefined || ply > highestPly) highestPly = ply;
    }
    const chunk = parseChunkHeader(message.content);
    if (chunk && (highestPly === undefined || chunk.toPly > highestPly)) highestPly = chunk.toPly;
  }
  return highestPly === undefined ? undefined : highestPly + 1;
}

const MAX_ARCHIVED_THREAD_PAGES = 5;

// Finds this bot's thread for `gameNo` in the channel. Active threads are
// always checked; archived ones only when `includeArchived` is set, since
// paging through them costs extra API calls.
async function findExistingThread(
  parentChannel: TextChannel,
  gameNo: number,
  botId: string | undefined,
  includeArchived: boolean,
): Promise<ThreadChannel | undefined> {
  const active = await parentChannel.threads.fetchActive().catch(() => null);
  for (const thread of active?.threads.values() ?? []) {
    if (thread.ownerId === botId && parseThreadName(thread.name)?.gameNo === gameNo) return thread;
  }
  if (!includeArchived) return undefined;

  let before: ThreadChannel | undefined;
  for (let page = 0; page < MAX_ARCHIVED_THREAD_PAGES; page++) {
    const archived = await parentChannel.threads.fetchArchived({ limit: 100, before }).catch(() => null);
    if (!archived || archived.threads.size === 0) break;
    for (const thread of archived.threads.values()) {
      if (thread.ownerId === botId && parseThreadName(thread.name)?.gameNo === gameNo) return thread;
    }
    before = archived.threads.last();
    if (!archived.hasMore) break;
  }
  return undefined;
}

// Starts observing a game whose thread already exists. What the thread
// already shows is read from its message history so the catch-up covers
// only the moves it is missing.
async function resumeWatchingThread(playtak: PlaytakClient, thread: ThreadChannel, game: GameListEntry): Promise<void> {
  const knownPlyCount = await findKnownPlyCount(thread);
  beginObserving(playtak, {
    gameNo: game.gameNo,
    thread,
    white: game.white,
    black: game.black,
    boardSize: game.boardSize,
    komi: game.komi / 2,
    incrementSeconds: game.incrementSeconds,
    plies: [],
    live: false,
    historyMode: knownPlyCount === undefined ? 'resume' : 'reconnect',
    catchupFromPly: knownPlyCount,
  });
}

// Reconciles every open watch thread against live state, using Discord's
// thread list as the source of truth:
// - Game still active but not watched: resume watching it.
// - Game over: post the close warning if there is none, otherwise let
//   reconcileClose() close it when due or keep its deadline current.
export async function sweepThreads(discordClient: Client, playtak: PlaytakClient, registry: GameRegistry): Promise<void> {
  const botId = discordClient.user?.id;
  if (!botId) return;

  for (const guild of discordClient.guilds.cache.values()) {
    const active = await guild.channels.fetchActiveThreads().catch((err) => {
      console.error(`Failed to fetch active threads in guild ${guild.id}:`, err);
      return null;
    });
    if (!active) continue;

    for (const thread of active.threads.values()) {
      if (thread.ownerId !== botId) continue;
      const match = THREAD_NAME_PATTERN.exec(thread.name);
      if (!match) continue;

      const gameNo = Number(match[1]);
      const game = registry.find(gameNo);

      if (game) {
        if (!activeWatches.has(gameNo)) await resumeWatchingThread(playtak, thread, game);
        continue;
      }

      // A live game-over may still be mid-flight in handleGameEnd().
      if (activeWatches.has(gameNo)) continue;

      const marker = await findCloseMarker(thread);
      if (marker) {
        await reconcileClose(thread, marker);
      } else {
        await thread.send('This game appears to have ended.').catch(() => {});
        await scheduleClose(thread);
      }
    }
  }
}
