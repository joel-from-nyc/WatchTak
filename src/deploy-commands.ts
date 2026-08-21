import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
import * as ping from './commands/ping';
import * as list from './commands/list';
import * as watch from './commands/watch';
import * as help from './commands/help';
import * as seeks from './commands/seeks';
import * as s from './commands/s';
import * as seek from './commands/seek';
import * as l from './commands/l';
import * as w from './commands/w';

dotenv.config();

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID must be set in .env');
}

const commands = [
  ping.data.toJSON(),
  list.data.toJSON(),
  watch.data.toJSON(),
  help.data.toJSON(),
  seeks.data.toJSON(),
  s.data.toJSON(),
  seek.data.toJSON(),
  l.data.toJSON(),
  w.data.toJSON(),
];

const rest = new REST().setToken(DISCORD_TOKEN);

async function main() {
  // Guild-scoped registration shows up instantly - each bot instance only
  // ever lives in one Discord server (a separate test instance runs
  // separately from the production one), so there's no need for global
  // registration's "works in every server" tradeoff of up to an hour to
  // propagate.
  const route = DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID!, DISCORD_GUILD_ID)
    : Routes.applicationCommands(DISCORD_CLIENT_ID!);

  console.log(`Registering ${commands.length} command(s)...`);
  await rest.put(route, { body: commands });
  console.log('Commands registered successfully.');

  // Clear any leftover global registration from before the switch back to
  // guild-scoped - otherwise they'd sit alongside the new guild-scoped ones
  // and show up twice.
  if (DISCORD_GUILD_ID) {
    console.log('Clearing old global commands...');
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID!), { body: [] });
    console.log('Old global commands cleared.');
  }
}

main().catch((err) => {
  console.error('Failed to register commands:', err);
  process.exit(1);
});
