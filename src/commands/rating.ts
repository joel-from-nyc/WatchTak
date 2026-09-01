import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { getRatingRule, setRatingRule, RatingRule } from '../playtak/ratingStore';

export const data = new SlashCommandBuilder()
  .setName('rating')
  .setDescription('Always announce/watch a human-vs-bot game meeting a rating threshold here, or check status')
  .addIntegerOption((option) => option.setName('human').setDescription('Minimum rating for the human side').setMinValue(0))
  .addIntegerOption((option) => option.setName('bot').setDescription('Minimum rating for the bot side').setMinValue(0))
  .addBooleanOption((option) => option.setName('off').setDescription('Clear the current rating override'))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

function describeRule(rule: RatingRule): string {
  const humanPart = rule.humanMin !== undefined ? `rated ${rule.humanMin}+` : 'any rating';
  const botPart = rule.botMin !== undefined ? `rated ${rule.botMin}+` : 'any rating';
  return `a human (${humanPart}) playing a bot (${botPart})`;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const channelId = interaction.channelId;
  const off = interaction.options.getBoolean('off');
  const human = interaction.options.getInteger('human');
  const bot = interaction.options.getInteger('bot');

  if (off) {
    setRatingRule(channelId, undefined);
    await interaction.reply('Rating override cleared - normal /announce and /showbots filtering applies again.');
    return;
  }

  if (human === null && bot === null) {
    const rule = getRatingRule(channelId);
    await interaction.reply(
      rule
        ? `Rating override in this channel: always show ${describeRule(rule)}, regardless of other settings.`
        : 'No rating override is set in this channel.',
    );
    return;
  }

  const rule: RatingRule = { humanMin: human ?? undefined, botMin: bot ?? undefined };
  setRatingRule(channelId, rule);
  await interaction.reply(`Rating override set - I'll always show ${describeRule(rule)}, regardless of other settings.`);
}
