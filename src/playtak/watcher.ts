import { Client, TextChannel, ThreadChannel, AttachmentBuilder, Message } from 'discord.js';
import { PlaytakClient } from './client';
import { GameListEntry, PlaytakEvent } from './protocol';
import { GameRegistry } from './registry';
import { placeToPtn, spreadToPtn, formatPtnMoveList } from './ptn';
import { renderBoardPng } from './boardImage';
import { describeResult } from './result';
import { buildPtnNinjaLink } from './ptnLink';
import { formatGameType, formatKomi } from './format';
import { fetchArchivedGame } from './gameArchive';

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
// sweep. sweepThreads() checks a thread's recent messages for this exact
// text to avoid re-posting it (and re-arming a fresh 24h timer) on every
// pass - see sweepThreads().
const CLOSE_WARNING_TEXT = 'This thread will be archived in 24 hours.';

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
  plies: string[];
  live: boolean;
  // Column width every "Label: value" line in this thread pads its label to
  // (see alignedLine()) - computed once from both player names so the
  // colon column stays in the same place across every message in the
  // thread, rather than shifting depending on whose (differently-sized)
  // name is on a given line. See computeMoveLabelWidth().
  moveLabelWidth: number;
  // Most recently known remaining time, from Game#<no> Time events.
  // Undefined until the first one arrives.
  whiteSeconds?: number;
  blackSeconds?: number;
  settleTimer?: NodeJS.Timeout;
  // 'newThread': this is the first time anyone has watched this game, so the
  // thread has no prior move history visible - dump the full PTN move list
  // once caught up. 'reconnect': the thread already has moves up through
  // `catchupFromPly`, so dump only what came after (the moves actually
  // missed while disconnected) rather than the whole game again. 'resume':
  // a sweep match where sweepThreads() couldn't work out what the thread
  // already shows (see findKnownPlyCount()) - skip the dump entirely rather
  // than guess.
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
}

// One bot instance only ever lives in one Discord server, so a game is only
// ever watched from one place - keyed by PlayTak game number alone.
const activeWatches = new Map<number, WatchState>();

// Threads this process has opened, kept keyed by game number even after the
// game ends and its watch is torn down, so a "Review" link can still point at
// the thread afterwards (see seekToGame.ts). Bounded by how many games this
// process watched, and deliberately not persisted - after a restart there's
// no live notice left to relink anyway.
const watchedThreads = new Map<number, ThreadChannel>();

export function getWatchedThread(gameNo: number): ThreadChannel | undefined {
  return watchedThreads.get(gameNo);
}

function threadName(white: string, black: string, gameNo: number): string {
  return `${white} vs ${black} (#${gameNo})`;
}

