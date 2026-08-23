// Result strings confirmed against server/src/main/java/tak/Game.java's
// gameStateString(): R/F = road/flat win, bare 1-0/0-1 covers both
// resignation and winning on time - confirmed against the server source
// (Game.java's resign() sets the exact same game state a time-out does),
// there's no separate signal for either on the wire. The winner is never in
// doubt (a bare "1-0" always means white won, whichever way), only the
// *reason* is unknown - so the score is shown alongside rather than
// guessing at "resigned" or "timed out".
export function describeResult(result: string, white: string, black: string): string {
  switch (result) {
    case '1/2-1/2':
      return 'Draw.';
    case 'R-0':
      return `${white} wins by road!`;
    case '0-R':
      return `${black} wins by road!`;
    case 'F-0':
      return `${white} wins by flats.`;
    case '0-F':
      return `${black} wins by flats.`;
    case '1-0':
      return `${white} wins. (${result})`;
    case '0-1':
      return `${black} wins. (${result})`;
    case '0-0':
      return 'Game aborted, no result.';
    default:
      return result;
  }
}
