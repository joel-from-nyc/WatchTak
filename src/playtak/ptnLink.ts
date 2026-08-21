import { formatPtnMoveList } from './ptn';

export interface PtnGameInfo {
  white: string;
  black: string;
  boardSize: number;
  komi: number;
  result?: string;
  plies: string[];
}

// ptn.ninja reads plaintext PTN passed directly in the URL path (confirmed
// by loading a hand-built link in a browser - see https://ptn.ninja readme's
// "URLs" section). No shortening/encoding service needed to make it work,
// just to make it short.
function buildPtnDocument(game: PtnGameInfo): string {
  const lines = [
    '[Site "PlayTak.com"]',
    `[Player1 "${game.white}"]`,
    `[Player2 "${game.black}"]`,
    `[Size "${game.boardSize}"]`,
  ];
  if (game.komi) lines.push(`[Komi "${game.komi}"]`);
  if (game.result) lines.push(`[Result "${game.result}"]`);
  lines.push('', formatPtnMoveList(game.plies));
  return lines.join('\n');
}

function buildLongLink(game: PtnGameInfo): string {
  return `https://ptn.ninja/${encodeURIComponent(buildPtnDocument(game))}`;
}

// Shortens a ptn.ninja link via its own shortening service (confirmed
// working: POSTing a PTN string returns a https://ptn.ninja/s/<id> link that
// resolves to the same game - see https://ptn.ninja readme's "URLs"
// section). Falls back to the full-length link if the service is
// unavailable, so a game-over announcement never fails outright over this.
export async function buildPtnNinjaLink(game: PtnGameInfo): Promise<string> {
  const ptn = buildPtnDocument(game);
  try {
    const response = await fetch('https://url.ptn.ninja/short', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ptn }),
    });
    if (!response.ok) throw new Error(`ptn.ninja shortener returned ${response.status}`);
    const shortUrl = (await response.text()).trim();
    if (shortUrl.startsWith('https://ptn.ninja/')) return shortUrl;
    throw new Error(`Unexpected response from ptn.ninja shortener: ${shortUrl}`);
  } catch (err) {
    console.error('Failed to shorten ptn.ninja link, falling back to full-length link:', err);
    return buildLongLink(game);
  }
}
