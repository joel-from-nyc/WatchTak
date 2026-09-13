import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { getRatingRule, setRatingRule, RatingRule } from '../playtak/ratingStore';

export const data = new SlashCommandBuilder()
  .setName('rating')
  .setDescription('Only show games with a human at this rating or above (bots must meet their own minimum)')
  .addIntegerOption((option) =>
    option.setName('human').setDescription('Minimum rating for the human side').setMinValue(0),
  )
  .addIntegerOption((option) =>
    option.setName('bot').setDescription('Minimum rating for a bot opponent').setMinValue(0),
  )
  .addBooleanOption((option) => option.setName('off').setDescription('Clear the current rating filter'))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

function describeRule(rule: RatingRule): string {
  const humanPart = rule.humanMin !== undefined ? `rated ${rule.humanMin}+` : 'any rating';
  const botPart = rule.botMin !== undefined ? `rated ${rule.botMin}+` : 'any rating';
  return `games with a human (${humanPart}) playing another human, or a bot (${botPart})`;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const channelId = interaction.channelId;
  const off = interaction.options.getBoolean('off');
  const human = interaction.options.getInteger('human');
  const bot = interaction.options.getInteger('bot');

  if (off) {
    setRatingRule(channelId, undefined);
    await interaction.reply({
      content: 'Rating filter cleared - normal /announce and /showbots filtering applies again.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (human === null && bot === null) {
    const rule = getRatingRule(channelId);
    await interaction.reply({
      content: rule
        ? `Rating filter in this channel: only showing ${describeRule(rule)}. Everything else is hidden.`
        : 'No rating filter is set in this channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const rule: RatingRule = { humanMin: human ?? undefined, botMin: bot ?? undefined };
  setRatingRule(channelId, rule);
  await interaction.reply({
    content:
      `Rating filter set - I'll only show ${describeRule(rule)} here. Everything else is hidden, ` +
      'overriding /showbots and the /announce mode (quiet still silences the channel entirely).',
    flags: MessageFlags.Ephemeral,
  });
}
