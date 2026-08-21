// Result strings confirmed against server/src/main/java/tak/Game.java's
// gameStateString(): R/F = road/flat win, bare 1-0/0-1 covers resignation
// and win-on-time (the server doesn't distinguish those on the wire).
export function describeResult(result: string, white: string, black: string): string {
  switch (result) {
    case '1/2-1/2':
      return 'Draw.';
    case 'R-0':
      return `**${white}** wins by road!`;
    case '0-R':
      return `**${black}** wins by road!`;
    case 'F-0':
      return `**${white}** wins by flats.`;
    case '0-F':
      return `**${black}** wins by flats.`;
    case '1-0':
      return `**${white}** wins.`;
    case '0-1':
      return `**${black}** wins.`;
    case '0-0':
      return 'Game aborted, no result.';
    default:
      return result;
  }
}
