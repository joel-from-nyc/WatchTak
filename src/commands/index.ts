import { SlashCommandBuilder, SlashCommandOptionsOnlyBuilder, SlashCommandSubcommandsOnlyBuilder } from 'discord.js';
import { ChatInputCommandInteraction, AutocompleteInteraction } from 'discord.js';
import * as ping from './ping';
import * as list from './list';
import * as watch from './watch';
import * as help from './help';
import * as seeks from './seeks';
import * as spectate from './spectate';
import * as announce from './announce';
import * as showbots from './showbots';
import * as rating from './rating';
import * as prune from './prune';
import * as expand from './expand';

export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

// Every slash command. index.ts dispatches from this list and
// deploy-commands.ts registers it, so a command added here is both routed
// and registered.
export const commands: Command[] = [
  ping,
  list,
  watch,
  help,
  seeks,
  spectate,
  announce,
  showbots,
  rating,
  prune,
  expand,
];
