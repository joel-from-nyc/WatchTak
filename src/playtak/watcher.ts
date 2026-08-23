import { Client, TextChannel, ThreadChannel, EmbedBuilder, AttachmentBuilder, Message } from 'discord.js';
import { PlaytakClient } from './client';
import { GameListEntry } from './protocol';
import { GameRegistry } from './registry';
import { placeToPtn, spreadToPtn, formatPtnMoveList } from './ptn';
import { renderBoardPng } from './boardImage';
import { describeResult } from './result';
import { buildPtnNinjaLink } from './ptnLink';
import { formatGameType, formatKomi } from './format';

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

function timeText(state: WatchState): string | undefined {
  if (state.whiteSeconds === undefined || state.blackSeconds === undefined) return undefined;
  return `${formatSeconds(state.whiteSeconds)}W, ${formatSeconds(state.blackSeconds)}B`;
}

// Adds a "Time" field when remaining time is known - shared by every embed
// kind below (move, catch-up, undo) so it always renders in the same spot.
function addTimeField(embed: EmbedBuilder, state: WatchState): EmbedBuilder {
  const time = timeText(state);
  return time ? embed.addFields({ name: 'Time', value: time, inline: true }) : embed;
}

// Embed for "this ply was just played" - used both when a move actually
// just arrived live, and to redescribe the new current position after an
// undo (see the gameUndo handling below), since from the thread's
// perspective the ply now on top of `state.plies` reads the same either way.
// "Move" and "Time" are separate inline fields so they sit side by side on
// one row, with the played-move text as a third, unlabeled field below them
// (a blank field name forces it onto its own row rather than sharing the
// Move/Time row). The Move field's value carries the bare "<number><W/B>" -
// findKnownPlyCount() depends on that exact shape to recover ply counts from
// thread history after a cold restart.
function moveEmbed(state: WatchState, ply: number, ptn: string): EmbedBuilder {
  const isWhite = ply % 2 === 0;
  const player = isWhite ? state.white : state.black;
  const moveNumber = Math.floor(ply / 2) + 1;
  const colorLetter = isWhite ? 'W' : 'B';
  const embed = new EmbedBuilder().addFields({
    name: 'Move',
    value: `${moveNumber}${colorLetter}`,
    inline: true,
  });
  addTimeField(embed, state);
  embed.addFields({ name: '​', value: `${player} played ${ptn}`, inline: false });
  return embed;
}

// Embed for a bare "here's the board" post with no specific move attached -
// the very first board of a game, or the state after an undo empties the
// ply list entirely.
function currentPositionEmbed(state: WatchState): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('Current position');
  return addTimeField(embed, state);
}

// Posts a live-countdown warning the first time the player to move drops
// under LOW_TIME_THRESHOLD_SECONDS, using Discord's <t:UNIX:R> markup so the
// countdown ticks on its own with no bot-side editing. A no-op if one is
// already showing - only the first tick under the threshold posts anything,
// not every gameTime update while still low.
async function maybePostLowTimeWarning(state: WatchState): Promise<void> {
  if (state.lowTimeWarning) return;

  const isWhite = state.plies.length % 2 === 0;
  const seconds = isWhite ? state.whiteSeconds : state.blackSeconds;
  if (seconds === undefined || seconds >= LOW_TIME_THRESHOLD_SECONDS) return;

  const player = isWhite ? state.white : state.black;
  const deadline = Math.floor(Date.now() / 1000 + seconds);
  const message = await state.thread
    .send(`${player} is running low on time! <t:${deadline}:R>`)
    .catch((err) => {
      console.error(`Failed to post low-time warning for game #${state.gameNo}:`, err);
      return null;
    });
  if (!message) return;

  state.lowTimeWarning = { message, color: isWhite ? 'white' : 'black' };
}

// Replaces a live countdown with a static, no-longer-ticking readout the
// moment it goes stale - a move landing, an undo, or the game ending. Only
// one warning can exist at a time, so this always resolves whichever one is
// pending regardless of what caused it, and is a no-op if none is pending.
async function resolveLowTimeWarning(state: WatchState): Promise<void> {
  const warning = state.lowTimeWarning;
  if (!warning) return;
  state.lowTimeWarning = undefined;

  const player = warning.color === 'white' ? state.white : state.black;
  const seconds = warning.color === 'white' ? state.whiteSeconds : state.blackSeconds;
  const text =
    seconds === undefined
      ? `${player} was running low on time.`
      : `${player} was running low on time (${formatSeconds(seconds)} left).`;
  await warning.message.edit(text).catch(() => {});
}

