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

// How long to wait with no further place/spread messages before treating the
// game as caught up to live play. On Observe, PlayTak immediately replays
// the full move history as the same message shapes live moves use, with no
// flag distinguishing "replay" from "live" - so a burst of moves arriving
// right after Observe is treated as history (used to rebuild the board and
// ply count, not announced), and live posting only starts once they've
// stopped arriving for this long. Also armed immediately on Observe so a
// brand-new game with zero history still goes live promptly.
const HISTORY_SETTLE_MS = 500;

const THREAD_CLOSE_DELAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

// Posted verbatim whenever a game-over is detected, whether live or by the
// sweep, with the actual archive deadline embedded as a Discord relative
// timestamp (see scheduleClose()). A thread's close-lifecycle post is either
// this, or - once closeThread() has rewritten it in place - the
// CLOSE_ARCHIVED_PREFIX text below; findCloseMarker() recognizes either
// state, since the message needs to stay findable across that rewrite (see
// its own comment for why that matters).
const CLOSE_WARNING_PREFIX = 'This thread will be archived';

// What closeThread() rewrites the warning message to once it actually
// archives the thread - the countdown in the original post is no longer
// useful once the event it counted down to has happened, so this replaces it
// with a plain record of when that was.
const CLOSE_ARCHIVED_PREFIX = 'This thread was archived on';

// Matches a close-lifecycle post in either state - see the two prefixes
// above and findCloseMarker().
const CLOSE_MARKER_PATTERN = new RegExp(`^(?:${CLOSE_WARNING_PREFIX}|${CLOSE_ARCHIVED_PREFIX})`);

// Recovers the Unix-seconds deadline embedded in a still-pending warning
// (the `<t:...:R>` scheduleClose() posts) - lets sweepThreads() ask "is it
// actually time yet?" instead of just "does a warning exist?", which used to
// let it archive a thread within one sweep interval of a game ending instead
// of the intended 24h later.
const CLOSE_WARNING_DEADLINE_PATTERN = /<t:(\d+):R>/;

// Embedded in every thread's name so a restarted bot (with no memory of its
// own) can recover which PlayTak game a thread belongs to just by reading
// Discord's own thread list - see sweepThreads().
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
  // Most recently known remaining time, from Game#<no> Time events.
  // Undefined until the first one arrives.
  whiteSeconds?: number;
  blackSeconds?: number;
  settleTimer?: NodeJS.Timeout;
  // 'newThread': this is the first time anyone has watched this game, so the
  // thread has no prior move history visible - post the full move list as
  // /expand-fillable chunk summaries once caught up (see catchup.ts).
  // 'reconnect': the thread already has moves up through `catchupFromPly`,
  // so cover only what came after (the moves actually missed while
  // disconnected) - drawn inline as boards when the gap is small, chunked
  // like newThread when it isn't. 'resume': a sweep match where
  // sweepThreads() couldn't work out what the thread already shows (see
  // findKnownPlyCount()) - skip the catch-up entirely rather than guess.
  historyMode: 'newThread' | 'reconnect' | 'resume';
  // Only meaningful when historyMode is 'reconnect' - the ply count the
  // thread already had text for before the disconnect (or, for a sweep
  // resume, before the restart - see findKnownPlyCount()).
  catchupFromPly?: number;
  // Set while a "running low on time" post is showing a live countdown for
  // the player currently to move. Only one can ever be relevant at a time,
  // since the side not to move has a frozen clock. Cleared (and the message
  // edited to a static line) the moment anything makes the countdown stale -
  // a move landing, an undo, or the game ending - see resolveLowTimeWarning().
  lowTimeWarning?: { message: Message; color: 'white' | 'black' };
  // Pending timer that will post the warning when the player on the clock
  // crosses the threshold mid-think - see scheduleLowTimeWarning().
  lowTimeTimer?: NodeJS.Timeout;
  // Bumped by resolveLowTimeWarning() every time something (a move, an undo,
  // the game ending) invalidates whatever low-time attempt is currently in
  // flight - lets postLowTimeWarning() detect that it went stale while its
  // `.send()` was still pending. See postLowTimeWarning() for why this is
  // needed. Undefined is treated as 0.
  lowTimeGeneration?: number;
  // Whether the resolution that produced the current lowTimeGeneration was
  // caused by the warned-about player's own move landing (as opposed to an
  // undo or the game ending some other way) - see resolveLowTimeWarning()
  // and staleWarningText() for why this changes what time gets displayed.
  lastResolutionAfterMove?: boolean;
  // A /expand new replay thread that has caught up on history and now
  // mirrors this game live: move posts, undo posts, reconnect catch-ups,
  // and the game-over announcement are duplicated into it (low-time
  // countdowns are not - they're edited-in-place messages, not worth
  // duplicate timer plumbing). In-memory only, deliberately: the replay
  // thread's name doesn't match THREAD_NAME_PATTERN, so after a restart
  // nothing re-adopts it - it just goes quiet and Discord's 24h inactivity
  // auto-archive retires it.
  mirrorThread?: ThreadChannel;
}

