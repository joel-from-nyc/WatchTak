import { SlashCommandBuilder, ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { GameListEntry } from '../playtak/protocol';
import { getGameRegistry, getPlaytakClient } from '../playtak/shared';
import { buildGamesListReply } from '../playtak/gamesReply';
import { watchGame } from '../playtak/watcher';

export const data = new SlashCommandBuilder()
  .setName('watch')
  .setDescription('Watch a live PlayTak game in a thread. Leave blank to list active games.')
  .addStringOption((option) =>
    option
      .setName('game')
      .setDescription('Game ID, or a player name (partial names ok, e.g. "grup" matches "gruppler")')
      .setRequired(false),
  );

function describeGame(game: GameListEntry): string {
  return `#${game.gameNo} - **${game.white}** vs **${game.black}**`;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const query = interaction.options.getString('game')?.trim();

  if (!query) {
    await interaction.reply(buildGamesListReply());
    return;
  }

  const registry = getGameRegistry();
  const matches = /^\d+$/.test(query)
    ? [registry.find(Number(query))].filter((g): g is GameListEntry => Boolean(g))
    : registry.searchByPlayer(query);

  if (matches.length === 0) {
    await interaction.reply({
      content: `No active game found matching "${query}". Try \`/watch\` with no argument to see what's active.`,
      ephemeral: true,
    });
    return;
  }

  if (matches.length > 1) {
    const options = matches.map(describeGame).join('\n');
    await interaction.reply({
      content: `"${query}" matches more than one active game:\n${options}\nTry again with a game ID, or a more specific name.`,
      ephemeral: true,
    });
    return;
  }

  const game = matches[0];

  if (!(interaction.channel instanceof TextChannel)) {
    await interaction.reply({ content: 'This command only works in a text channel.', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  const { thread, alreadyWatching } = await watchGame(getPlaytakClient(), interaction.channel, game);

  if (alreadyWatching) {
    // A thread for this game already exists (whether this process was
    // already watching it, or one turned up from before a restart - see
    // watchGame()'s "one thread per game" rule) - swap the public deferred
    // placeholder for a private link instead of a public "already watching"
    // post, so multiple people trying to watch the same popular game don't
    // spam the channel.
    await interaction.deleteReply().catch(() => {});
    await interaction.followUp({ content: `This game already has a thread. Spectate: ${thread}`, ephemeral: true });
    return;
  }

  await interaction.editReply(`Spectate: ${thread}`);
}
