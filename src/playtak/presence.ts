import { ActivityType, Client } from 'discord.js';
import { PlaytakClient } from './client';
import { GameRegistry } from './registry';

// Shows the live PlayTak game count under the bot's name ("Watching 4 games
// on PlayTak"), straight from the registry that already backs /list - no
// extra traffic to PlayTak for it.
//
// Refreshed on a timer rather than on every GameList event: games start and
// end constantly, and every (re)connect replays the whole active list at
// once, which would push presence updates far past the handful per minute
// the gateway allows. A minute's lag on a cosmetic counter costs nothing.
const PRESENCE_REFRESH_MS = 60 * 1000;

// Long enough for the post-connect GameList replay to land, so the first
// number shown is the real one rather than a partially-filled registry.
const STARTUP_DELAY_MS = 5000;

function activityName(gameCount: number): string {
  return `${gameCount} game${gameCount === 1 ? '' : 's'} on PlayTak`;
}

export function registerPresence(playtak: PlaytakClient, discordClient: Client, registry: GameRegistry): void {
  const update = (): void => {
    // setActivity throws if the client isn't logged in yet; it also only
    // queues a gateway payload, so there's nothing to await or catch beyond
    // that.
    if (!discordClient.user) return;
    discordClient.user.setActivity(activityName(registry.list().length), { type: ActivityType.Watching });
  };

  playtak.once('connected', () => {
    setTimeout(() => {
      update();
      setInterval(update, PRESENCE_REFRESH_MS);
    }, STARTUP_DELAY_MS);
  });
}
