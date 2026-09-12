import { Client, GatewayIntentBits, Collection, ChatInputCommandInteraction, TextChannel, MessageFlags } from 'discord.js';
import dotenv from 'dotenv';
import * as ping from './commands/ping';
import * as list from './commands/list';
import * as watch from './commands/watch';
import * as help from './commands/help';
import * as seeks from './commands/seeks';
import * as spectate from './commands/spectate';
import * as announce from './commands/announce';
import * as showbots from './commands/showbots';
import * as rating from './commands/rating';
import * as prune from './commands/prune';
import * as expand from './commands/expand';
import { initPlaytak, getGameRegistry, getPlaytakClient } from './playtak/shared';
import { registerWatcher, watchGame, getWatchedThread, reconstructThread } from './playtak/watcher';
import { registerAnnouncer, shutdownAnnouncer } from './playtak/announcer';
import { registerSeekToGame } from './playtak/seekToGame';
import { startRatingsRefresh } from './playtak/ratings';
import { registerAutoPrune } from './playtak/autoPrune';
import { registerPresence } from './playtak/presence';

// Which .env file to load - defaults to plain .env, but a specific instance
// (e.g. `node dist/index.js .env.production`) can point at its own file, so
// a single build can run more than one bot instance (different token,
// guild, and channel) without needing a separate checkout per instance.
dotenv.config({ path: process.argv[2] ?? '.env' });

const { DISCORD_TOKEN } = process.env;

if (!DISCORD_TOKEN) {
  throw new Error('DISCORD_TOKEN must be set in the env file (see package.json start scripts for which one)');
}

// Intents declare which events Discord will send us. Keep this list minimal -
// request more only as you actually need them (e.g. GuildMembers, MessageContent).
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Neither of these should fire in normal operation, but each is a
// process-killer if left unhandled: an 'error' the Client emits with no
// listener is rethrown by Node, and an unhandled promise rejection
// terminates the process outright. For an always-on service, logging and
// carrying on is the right response to both - the service manager would
// restart a crashed process anyway, but only after losing every in-memory
// watch, mirror thread, and pending seek correlation along with it.
client.on('error', (err) => {
  console.error('Discord client error:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

// A simple in-memory registry of commands, keyed by name, so the
// interactionCreate handler below can look up and run the right one.
interface Command {
  data: { name: string };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

const commands = new Collection<string, Command>();
commands.set(ping.data.name, ping);
commands.set(list.data.name, list);
commands.set(watch.data.name, watch);
commands.set(help.data.name, help);
commands.set(seeks.data.name, seeks);
commands.set(spectate.data.name, spectate);
commands.set(announce.data.name, announce);
commands.set(showbots.data.name, showbots);
commands.set(rating.data.name, rating);
commands.set(prune.data.name, prune);
commands.set(expand.data.name, expand);

client.once('ready', (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  const { client: playtak, gameRegistry } = initPlaytak();
  registerWatcher(playtak, readyClient, gameRegistry);
  registerAnnouncer(playtak, readyClient);
  registerSeekToGame(playtak, readyClient);
  registerAutoPrune(playtak, readyClient);
  registerPresence(playtak, readyClient, gameRegistry);
  startRatingsRefresh();
});

// customId shapes set by seekToGame.ts's game-started notice buttons -
// "watch:<gameNo>" while the game is live, "watch-review:<gameNo>" once it's
// finished. Both are lazy: nothing is created until someone actually clicks.
const WATCH_BUTTON_PATTERN = /^watch:(\d+)$/;
const REVIEW_BUTTON_PATTERN = /^watch-review:(\d+)$/;

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
      return;
    }

    if (interaction.isButton()) {
      const watchMatch = WATCH_BUTTON_PATTERN.exec(interaction.customId);
      if (watchMatch) {
        const gameNo = Number(watchMatch[1]);
        const game = getGameRegistry().find(gameNo);
        if (!game) {
          await interaction.reply({ content: 'That game has already ended.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (!(interaction.channel instanceof TextChannel)) {
          await interaction.reply({ content: 'This only works in a text channel.', flags: MessageFlags.Ephemeral });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const { thread, alreadyWatching } = await watchGame(getPlaytakClient(), interaction.channel, game);
        await interaction.editReply(
          alreadyWatching ? `This game already has a thread. Spectate: ${thread}` : `Spectate: ${thread}`,
        );
        return;
      }

      const reviewMatch = REVIEW_BUTTON_PATTERN.exec(interaction.customId);
      if (reviewMatch) {
        const gameNo = Number(reviewMatch[1]);

        const existingThread = getWatchedThread(gameNo);
        if (existingThread) {
          await interaction.reply({ content: `Spectate: ${existingThread}`, flags: MessageFlags.Ephemeral });
          return;
        }
        if (!(interaction.channel instanceof TextChannel)) {
          await interaction.reply({ content: 'This only works in a text channel.', flags: MessageFlags.Ephemeral });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const thread = await reconstructThread(interaction.channel, gameNo);
        await interaction.editReply(thread ? `Spectate: ${thread}` : "Couldn't find a record of that game.");
      }
    }
  } catch (err) {
    console.error('Error handling interaction:', err);
    // Best-effort only. If the interaction itself is what failed - expired
    // before it was acknowledged (Discord allows 3s), or otherwise unknown -
    // this reply fails the same way, and that failure has to be swallowed
    // here: thrown from inside a catch it escapes the handler, surfaces as
    // an unhandled 'error' on the Client, and takes the whole process down,
    // which is exactly how one slow /prune acknowledgement once crashed the
    // bot.
    const errorReply = { content: 'Something went wrong running that command.', flags: MessageFlags.Ephemeral } as const;
    try {
      if (interaction.isRepliable() && (interaction.replied || interaction.deferred)) {
        await interaction.followUp(errorReply);
      } else if (interaction.isRepliable()) {
        await interaction.reply(errorReply);
      }
    } catch (replyErr) {
      console.error('Could not report that error back to the user (the interaction is likely gone):', replyErr);
    }
  }
});

// Deletes each announce-enabled channel's "now on" confirmation message
// before exiting - it's stale the instant the bot goes down. The toggle
// state itself is left alone; resumeAnnouncing() picks it back up on the
// next start. Only covers a graceful stop (Ctrl+C, a process manager's
// SIGTERM) - a crash or `kill -9` skips this, but that's fine, since
// resumeAnnouncing() cleans up the stale message on the next startup
// regardless of how the previous run ended.
//
// The cleanup is best-effort and hard-capped: every step in it is a Discord
// REST call, and a hung or unreachable API (or a channel the bot has lost
// access to) would otherwise leave the process alive forever with the
// service manager stuck in STOP_PENDING - which is exactly what used to
// happen. Exiting without the cleanup is harmless; resumeAnnouncing() sweeps
// the stale message on the next start regardless of how this run ended.
const SHUTDOWN_TIMEOUT_MS = 4000;

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);

  // Outer backstop covering everything below, client.destroy() included -
  // so it is deliberately never cleared; process.exit(0) at the end of a
  // normal shutdown gets there first. unref() so the timer itself is never
  // what holds the process open.
  setTimeout(() => {
    console.error(`Shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS}ms - exiting anyway.`);
    process.exit(0);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  // Inner cap on just the cleanup, set below the outer one so a hung
  // announcer still leaves room for client.destroy() to run.
  try {
    await Promise.race([
      shutdownAnnouncer(client),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS - 500).unref()),
    ]);
  } catch (err) {
    console.error('Error during shutdown cleanup:', err);
  }
  client.destroy();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(DISCORD_TOKEN);
