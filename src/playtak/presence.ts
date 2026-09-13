import { ActivityType, Client } from 'discord.js';
import { getPlaytakClient, getGameRegistry } from './shared';

// Shows "Watching N games on PlayTak" as the bot's activity, from the game
// registry. Refreshed on a timer rather than per GameList event, since
// reconnect replays would exceed the gateway's presence rate limit.
const PRESENCE_REFRESH_MS = 60 * 1000;

// Lets the post-connect GameList replay land before the first update.
const STARTUP_DELAY_MS = 5000;

function activityName(gameCount: number): string {
  return `${gameCount} game${gameCount === 1 ? '' : 's'} on PlayTak`;
}

export function registerPresence(discordClient: Client): void {
  const registry = getGameRegistry();
  const update = (): void => {
    if (!discordClient.user) return;
    discordClient.user.setActivity(activityName(registry.list().length), { type: ActivityType.Watching });
  };

  getPlaytakClient().once('connected', () => {
    setTimeout(() => {
      update();
      setInterval(update, PRESENCE_REFRESH_MS);
    }, STARTUP_DELAY_MS);
  });
}
