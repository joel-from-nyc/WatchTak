import { Client, GatewayIntentBits, Collection, ChatInputCommandInteraction, TextChannel } from 'discord.js';
import dotenv from 'dotenv';
import * as ping from './commands/ping';
import * as list from './commands/list';
import * as watch from './commands/watch';
import * as help from './commands/help';
import * as seeks from './commands/seeks';
import * as spectate from './commands/spectate';
import * as announce from './commands/announce';
import { initPlaytak, getGameRegistry, getPlaytakClient } from './playtak/shared';
import { registerWatcher, watchGame } from './playtak/watcher';
import { registerAnnouncer, shutdownAnnouncer } from './playtak/announcer';
import { registerSeekToGame } from './playtak/seekToGame';

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

client.once('ready', (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  const { client: playtak, gameRegistry } = initPlaytak();
  registerWatcher(playtak, readyClient, gameRegistry);
  registerAnnouncer(playtak, readyClient);
  registerSeekToGame(playtak, readyClient);
});

// customId shape "watch:<gameNo>" - set by seekToGame.ts's "Watch game"
// button on its game-started notice. Lazily does exactly what /watch does:
// nothing is created until someone actually clicks.
const WATCH_BUTTON_PATTERN = /^watch:(\d+)$/;

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
      return;
    }

    if (interaction.isButton()) {
      const match = WATCH_BUTTON_PATTERN.exec(interaction.customId);
      if (!match) return;

      const gameNo = Number(match[1]);
      const game = getGameRegistry().find(gameNo);
      if (!game) {
        await interaction.reply({ content: 'That game has already ended.', ephemeral: true });
        return;
      }
      if (!(interaction.channel instanceof TextChannel)) {
        await interaction.reply({ content: 'This only works in a text channel.', ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      const { thread, alreadyWatching } = await watchGame(getPlaytakClient(), interaction.channel, game);
      await interaction.editReply(alreadyWatching ? `Already watching. Spectate: ${thread}` : `Spectate: ${thread}`);
    }
  } catch (err) {
    console.error('Error handling interaction:', err);
    const errorReply = { content: 'Something went wrong running that command.', ephemeral: true };
    if (interaction.isRepliable() && (interaction.replied || interaction.deferred)) {
      await interaction.followUp(errorReply);
    } else if (interaction.isRepliable()) {
      await interaction.reply(errorReply);
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
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);
  try {
    await shutdownAnnouncer(client);
  } catch (err) {
    console.error('Error during shutdown cleanup:', err);
  }
  client.destroy();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(DISCORD_TOKEN);
