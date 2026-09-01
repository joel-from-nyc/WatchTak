import { REST, Routes } from 'discord.js';
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

// Same env-file selection as index.ts - which instance's commands get
// registered depends on which env file is loaded, so this must be explicit
// rather than always registering whatever `.env` happens to contain.
const envFile = process.argv[2] ?? '.env';
dotenv.config({ path: envFile });

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  throw new Error(`DISCORD_TOKEN and DISCORD_CLIENT_ID must be set in ${envFile}`);
}

console.log(`Using ${envFile} - guild ${DISCORD_GUILD_ID ?? '(none, global)'}`);

const commands = [
  ping.data.toJSON(),
  list.data.toJSON(),
  watch.data.toJSON(),
  help.data.toJSON(),
  seeks.data.toJSON(),
  spectate.data.toJSON(),
  announce.data.toJSON(),
  showbots.data.toJSON(),
  rating.data.toJSON(),
  prune.data.toJSON(),
  expand.data.toJSON(),
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
