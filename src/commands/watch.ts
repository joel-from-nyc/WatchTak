import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  TextChannel,
  MessageFlags,
} from 'discord.js';
import { GameListEntry } from '../playtak/protocol';
import { getGameRegistry, getPlaytakClient } from '../playtak/shared';
import { buildGamesListReply } from '../playtak/gamesReply';
import { watchGame } from '../playtak/watcher';
import { getRating } from '../playtak/ratings';
import { formatPlayerName } from '../playtak/format';

export const data = new SlashCommandBuilder()
  .setName('watch')
  .setDescription('Watch a live PlayTak game in a thread. Leave blank to list active games.')
  .addStringOption((option) =>
    option
      .setName('game')
      .setDescription('Game ID, or a player name (partial names ok, e.g. "grup" matches "gruppler")')
      .setRequired(false)
      .setAutocomplete(true),
  );

function describeGame(game: GameListEntry): string {
  return `#${game.gameNo} - **${game.white}** vs **${game.black}**`;
}

// Discord's caps on an autocomplete response.
const MAX_CHOICES = 25;
const MAX_CHOICE_NAME = 100;

// One dropdown row: players with ratings, board size, and time control.
function choiceName(game: GameListEntry): string {
  const white = formatPlayerName(game.white, getRating(game.white));
  const black = formatPlayerName(game.black, getRating(game.black));
  const minutes = Math.floor(game.timeSeconds / 60);
  const label = `${white} vs ${black} - ${game.boardSize}x${game.boardSize}, ${minutes}+${game.incrementSeconds}`;
  return label.length > MAX_CHOICE_NAME ? `${label.slice(0, MAX_CHOICE_NAME - 1)}…` : label;
}

// The submitted value is always the game number, so a dropdown pick takes
// execute()'s exact-game path.
export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const typed = interaction.options.getFocused().trim().toLowerCase();
  const registry = getGameRegistry();
  const matches = registry
    .list()
    .filter(
      (game) =>
        typed === '' ||
        String(game.gameNo).includes(typed) ||
        game.white.toLowerCase().includes(typed) ||
        game.black.toLowerCase().includes(typed),
    )
    // Newest games first (ids are issued at game start).
    .sort((a, b) => b.gameNo - a.gameNo)
    .slice(0, MAX_CHOICES);

  await interaction
    .respond(matches.map((game) => ({ name: choiceName(game), value: String(game.gameNo) })))
    // An unanswerable dropdown (3s window passed) just means the user types
    // the name out.
    .catch(() => {});
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const query = interaction.options.getString('game')?.trim();

  if (!query) {
    await interaction.reply({ content: buildGamesListReply(), flags: MessageFlags.Ephemeral });
    return;
  }

  const registry = getGameRegistry();
  const matches = /^\d+$/.test(query)
    ? [registry.find(Number(query))].filter((g): g is GameListEntry => Boolean(g))
    : registry.searchByPlayer(query);

  if (matches.length === 0) {
    await interaction.reply({
      content: `No active game found matching "${query}". Try \`/watch\` with no argument to see what's active.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (matches.length > 1) {
    const options = matches.map(describeGame).join('\n');
    await interaction.reply({
      content: `"${query}" matches more than one active game:\n${options}\nTry again with a game ID, or a more specific name.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const game = matches[0];

  if (!(interaction.channel instanceof TextChannel)) {
    await interaction.reply({ content: 'This command only works in a text channel.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();
  const { thread, alreadyWatching } = await watchGame(getPlaytakClient(), interaction.channel, game);

  if (alreadyWatching) {
    // Swap the public placeholder for a private link, so repeat requests for
    // a popular game do not clutter the channel.
    await interaction.deleteReply().catch(() => {});
    await interaction.followUp({ content: `This game already has a thread. Spectate: ${thread}`, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.editReply(`Spectate: ${thread}`);
}
