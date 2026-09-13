import { getGameRegistry } from './shared';

export function buildGamesListReply(): string {
  const games = getGameRegistry().list();

  if (games.length === 0) {
    return 'No active games on PlayTak right now.';
  }

  const lines = games.map((game) => {
    const minutes = Math.floor(game.timeSeconds / 60);
    const rated = game.unrated ? 'unrated' : 'rated';
    return (
      `#${game.gameNo} - **${game.white}** vs **${game.black}** ` +
      `(${game.boardSize}x${game.boardSize}, ${minutes}+${game.incrementSeconds}, ${rated})`
    );
  });

  const maxLines = 20;
  return lines.length > maxLines
    ? `${lines.slice(0, maxLines).join('\n')}\n...and ${lines.length - maxLines} more.`
    : lines.join('\n');
}
