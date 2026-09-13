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

// Same env-file argument as index.ts.
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
  // Guild-scoped registration takes effect immediately; global registration
  // can take up to an hour to propagate.
  const route = DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID!, DISCORD_GUILD_ID)
    : Routes.applicationCommands(DISCORD_CLIENT_ID!);

  console.log(`Registering ${commands.length} command(s)...`);
  await rest.put(route, { body: commands });
  console.log('Commands registered successfully.');

  // Clear any global registration so commands do not appear twice.
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