// One bot instance only ever lives in one Discord server, so a game is only
// ever watched from one place - keyed by PlayTak game number alone.
const activeWatches = new Map<number, WatchState>();

// Guards watchGame() against creating two threads for the same game: without
// this, two near-simultaneous calls for the same gameNo (e.g. two people
// clicking "Watch game" at almost the same moment) would both see nothing in
// `activeWatches` yet (it's only set once thread creation finishes) and both
// go on to create a thread. A second caller instead awaits the first's
// in-flight promise and gets the same thread back - see watchGame().
const inFlightWatches = new Map<number, Promise<{ thread: ThreadChannel; alreadyWatching: boolean }>>();

// Same dedup guard as inFlightWatches, for reconstructThread() (the Review
// path) instead of watchGame().
const inFlightReconstructs = new Map<number, Promise<ThreadChannel | undefined>>();

// Threads this process has opened, kept keyed by game number even after the
// game ends and its watch is torn down, so a "Review" link can still point at
// the thread afterwards (see seekToGame.ts). Bounded by how many games this
// process watched, and deliberately not persisted - after a restart there's
// no live notice left to relink anyway.
const watchedThreads = new Map<number, ThreadChannel>();

export function getWatchedThread(gameNo: number): ThreadChannel | undefined {
  return watchedThreads.get(gameNo);
}

// Whether this game's watch is still live right now - used by /prune to
// avoid deleting the thread for a game that's still actually being played/
// watched, even if it no longer matches current rules (mirrors the same
// "skip live" carve-out /prune already applies to message notices).
export function isGameActivelyWatched(gameNo: number): boolean {
  return activeWatches.has(gameNo);
}

// A read-only copy of an actively watched game's position for /expand -
// plies is a snapshot, not the live array, and `live` is false while a
// history replay is still settling (meaning the plies aren't yet known to
// be complete). The WatchState itself stays private to this module.
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

// Attaches a /expand new replay thread as this game's live mirror (see
// WatchState.mirrorThread). Refuses - returning false - if the game isn't
// actively watched anymore (it just ended, or was never live) or already
// has a mirror, so a caller can tell its caught-up replay won't be followed
// by live moves.
export function attachMirrorThread(gameNo: number, thread: ThreadChannel): boolean {
  const state = activeWatches.get(gameNo);
  if (!state || state.mirrorThread) return false;
  state.mirrorThread = thread;
  return true;
}

function threadName(white: string, black: string, gameNo: number): string {
  return `${white} vs ${black} (#${gameNo})`;
}

// Reverses threadName() - "White vs Black (#123)". Player names never
// contain spaces (PlayTak usernames are single wire tokens), so splitting on
// " vs " is unambiguous. Exported for /prune to recover the players a thread
// was created for from its name alone.
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