async function closeThread(thread: ThreadChannel): Promise<void> {
  await thread.setArchived(true).catch((err) => {
    console.error(`Failed to archive thread ${thread.id}:`, err);
  });
  await thread.setLocked(true).catch(() => {});
}

// Board image as the embed's image, so it renders inside the same visual
// block as the move/time text rather than as a separate bare attachment.
async function postBoard(state: WatchState, embed: EmbedBuilder): Promise<void> {
  const png = renderBoardPng(state.boardSize, state.komi, state.plies, state.white, state.black);
  const attachment = new AttachmentBuilder(png, { name: 'board.png' });
  embed.setImage('attachment://board.png');
  await state.thread.send({ embeds: [embed], files: [attachment] });
}

function armSettleTimer(state: WatchState): void {
  if (state.settleTimer) clearTimeout(state.settleTimer);
  state.settleTimer = setTimeout(async () => {
    state.live = true;
    try {
      if (state.historyMode === 'newThread' && state.plies.length > 0) {
        await state.thread.send({
          embeds: [
            new EmbedBuilder()
              .setTitle('Moves so far')
              .setDescription(`\`\`\`\n${formatPtnMoveList(state.plies)}\n\`\`\``),
          ],
        });
        await postBoard(state, currentPositionEmbed(state));
      } else if (state.historyMode === 'reconnect') {
        const missed = state.plies.slice(state.catchupFromPly ?? 0);
        // Nothing actually happened while disconnected - no catch-up
        // needed, so stay quiet rather than post a redundant board.
        if (missed.length > 0) {
          await state.thread.send({
            embeds: [
              new EmbedBuilder()
                .setTitle('Moves missed while disconnected')
                .setDescription(`\`\`\`\n${formatPtnMoveList(missed, state.catchupFromPly ?? 0)}\n\`\`\``),
            ],
          });
          await postBoard(state, currentPositionEmbed(state));
        }
      } else {
        await postBoard(state, currentPositionEmbed(state));
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
  await resolveLowTimeWarning(state);
  await state.thread
    .send({
      embeds: [
        new EmbedBuilder()
          .setTitle('Game Over')
          .setDescription(`${resultText}\n\n[View full game on ptn.ninja](${ptnLink})`),
      ],
    })
    .catch(() => {});
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
      if (state.live) await maybePostLowTimeWarning(state);
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
        await state.thread.send({
          embeds: [
            new EmbedBuilder().setTitle('Move taken back').setDescription(`${undoingPlayer} took back their move.`),
          ],
        });
        if (state.plies.length === 0) {
          await postBoard(state, currentPositionEmbed(state));
        } else {
          const ply = state.plies.length - 1;
          await postBoard(state, moveEmbed(state, ply, state.plies[ply]));
        }
      } catch (err) {
        console.error(`Failed to post undo for game #${event.gameNo}:`, err);
      }
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
      await postBoard(state, moveEmbed(state, ply, ptn));
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
  const gameType = formatGameType(game.unrated, game.tournament);
  const komi = formatKomi(game.komi);
  await thread.send({
    embeds: [
      new EmbedBuilder()
        .setTitle(`${game.white} vs ${game.black}`)
        .setDescription(`${game.white} (white) vs ${game.black} (black)`)
        .addFields(
          { name: 'Board', value: `${game.boardSize}x${game.boardSize}`, inline: true },
          { name: 'Time', value: `${minutes}+${game.incrementSeconds}`, inline: true },
          { name: 'Komi', value: komi, inline: true },
          { name: 'Type', value: gameType, inline: true },
        ),
    ],
  });

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

// Matches the "<number><W/B>" value of every move/undo post's "Move" field
// (see moveEmbed()) - the only place a ply number appears in the thread's
// own history.
const MOVE_LINE_PATTERN = /^(\d+)([WB])$/;

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
    const texts = message.embeds.flatMap((embed) =>
      embed.fields.filter((field) => field.name === 'Move').map((field) => field.value),
    );
    for (const text of texts) {
      const match = MOVE_LINE_PATTERN.exec(text);
      if (!match) continue;
      const ply = plyFromMoveLine(Number(match[1]), match[2]);
      if (highestPly === undefined || ply > highestPly) highestPly = ply;
    }
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