function formatSeconds(totalSeconds: number): string {
  const clamped = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// Every "Label: value" line in a thread pads its label to the same width, so
// the colon column lines up down the whole message history rather than
// shifting message-to-message with whoever's name is on a given line (see
// WatchState.moveLabelWidth). Computed once, from the labels that actually
// appear across a game's messages: "Move", "White Time", "Black Time", and
// "<player> played" for both sides - whichever is longest sets the width.
function computeMoveLabelWidth(white: string, black: string): number {
  return Math.max(
    'Move'.length,
    'White Time'.length,
    'Black Time'.length,
    `${white} played`.length,
    `${black} played`.length,
  );
}

function alignedLine(label: string, value: string, width: number): string {
  return `${label}:`.padEnd(width + 2) + value;
}

function codeBlock(lines: string[]): string {
  return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

// "White Time"/"Black Time" lines, or none at all if remaining time isn't
// known yet - shared by every message kind that shows the clock (move,
// current position).
function timeLines(state: WatchState): string[] {
  if (state.whiteSeconds === undefined || state.blackSeconds === undefined) return [];
  return [
    alignedLine('White Time', formatSeconds(state.whiteSeconds), state.moveLabelWidth),
    alignedLine('Black Time', formatSeconds(state.blackSeconds), state.moveLabelWidth),
  ];
}

// Text for "this ply was just played" - used both when a move actually just
// arrived live, and to redescribe the new current position after an undo
// (see the gameUndo handling below), since from the thread's perspective the
// ply now on top of `state.plies` reads the same either way. The "Move"
// line's value carries the bare "<number><W/B>" - findKnownPlyCount()
// depends on that exact shape to recover ply counts from thread history
// after a cold restart.
function moveText(state: WatchState, ply: number, ptn: string): string {
  const isWhite = ply % 2 === 0;
  const player = isWhite ? state.white : state.black;
  const moveNumber = Math.floor(ply / 2) + 1;
  const colorLetter = isWhite ? 'W' : 'B';
  const width = state.moveLabelWidth;
  const lines = [
    alignedLine('Move', `${moveNumber}${colorLetter}`, width),
    ...timeLines(state),
    alignedLine(`${player} played`, ptn, width),
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
// Uses its own tight local label width (Board/Time/Komi/Type are all short
// and unrelated to the player-name-driven width the rest of the thread
// uses) rather than moveLabelWidth, since this block only ever appears once
// and stretching it to match move messages would just look sparse. `note`
// is an optional extra line for reconstructThread()'s "not watched live"
// disclosure.
function watchStartText(
  white: string,
  black: string,
  gameNo: number,
  boardSize: number,
  minutes: number,
  incrementSeconds: number,
  komi: string,
  gameType: string,
  note?: string,
): string {
  const width = Math.max('Board'.length, 'Time'.length, 'Komi'.length, 'Type'.length);
  const lines = [`${white} vs ${black} (#${gameNo})`];
  if (note) lines.push(note);
  lines.push(
    '',
    alignedLine('Board', `${boardSize}x${boardSize}`, width),
    alignedLine('Time', `${minutes}+${incrementSeconds}`, width),
    alignedLine('Komi', komi, width),
    alignedLine('Type', gameType, width),
  );
  return codeBlock(lines);
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

function staleWarningText(state: WatchState, color: 'white' | 'black'): string {
  const player = color === 'white' ? state.white : state.black;
  const seconds = color === 'white' ? state.whiteSeconds : state.blackSeconds;
  return seconds === undefined
    ? `${player} was running low on time.`
    : `${player} was running low on time (${formatSeconds(seconds)} left).`;
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
    .send(`${player} will lose on time in: <t:${Math.floor(flagAtMs / 1000)}:R>`)
    .catch((err) => {
      console.error(`Failed to post low-time warning for game #${state.gameNo}:`, err);
      return null;
    });
  if (!message) return;

  if ((state.lowTimeGeneration ?? 0) !== generation) {
    await message.edit(staleWarningText(state, isWhite ? 'white' : 'black')).catch(() => {});
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
async function resolveLowTimeWarning(state: WatchState): Promise<void> {
  state.lowTimeGeneration = (state.lowTimeGeneration ?? 0) + 1;
  clearLowTimeTimer(state);
  const warning = state.lowTimeWarning;
  if (!warning) return;
  state.lowTimeWarning = undefined;
  await warning.message.edit(staleWarningText(state, warning.color)).catch(() => {});
}

async function closeThread(thread: ThreadChannel): Promise<void> {
  await thread.setArchived(true).catch((err) => {
    console.error(`Failed to archive thread ${thread.id}:`, err);
  });
  await thread.setLocked(true).catch(() => {});
}

// Text and board image in the same message, so the board always lands right
// under the text describing it rather than as a separate, possibly
// out-of-order post.
async function postBoard(state: WatchState, content: string): Promise<void> {
  const png = renderBoardPng(state.boardSize, state.komi, state.plies, state.white, state.black);
  const attachment = new AttachmentBuilder(png, { name: 'board.png' });
  await state.thread.send({ content, files: [attachment] });
}

function armSettleTimer(state: WatchState): void {
  if (state.settleTimer) clearTimeout(state.settleTimer);
  state.settleTimer = setTimeout(async () => {
    state.live = true;
    try {
      if (state.historyMode === 'newThread' && state.plies.length > 0) {
        await state.thread.send(codeBlock(['Moves so far', '', formatPtnMoveList(state.plies)]));
        await postBoard(state, currentPositionText(state));
      } else if (state.historyMode === 'reconnect') {
        const missed = state.plies.slice(state.catchupFromPly ?? 0);
        // Nothing actually happened while disconnected - no catch-up
        // needed, so stay quiet rather than post a redundant board.
        if (missed.length > 0) {
          await state.thread.send(
            codeBlock(['Moves missed while disconnected', '', formatPtnMoveList(missed, state.catchupFromPly ?? 0)]),
          );
          await postBoard(state, currentPositionText(state));
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
  await thread.send(CLOSE_WARNING_TEXT).catch(() => {});
  setTimeout(() => closeThread(thread), THREAD_CLOSE_DELAY_MS);
}

async function handleGameEnd(
  playtak: PlaytakClient,
  state: WatchState,
  resultText: string,
  result?: string,
): Promise<void> {
  const ptnLink = await buildPtnNinjaLink({
    white: state.white,
    black: state.black,
    boardSize: state.boardSize,
    komi: state.komi,
    result,
    plies: state.plies,
  });
  await resolveLowTimeWarning(state);
  // The link stays outside the code block - masked links don't render as
  // clickable inside a fenced block, only as literal text.
  await state.thread
    .send(`${codeBlock(['Game Over', '', resultText])}\n[View full game on ptn.ninja](${ptnLink})`)
    .catch(() => {});
  await scheduleClose(state.thread);

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
    await handleGameEnd(playtak, state, describeResult(event.result, state.white, state.black), event.result);
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
      await resolveLowTimeWarning(state);
      await state.thread.send(codeBlock(['Move taken back', '', `${undoingPlayer} took back their move.`]));
      if (state.plies.length === 0) {
        await postBoard(state, currentPositionText(state));
      } else {
        const ply = state.plies.length - 1;
        await postBoard(state, moveText(state, ply, state.plies[ply]));
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
    await resolveLowTimeWarning(state);
    await postBoard(state, moveText(state, ply, ptn));
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
  // disconnected get printed as text, then a single current-position board -
  // not a board redrawn per missed move.
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

  const thread = await parentChannel.threads.create({
    name: threadName(game.white, game.black, game.gameNo),
    autoArchiveDuration: 1440,
  });

  const minutes = Math.floor(game.timeSeconds / 60);
  const gameType = formatGameType(game.unrated, game.tournament);
  const komi = formatKomi(game.komi);
  await thread.send(watchStartText(game.white, game.black, game.gameNo, game.boardSize, minutes, game.incrementSeconds, komi, gameType));

  const state: WatchState = {
    gameNo: game.gameNo,
    thread,
    white: game.white,
    black: game.black,
    boardSize: game.boardSize,
    // Wire komi is in half-point units (see Seek.java: `.komi(komi / 2.f)`).
    komi: game.komi / 2,
    plies: [],
    live: false,
    historyMode: 'newThread',
    moveLabelWidth: computeMoveLabelWidth(game.white, game.black),
  };
  beginObserving(playtak, state);

  return { thread, alreadyWatching: false };
}

// Builds a Review thread for a finished game nobody watched live, from
// PlayTak's public archive rather than the (now-gone) live WebSocket state -
// see gameArchive.ts. Unlike watchGame()/beginObserving(), this never calls
// Observe or arms any timers: the game is over, there's nothing to
// subscribe to, only a record to lay out once. Returns undefined if the
// archive has no record of this game (caller shows a generic error).
export async function reconstructThread(parentChannel: TextChannel, gameNo: number): Promise<ThreadChannel | undefined> {
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
    plies: archived.plies,
    live: true,
    historyMode: 'newThread',
    moveLabelWidth: computeMoveLabelWidth(archived.white, archived.black),
  };

  const minutes = Math.floor(archived.timeSeconds / 60);
  const gameType = formatGameType(archived.unrated, archived.tournament);
  const komiText = formatKomi(archived.komi);
  await thread.send(
    watchStartText(
      archived.white,
      archived.black,
      gameNo,
      archived.boardSize,
      minutes,
      archived.incrementSeconds,
      komiText,
      gameType,
      "Reconstructed from PlayTak's archive - nobody was watching this game live.",
    ),
  );

  if (archived.plies.length > 0) {
    await thread.send(codeBlock(['Moves so far', '', formatPtnMoveList(archived.plies)]));
  }
  await postBoard(state, currentPositionText(state));

  const ptnLink = await buildPtnNinjaLink({
    white: archived.white,
    black: archived.black,
    boardSize: archived.boardSize,
    komi: state.komi,
    result: archived.result,
    plies: archived.plies,
  });
  await thread.send(
    `${codeBlock(['Game Over', '', describeResult(archived.result, archived.white, archived.black)])}\n` +
      `[View full game on ptn.ninja](${ptnLink})`,
  );

  return thread;
}

async function hasAlreadyWarnedClose(thread: ThreadChannel): Promise<boolean> {
  const recent = await thread.messages.fetch({ limit: 10 }).catch(() => null);
  if (!recent) return false;
  return recent.some((message) => message.content.includes(CLOSE_WARNING_TEXT));
}

// Matches the "Move: <number><W/B>" line every move/undo post carries (see
// moveText()) - the only place a ply number appears in the thread's own
// history. `\s+` rather than a fixed count of spaces since the padding width
// varies by thread (see WatchState.moveLabelWidth).
const MOVE_LINE_PATTERN = /^Move:\s+(\d+)([WB])\s*$/m;

function plyFromMoveLine(moveNumber: number, colorLetter: string): number {
  return (moveNumber - 1) * 2 + (colorLetter === 'W' ? 0 : 1);
}

// A cold restart has no memory of what a thread already showed - unlike a
// same-process WebSocket reconnect, there's no `state.plies` left over to
// diff against. Reconstructs the same information from the thread's own
// message history instead, by finding the highest ply number mentioned in
// any past move/undo post, so a resumed thread can still get a "what you
// missed" summary rather than silently jumping straight to a bare board
// (see sweepThreads()). Returns undefined - "unknown, don't guess" - if
// nothing in recent history carries a ply number, e.g. a brand-new game
// with zero moves posted yet.
async function findKnownPlyCount(thread: ThreadChannel): Promise<number | undefined> {
  const recent = await thread.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return undefined;

  let highestPly: number | undefined;
  for (const message of recent.values()) {
    const match = MOVE_LINE_PATTERN.exec(message.content);
    if (!match) continue;
    const ply = plyFromMoveLine(Number(match[1]), match[2]);
    if (highestPly === undefined || ply > highestPly) highestPly = ply;
  }
  return highestPly === undefined ? undefined : highestPly + 1;
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
// - No longer active? The game ended and we missed it (offline, or a gap
//   between sweeps). Post the same close-warning used by the live game-over
//   path and start its 24h timer - unless a previous pass already posted
//   that warning (checked via the thread's own message history, since nothing
//   here is persisted across a restart), in which case just close it now
//   rather than re-warning indefinitely. This means the 24h window isn't
//   exact across a restart that happens mid-window - a game that ended just
//   before the bot went down could get closed anywhere from immediately to
//   one sweep interval late, rather than waiting out the precise 24h.
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
        if (!activeWatches.has(gameNo)) {
          // Reconstruct what the thread already showed from its own
          // message history (see findKnownPlyCount()) so a resumed thread
          // still gets a "what you missed" summary like a same-process
          // reconnect would, rather than jumping straight to a bare board.
          // Falls back to skipping the dump only if that can't be
          // determined (e.g. no move has ever been posted here).
          const knownPlyCount = await findKnownPlyCount(thread);
          beginObserving(playtak, {
            gameNo,
            thread,
            white: game.white,
            black: game.black,
            boardSize: game.boardSize,
            komi: game.komi / 2,
            plies: [],
            live: false,
            historyMode: knownPlyCount === undefined ? 'resume' : 'reconnect',
            catchupFromPly: knownPlyCount,
            moveLabelWidth: computeMoveLabelWidth(game.white, game.black),
          });
        }
        continue;
      }

      if (activeWatches.has(gameNo)) continue; // handleGameEnd is already handling this one

      if (await hasAlreadyWarnedClose(thread)) {
        await closeThread(thread);
      } else {
        await thread.send('This game appears to have ended.').catch(() => {});
        await scheduleClose(thread);
      }
    }
  }
}