// "White Time"/"Black Time" lines, or none at all if remaining time isn't
// known yet - shared by every message kind that shows the clock (move,
// current position).
function timeLines(state: WatchState): string[] {
  if (state.whiteSeconds === undefined || state.blackSeconds === undefined) return [];
  return [
    alignedLine('White Time', formatSeconds(state.whiteSeconds), MOVE_LABEL_WIDTH),
    alignedLine('Black Time', formatSeconds(state.blackSeconds), MOVE_LABEL_WIDTH),
  ];
}

// Text for "this ply was just played" - used both when a move actually just
// arrived live, and to redescribe the new current position after an undo
// (see the gameUndo handling below), since from the thread's perspective the
// ply now on top of `state.plies` reads the same either way. The "Move"
// line's value starts with the bare "<number><W/B>" - findKnownPlyCount()/
// MOVE_LINE_PATTERN depend on that prefix to recover ply counts from thread
// history after a cold restart.
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

// Text for a bare "here's the board" post with no specific move attached -
// the very first board of a game, or the state after an undo empties the ply
// list entirely.
function currentPositionText(state: WatchState): string {
  const time = timeLines(state);
  return codeBlock(time.length > 0 ? ['Current position', '', ...time] : ['Current position']);
}

// Thread-opening text - watchGame() and reconstructThread() both use this.
// Uses its own tight local label width (Board/Time/Komi/Type are all short)
// rather than MOVE_LABEL_WIDTH, since this block only ever appears once and
// stretching it to match move messages would just look sparse. `note` is an
// optional extra line for reconstructThread()'s "not watched live"
// disclosure.
// Player names arrive already rendered with their ratings (see
// formatPlayerName()) - this is the one place inside a watch thread that shows
// them, since repeating a rating on every move line would just add noise.
//
// `startedAtMs` is appended *after* the code block rather than as another
// aligned row, because Discord doesn't render `<t:...>` timestamps inside a
// fence - same reason the ptn.ninja link sits outside its block. Omitted
// entirely when the start time isn't known (see gameTimes.ts).
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

