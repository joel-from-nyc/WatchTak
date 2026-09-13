// Result strings as sent by the server: R = road win, F = flat win. A bare
// "1-0" / "0-1" covers both resignation and a win on time; the wire does not
// distinguish them, so the score is shown as-is.
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
