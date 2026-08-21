import { Client, TextChannel, ThreadChannel } from 'discord.js';
import { PlaytakClient } from './client';
import { GameListEntry } from './protocol';
import { GameRegistry } from './registry';
import { placeToPtn, spreadToPtn, formatPtnMoveList } from './ptn';
import { renderBoardPng } from './boardImage';
import { describeResult } from './result';
import { buildPtnNinjaLink } from './ptnLink';

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

interface WatchState {
  gameNo: number;
  thread: ThreadChannel;
  white: string;
  black: string;
  boardSize: number;
  komi: number;
  plies: string[];
  live: boolean;
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
  // a sweep match with no way to know what the thread already shows - skip
  // the dump entirely rather than guess.
  historyMode: 'newThread' | 'reconnect' | 'resume';
  // Only meaningful when historyMode is 'reconnect' - the ply count the
  // thread already had text for before the disconnect.
  catchupFromPly?: number;
}

// One bot instance only ever lives in one Discord server, so a game is only
// ever watched from one place - keyed by PlayTak game number alone.
const activeWatches = new Map<number, WatchState>();

function threadName(white: string, black: string, gameNo: number): string {
  return `${white} vs ${black} (#${gameNo})`;
}

function formatSeconds(totalSeconds: number): string {
  const clamped = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function timeSuffix(state: WatchState): string {
  if (state.whiteSeconds === undefined || state.blackSeconds === undefined) return '';
  return `\nTime left: ${formatSeconds(state.whiteSeconds)}W, ${formatSeconds(state.blackSeconds)}B`;
}

async function closeThread(thread: ThreadChannel): Promise<void> {
  await thread.setArchived(true).catch((err) => {
    console.error(`Failed to archive thread ${thread.id}:`, err);
  });
  await thread.setLocked(true).catch(() => {});
}

async function postBoard(state: WatchState, content?: string): Promise<void> {
  const png = renderBoardPng(state.boardSize, state.komi, state.plies, state.white, state.black);
  await state.thread.send({
    ...(content ? { content } : {}),
    files: [{ attachment: png, name: 'board.png' }],
  });
}

function armSettleTimer(state: WatchState): void {
  if (state.settleTimer) clearTimeout(state.settleTimer);
  state.settleTimer = setTimeout(async () => {
    state.live = true;
    try {
      if (state.historyMode === 'newThread' && state.plies.length > 0) {
        await state.thread.send(`\`\`\`\n${formatPtnMoveList(state.plies)}\n\`\`\``);
        await postBoard(state, 'Current position.');
      } else if (state.historyMode === 'reconnect') {
        const missed = state.plies.slice(state.catchupFromPly ?? 0);
        // Nothing actually happened while disconnected - no catch-up
        // needed, so stay quiet rather than post a redundant board.
        if (missed.length > 0) {
          await state.thread.send(`\`\`\`\n${formatPtnMoveList(missed, state.catchupFromPly ?? 0)}\n\`\`\``);
          await postBoard(state, 'Current position.');
        }
      } else {
        await postBoard(state, 'Current position.');
      }
    } catch (err) {
      console.error(`Failed to post caught-up position for game #${state.gameNo}:`, err);
    }
  }, HISTORY_SETTLE_MS);
}

function beginObserving(playtak: PlaytakClient, state: WatchState): void {
  activeWatches.set(state.gameNo, state);
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
  // Angle brackets suppress Discord's link-preview embed, leaving just the
  // clickable link.
  await state.thread.send(`**Game over.** ${resultText}\n<${ptnLink}>`).catch(() => {});
  await scheduleClose(state.thread);

  activeWatches.delete(state.gameNo);
  playtak.send(`Unobserve ${state.gameNo}`);
}

export function registerWatcher(playtak: PlaytakClient, discordClient: Client, registry: GameRegistry): void {
  playtak.on('event', async (event) => {
    if (
      event.type !== 'gamePlace' &&
      event.type !== 'gameSpread' &&
      event.type !== 'gameOver' &&
      event.type !== 'gameAbandoned' &&
      event.type !== 'gameTime'
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
      await handleGameEnd(playtak, state, `**${event.quittingPlayer}** abandoned the game.`);
      return;
    }

    const ptn = event.type === 'gamePlace' ? placeToPtn(event.move) : spreadToPtn(event.move);

    if (!state.live) {
      state.plies.push(ptn);
      armSettleTimer(state);
      return;
    }

    const ply = state.plies.length;
    const player = ply % 2 === 0 ? state.white : state.black;
    const moveNumber = Math.floor(ply / 2) + 1;
    const colorLetter = ply % 2 === 0 ? 'W' : 'B';
    state.plies.push(ptn);
    try {
      await postBoard(state, `**${player}**: ${moveNumber}${colorLetter}: ${ptn}${timeSuffix(state)}`);
    } catch (err) {
      console.error(`Failed to post move to thread for game #${event.gameNo}:`, err);
    }
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
      state.catchupFromPly = state.plies.length;
      state.live = false;
      state.plies = [];
      state.historyMode = 'reconnect';
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
    activeWatches.delete(game.gameNo);
    playtak.send(`Unobserve ${game.gameNo}`);
  }

  const thread = await parentChannel.threads.create({
    name: threadName(game.white, game.black, game.gameNo),
    autoArchiveDuration: 1440,
  });

  const minutes = Math.floor(game.timeSeconds / 60);
  const rated = game.unrated ? 'unrated' : 'rated';
  await thread.send(
    `Watching **${game.white}** (white) vs **${game.black}** (black) - ` +
      `${game.boardSize}x${game.boardSize}, ${minutes}+${game.incrementSeconds}, ${rated}.`,
  );

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
  };
  beginObserving(playtak, state);

  return { thread, alreadyWatching: false };
}

async function hasAlreadyWarnedClose(thread: ThreadChannel): Promise<boolean> {
  const recent = await thread.messages.fetch({ limit: 10 }).catch(() => null);
  if (!recent) return false;
  return recent.some((message) => message.content.includes(CLOSE_WARNING_TEXT));
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
          beginObserving(playtak, {
            gameNo,
            thread,
            white: game.white,
            black: game.black,
            boardSize: game.boardSize,
            komi: game.komi / 2,
            plies: [],
            live: false,
            historyMode: 'resume',
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