// Schedules the "running low on time" post for whoever is on the clock right
// now. This has to be timer-driven rather than reactive: PlayTak only pushes
// a clock update at move boundaries (one `Timems` immediately before each
// move message, carrying the post-move values) and sends nothing at all while
// a player is thinking - confirmed by observing live traffic, where an
// 18-second turn produced zero clock messages. So waiting for an update to
// tell us someone dropped under a minute would only ever catch a player who
// was *already* low when their turn began, never the long think that burns a
// healthy clock down - which is exactly the moment worth announcing.
//
// Instead, the clock at turn start tells us precisely when this player will
// cross the threshold, and when they'd flag if they never moved, so both the
// post and its countdown target are computed up front.
function scheduleLowTimeWarning(state: WatchState): void {
  clearLowTimeTimer(state);
  if (!state.live) return;
  // PlayTak doesn't start either player's clock until both have made their
  // (forced, untimed) opening move, so a countdown armed before that would
  // be counting down from a clock that isn't actually running yet.
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

// `afterMove` is true only when this resolution was caused by the warned
// player's own move landing. In that case the most recent Timems value
// already has this game's increment credited back onto their clock - Fischer
// increment is applied the instant a move completes - so it reads higher than
// what their clock actually showed the moment they clicked to move. Subtract
// it to show that real value instead. An undo or a game-ending event with no
// final move (resignation, flag, abandonment) never credited an increment, so
// the raw value is already correct there.
function staleWarningText(state: WatchState, color: 'white' | 'black', afterMove: boolean): string {
  const player = color === 'white' ? state.white : state.black;
  const rawSeconds = color === 'white' ? state.whiteSeconds : state.blackSeconds;
  if (rawSeconds === undefined) return `${player} was running low on time.`;
  const seconds = afterMove ? Math.max(0, rawSeconds - state.incrementSeconds) : rawSeconds;
  return `${player} was running low on time (${formatSeconds(seconds)} left).`;
}

// `<t:UNIX:R>` renders as a live relative countdown that ticks in the client
// with no further edits from us, so the post stays accurate on its own until
// something resolves it. `generation` is a snapshot of state.lowTimeGeneration
// taken when this attempt was scheduled - if a move, undo, or game end
// resolves the warning (bumping the generation) while the `.send()` below is
// still in flight, resolveLowTimeWarning() finds nothing yet to edit (this
// message doesn't exist yet) and no-ops. Without checking the generation
// here too, this function would then go on to store the message as "the"
// live warning once it finally lands - one nothing will ever resolve again,
// since the event that should have resolved it already happened. Comparing
// generations after the send catches that gap and edits the message to its
// final text immediately instead.
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

// Replaces a live countdown with a static, no-longer-ticking readout the
// moment it goes stale - a move landing, an undo, or the game ending. Only
// one warning can exist at a time, so this always resolves whichever one is
// pending regardless of what caused it, and is a no-op if none is pending
// (but still bumps the generation counter - see postLowTimeWarning() - since
// a warning can be "pending" in the sense of being in flight without having
// reached state.lowTimeWarning yet).
async function resolveLowTimeWarning(state: WatchState, afterMove: boolean): Promise<void> {
  state.lowTimeGeneration = (state.lowTimeGeneration ?? 0) + 1;
  state.lastResolutionAfterMove = afterMove;
  clearLowTimeTimer(state);
  const warning = state.lowTimeWarning;
  if (!warning) return;
  state.lowTimeWarning = undefined;
  await warning.message.edit(staleWarningText(state, warning.color, afterMove)).catch(() => {});
}

// `warningMessage` is the original "will be archived" post, when the caller
// already has it in hand (scheduleClose()'s own timer does); otherwise it's
// looked up fresh - the cold-restart path through sweepThreads() has no
// in-memory reference to reuse. `:D` (a plain date, no time) matches the
// "archived on" wording - the exact time isn't especially useful once the
// countdown that used to show it is gone.
//
// Safe to call more than once on the same thread - sweepThreads() does,
// whenever it finds one still (or again) active past its deadline (see its
// own comment on why that can happen). The message is only rewritten the
// first time (checked directly on its current text, not a separate flag,
// since that text IS the durable record of whether this already happened),
// and archiving/locking an already-archived thread is a harmless no-op.
async function closeThread(thread: ThreadChannel, warningMessage?: Message): Promise<void> {
  const message = warningMessage ?? (await findCloseMarker(thread))?.message;
  if (message && !message.content.startsWith(CLOSE_ARCHIVED_PREFIX)) {
    await message.edit(`${CLOSE_ARCHIVED_PREFIX} <t:${Math.floor(Date.now() / 1000)}:D>.`).catch(() => {});
  }

  // Archived and locked in one call rather than two separate ones - partly
  // tidiness, but mainly to close the window a two-call sequence leaves open
  // for a message (from a human still chatting) to land in between and
  // un-archive the thread again before it's actually locked.
  await thread.edit({ archived: true, locked: true }).catch((err) => {
    console.error(`Failed to archive/lock thread ${thread.id}:`, err);
  });
}

// Text and board image in the same message, so the board always lands right
// under the text describing it rather than as a separate, possibly
// out-of-order post. `plies` defaults to the full current position but can
// be a historical slice (renderBoardPng highlights the last ply of whatever
// it's given). Returns the rendered PNG so callers that also mirror the
// post (see mirrorSend()) don't render it twice.
async function postBoard(state: WatchState, content: string, plies: string[] = state.plies): Promise<Buffer> {
  const png = renderBoardPng(state.boardSize, state.komi, plies, state.white, state.black);
  const attachment = new AttachmentBuilder(png, { name: 'board.png' });
  await state.thread.send({ content, files: [attachment] });
  return png;
}

// Best-effort duplicate of a game post into the game's replay thread, if
// one is attached (see WatchState.mirrorThread) - a mirror failure must
// never break the main thread, so errors are logged and swallowed.
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

function armSettleTimer(state: WatchState): void {
  if (state.settleTimer) clearTimeout(state.settleTimer);
  state.settleTimer = setTimeout(async () => {
    state.live = true;
    try {
      if (state.historyMode === 'newThread' && state.plies.length > 0) {
        // Never board-per-move here, even for a short history - a freshly
        // opened thread starts with the compact summaries and the current
        // position, and readers opt into the full drawing via /expand.
        for (const content of buildChunkContents(state.plies, 0)) {
          await state.thread.send(content);
        }
        await postBoard(state, currentPositionText(state));
      } else if (state.historyMode === 'reconnect') {
        const fromPly = state.catchupFromPly ?? 0;
        const missed = state.plies.slice(fromPly);
        // Nothing actually happened while disconnected - no catch-up
        // needed, so stay quiet rather than post a redundant board.
        if (missed.length > 0) {
          if (missed.length <= INLINE_CATCHUP_MAX_PLIES) {
            // Few enough missed moves that drawing each one costs the same
            // number of messages a text summary would - so just draw them.
            // No clock values are known for missed moves, hence the bare
            // Move lines, and no trailing current-position board: the last
            // missed move's board IS the current position.
            for (let k = fromPly; k < state.plies.length; k++) {
              await postBoard(state, moveOnlyText(k, state.plies[k]), state.plies.slice(0, k + 1));
            }
          } else {
            for (const content of buildChunkContents(state.plies, fromPly)) {
              await state.thread.send(content);
            }
            await postBoard(state, currentPositionText(state));
          }
          // A replay thread's whole purpose is board-per-move, so it gets
          // the full missed range drawn inline regardless of how the main
          // thread summarized it.
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
    // Someone may already be deep into a think when we start watching, so arm
    // the warning here too rather than waiting for the next move to land.
    scheduleLowTimeWarning(state);
  }, HISTORY_SETTLE_MS);
}

function beginObserving(playtak: PlaytakClient, state: WatchState): void {
  activeWatches.set(state.gameNo, state);
  watchedThreads.set(state.gameNo, state.thread);
  armSettleTimer(state);
  playtak.send(`Observe ${state.gameNo}`);
}

async function scheduleClose(thread: ThreadChannel): Promise<void> {
  const closeAtMs = Date.now() + THREAD_CLOSE_DELAY_MS;
  const message = await thread
    .send(`${CLOSE_WARNING_PREFIX} <t:${Math.floor(closeAtMs / 1000)}:R>.`)
    .catch(() => undefined);
  setTimeout(() => closeThread(thread, message), THREAD_CLOSE_DELAY_MS);
}

async function handleGameEnd(playtak: PlaytakClient, state: WatchState, resultText: string): Promise<void> {
  const ptnLink = buildPtnNinjaLink(state.gameNo);
  // No move landed to end the game this way (resignation, flag, abandonment)
  // - no increment was credited, so show the raw clock value.
  await resolveLowTimeWarning(state, false);
  // Both the link and the timestamp stay outside the code block - masked links
  // don't render as clickable inside a fenced block, and `<t:...>` timestamps
  // don't render there at all.
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

// Handles one PlaytakEvent for the watcher. Extracted so registerWatcher()
// can run these strictly one at a time (see the queue below) rather than
// letting Node invoke this listener again for the next event before this
// one's awaited Discord API calls (postBoard's render+send is not cheap)
// have finished - without that, two events for the same fast-moving game
// (e.g. a move landing right as the other side's low-time warning is still
// mid-send) can both read/mutate the same WatchState concurrently, which is
// exactly what produced a duplicate low-time warning in testing: two
// scheduleLowTimeWarning() calls both ended up targeting the same player
// because the second one ran before the first's state updates had settled.
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
    // Nothing recorded yet to take back (e.g. an undo arriving mid
    // history-replay before any ply landed) - ignore rather than pop an
    // empty array.
    if (state.plies.length === 0) return;

    const undonePly = state.plies.length - 1;
    const undoingPlayer = undonePly % 2 === 0 ? state.white : state.black;
    state.plies.pop();

    // Still catching up on history - just correct the buffered plies and
    // let the settle timer's eventual catch-up post reflect the result;
    // no live announcement to make yet.
    if (!state.live) {
      armSettleTimer(state);
      return;
    }

    try {
      // An undo credits no increment - show the raw clock value.
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
    // This player's own move just landed - their clock already has this
    // game's increment credited back onto it.
    await resolveLowTimeWarning(state, true);
    const content = moveText(state, ply, ptn);
    const png = await postBoard(state, content);
    await mirrorSend(state, content, png);
  } catch (err) {
    console.error(`Failed to post move to thread for game #${event.gameNo}:`, err);
  }
  // The turn just changed hands - arm the next warning against whoever is
  // now on the clock.
  scheduleLowTimeWarning(state);
}

export function registerWatcher(playtak: PlaytakClient, discordClient: Client, registry: GameRegistry): void {
  // Chains every event through one FIFO queue so handleWatcherEvent() calls
  // never overlap - see its doc comment for why that matters.
  let eventQueue: Promise<void> = Promise.resolve();
  playtak.on('event', (event) => {
    eventQueue = eventQueue
      .then(() => handleWatcherEvent(playtak, event))
      .catch((err) => {
        console.error('Error handling PlayTak event in watcher:', err);
      });
  });

  // A dropped/reconnected WebSocket loses every server-side Observe
  // subscription. Re-subscribe to everything we were watching, the same way
  // a fresh watch starts: history replays again, so plies/live are reset.
  // The replay is silently reabsorbed rather than double-posted, but unlike
  // a plain resume, we know exactly what the thread already showed
  // (`catchupFromPly`), so once caught up the moves actually missed while
  // disconnected get covered - drawn as one board message per move when the
  // gap is small, or posted as /expand-fillable chunk summaries plus one
  // current-position board when it isn't (see armSettleTimer()).
  playtak.on('connected', () => {
    for (const state of activeWatches.values()) {
      // state.live is only true once a previous catch-up has actually
      // finished and the thread is known to be showing current plies - only
      // then does state.plies.length mean "what the thread displayed".
      // A reconnect landing while a previous replay is still in flight
      // (state.live already false) would otherwise overwrite
      // catchupFromPly with a partial replay count, corrupting what gets
      // printed as "missed" once things finally settle - so leave it (and
      // historyMode) untouched and just restart the observe.
      if (state.live) {
        state.catchupFromPly = state.plies.length;
        state.historyMode = 'reconnect';
      }
      state.live = false;
      state.plies = [];
      // Any pending warning timer was armed against a ply count that's about
      // to be rebuilt from scratch by the replay - drop it and let the
      // post-catch-up scheduling arm a fresh one.
      clearLowTimeTimer(state);
      beginObserving(playtak, state);
    }
  });

  // Run once shortly after connecting (covers a restart, giving the
  // just-pushed GameList burst a moment to land first), then periodically -
  // see sweepThreads() for why one pass handles both jobs.
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

// Re-fetches the thread from Discord to confirm it's still real - `fetch()`
// throws if it's been deleted, and a manually-archived thread (as opposed to
// one this bot archived itself on game end) shouldn't be silently reused.
async function isThreadUsable(thread: ThreadChannel): Promise<boolean> {
  try {
    const fresh = await thread.fetch();
    return !fresh.archived;
  } catch {
    return false;
  }
}

// The actual "no existing thread found anywhere" path - split out from
// watchGame() so the in-flight-dedup wrapper below has something to memoize
// per gameNo.
async function createOrReattachThread(
  playtak: PlaytakClient,
  parentChannel: TextChannel,
  game: GameListEntry,
): Promise<{ thread: ThreadChannel; alreadyWatching: boolean }> {
  // This process's own maps are reset on every restart, so before creating
  // anything, check Discord's actual thread list - a thread from before a
  // restart still counts, and reusing it (rather than creating a second one)
  // is the whole point of the "one thread per game" rule.
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
    // Wire komi is in half-point units (see Seek.java: `.komi(komi / 2.f)`).
    komi: game.komi / 2,
    incrementSeconds: game.incrementSeconds,
    plies: [],
    live: false,
    historyMode: 'newThread',
  };
  beginObserving(playtak, state);

  return { thread, alreadyWatching: false };
}

// Strict one-thread-per-game rule: a thread is only ever created here after
// two checks fail to find an existing one - `activeWatches` (this process's
// own live tracking) and, inside createOrReattachThread(), Discord's actual
// thread list (survives this process restarting). In between those two
// checks and a new thread actually landing, `inFlightWatches` also catches
// two near-simultaneous calls for the same game (see its own comment) - the
// second caller just awaits the first's result instead of racing it.
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

// Builds a Review thread for a finished game nobody watched live, from
// PlayTak's public archive rather than the (now-gone) live WebSocket state -
// see gameArchive.ts. Unlike watchGame()/beginObserving(), this never calls
// Observe or arms any timers: the game is over, there's nothing to
// subscribe to, only a record to lay out once. Returns undefined if the
// archive has no record of this game (caller shows a generic error).
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
  // Same "check Discord's actual thread list first" rule as watchGame() -
  // this process's own maps don't survive a restart, and a finished game's
  // thread is very likely archived by now, so archived threads are searched
  // too (unlike watchGame(), which only needs to check active ones).
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

  // A lightweight WatchState - just enough for currentPositionText()/
  // postBoard() to render the final position. No live tracking fields are
  // meaningful here (`live`/`historyMode` are unused off this path).
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

// A thread's close-lifecycle post, and which of its two states it's
// currently in (see CLOSE_WARNING_PREFIX/CLOSE_ARCHIVED_PREFIX).
// `deadlineMs`, only meaningful while still pending, is the actual moment
// scheduleClose() committed to archiving it. An undefined deadline
// (a malformed or missing timestamp) is treated by every caller as "not due"
// rather than "due", so a parse failure can only delay a close, never cause
// an early one.
interface CloseMarker {
  message: Message;
  alreadyArchived: boolean;
  deadlineMs?: number;
}

// Finds this thread's own close-lifecycle post, if it already has one - used
// to detect that (so sweepThreads() doesn't restart the warn-then-close
// cycle from scratch on every pass), to decide whether it's actually due yet
// (see CloseMarker above), and, via closeThread()'s fallback lookup, to find
// the message to rewrite once the thread is actually closed.
async function findCloseMarker(thread: ThreadChannel): Promise<CloseMarker | undefined> {
  const recent = await thread.messages.fetch({ limit: 10 }).catch(() => null);
  const message = recent?.find((m) => CLOSE_MARKER_PATTERN.test(m.content));
  if (!message) return undefined;
  if (message.content.startsWith(CLOSE_ARCHIVED_PREFIX)) return { message, alreadyArchived: true };

  const match = CLOSE_WARNING_DEADLINE_PATTERN.exec(message.content);
  return { message, alreadyArchived: false, deadlineMs: match ? Number(match[1]) * 1000 : undefined };
}

// Matches the "Move: <number><W/B>. <ptn>" line every move/undo post carries
// (see moveText()) - the only place a ply number appears in the thread's own
// history. `\s+` rather than a fixed count of spaces since MOVE_LABEL_WIDTH
// could change; the rest of the line (the "." and ptn) is ignored.
const MOVE_LINE_PATTERN = /^Move:\s+(\d+)([WB])\b/m;

// A cold restart has no memory of what a thread already showed - unlike a
// same-process WebSocket reconnect, there's no `state.plies` left over to
// diff against. Reconstructs the same information from the thread's own
// message history instead, by finding the highest ply number mentioned in
// any past move/undo post or covered by a catch-up chunk summary's header
// (see catchup.ts - a chunked move needs no board post to count as shown),
// so a resumed thread can still get a "what you missed" summary rather than
// silently jumping straight to a bare board (see sweepThreads()). Returns
// undefined - "unknown, don't guess" - if nothing in recent history carries
// a ply number, e.g. a brand-new game with zero moves posted yet.
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

// How many pages of archived threads findExistingThread() will page through
// looking for one game - mirrors /prune's own cap on the same API, for the
// same reason (bounded, not open-ended).
const MAX_ARCHIVED_THREAD_PAGES = 5;

// Searches this channel's own threads for one this bot already created for
// `gameNo`, so callers never end up creating a second thread for a game that
// already has one - this process's own in-memory maps (`activeWatches`,
// `watchedThreads`) are reset on every restart, so Discord's actual thread
// list is the only reliable source of truth (same reasoning as
// sweepThreads()). Active threads are always checked; archived ones only
// when `includeArchived` is set, since paging through them is only worth the
// extra API calls for reconstructThread() - a live /watch is latency-
// sensitive and a live game's thread is never archived anyway.
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

// Resumes watching a game whose thread already exists but isn't in
// `activeWatches` - shared by sweepThreads() (its periodic reconciliation)
// and watchGame() (the new-thread path, when findExistingThread() turns up a
// thread from before a restart). History replays again on the fresh Observe,
// so `findKnownPlyCount()` recovers what the thread already showed from its
// own message history, letting the eventual catch-up post show only what was
// actually missed rather than the whole game again.
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

// Reconciles every one of the bot's own open game threads against live
// PlayTak state, using Discord's own thread list as the source of truth
// (this process has no memory of its own once it exits or reconnects) -
// covers both jobs in one pass:
//
// - Still active but not currently in `activeWatches`? Something desynced
//   (a missed live update, a restart) - silently resume watching it. History
//   replays again on the fresh Observe, so this is the same "resume" path
//   used on reconnect.
// - No longer active? The game ended. If nothing's been posted about it yet,
//   warn and start its 24h clock, mirroring the live game-over path. If a
//   warning already exists, only actually close the thread once its
//   embedded deadline has passed (see findCloseMarker()) - not merely
//   because a warning exists, which used to archive every game's thread
//   within one sweep interval of it ending rather than the intended 24h
//   later. The in-memory setTimeout from the original scheduleClose() call
//   handles the common case with better precision than this sweep's own
//   interval could; this branch is what still closes it correctly if that
//   timer was lost to a restart, or if the thread reopened after being
//   closed once already (closeThread() is safe to call again either way).
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

      // Narrow window only: a live gameOver event can still be mid-flight
      // between posting "Game Over" and this entry being deleted from
      // activeWatches (see handleGameEnd()) - skip it here so this doesn't
      // race that path into posting a duplicate "appears to have ended".
      if (activeWatches.has(gameNo)) continue;

      const marker = await findCloseMarker(thread);
      if (!marker) {
        await thread.send('This game appears to have ended.').catch(() => {});
        await scheduleClose(thread);
      } else if (marker.alreadyArchived || marker.deadlineMs === undefined || Date.now() >= marker.deadlineMs) {
        await closeThread(thread, marker.message);
      }
      // else: already warned, deadline not reached yet - leave it for the
      // real timer (or a later sweep) to close once it actually is.
    }
  }
}
