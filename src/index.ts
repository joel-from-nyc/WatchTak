import { Client, GatewayIntentBits, Collection, TextChannel, MessageFlags } from 'discord.js';
import dotenv from 'dotenv';
import { commands as commandList, Command } from './commands';
import { initPlaytak, getGameRegistry } from './playtak/shared';
import { registerWatcher, watchGame, getWatchedThread, reconstructThread } from './playtak/watcher';
import { registerAnnouncer, shutdownAnnouncer } from './playtak/announcer';
import { registerSeekToGame } from './playtak/seekToGame';
import { startRatingsRefresh } from './playtak/ratings';
import { registerAutoPrune } from './playtak/autoPrune';
import { registerPresence } from './playtak/presence';

// An optional first argument names the env file, so one build can run more
// than one instance: `node dist/index.js .env.testing`.
dotenv.config({ path: process.argv[2] ?? '.env' });

const { DISCORD_TOKEN } = process.env;

if (!DISCORD_TOKEN) {
  throw new Error('DISCORD_TOKEN must be set in the env file (see package.json start scripts for which one)');
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Both would otherwise terminate the process. For an always-on service,
// logging and continuing keeps every in-memory watch alive.
client.on('error', (err) => {
  console.error('Discord client error:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

const commands = new Collection<string, Command>();
for (const command of commandList) commands.set(command.data.name, command);

client.once('clientReady', (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  initPlaytak();
  registerWatcher(readyClient);
  registerAnnouncer(readyClient);
  registerSeekToGame(readyClient);
  registerAutoPrune(readyClient);
  registerPresence(readyClient);
  startRatingsRefresh();
});

// Button customIds set by seekToGame.ts: "watch:<gameNo>" while a game is
// live, "watch-review:<gameNo>" once it has finished.
const WATCH_BUTTON_PATTERN = /^watch:(\d+)$/;
const REVIEW_BUTTON_PATTERN = /^watch-review:(\d+)$/;

client.on('interactionCreate', async (interaction) => {
  try {
    // Autocomplete arrives as its own interaction type and must be answered
    // within 3 seconds.
    if (interaction.isAutocomplete()) {
      const command = commands.get(interaction.commandName);
      await command?.autocomplete?.(interaction);
      return;
    }

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
        const { thread, alreadyWatching } = await watchGame(interaction.channel, game);
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
    // Best effort: if the interaction itself has expired, this reply fails
    // too, and that failure must not escape the catch block.
    const errorReply = {
      content: 'Something went wrong running that command.',
      flags: MessageFlags.Ephemeral,
    } as const;
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

// On a graceful stop, deletes each announcing channel's "now on" message
// (stale once the bot is down). The persisted toggle state is kept and
// resumed on the next start. Cleanup is capped so a hung Discord API call
// can never keep the process from exiting.
const SHUTDOWN_TIMEOUT_MS = 4000;

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);

  // Outer backstop for everything below, client.destroy() included.
  setTimeout(() => {
    console.error(`Shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS}ms - exiting anyway.`);
    process.exit(0);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  // Inner cap on the cleanup alone, leaving room for client.destroy().
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
