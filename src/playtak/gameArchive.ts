import { PlaceMove, SpreadMove } from './protocol';
import { placeToPtn, spreadToPtn } from './ptn';

// Field names/units mirror GameListEntry (protocol.ts) rather than
// WatchState - `komi` is the raw half-point wire value (e.g. 4 means 2
// komi), not yet divided by 2, so callers convert it the same way
// watchGame() already does for a live GameListEntry.
export interface ArchivedGame {
  white: string;
  black: string;
  boardSize: number;
  timeSeconds: number;
  incrementSeconds: number;
  komi: number;
  unrated: boolean;
  tournament: boolean;
  result: string;
  plies: string[];
}

// Same wire-token shapes protocol.ts's placeMatch/moveMatch parse from live
// `Game#<no> ...` lines, minus the `Game#<no> ` prefix - PlayTak's archive
// API returns move tokens in this exact form (comma-separated) rather than
// as full wire lines.
const PLACE_TOKEN = /^P ([A-Z])(\d)( C)?( W)?$/;
const SPREAD_TOKEN = /^M ([A-Z])(\d) ([A-Z])(\d)((?: \d+)+)$/;

function tokenToPtn(token: string): string | undefined {
  const place = PLACE_TOKEN.exec(token);
  if (place) {
    const move: PlaceMove = {
      square: `${place[1]}${place[2]}`,
      isCapstone: Boolean(place[3]),
      isWall: Boolean(place[4]),
    };
    return placeToPtn(move);
  }

  const spread = SPREAD_TOKEN.exec(token);
  if (spread) {
    const move: SpreadMove = {
      fromSquare: `${spread[1]}${spread[2]}`,
      toSquare: `${spread[3]}${spread[4]}`,
      drops: spread[5].trim().split(' ').map(Number),
    };
    return spreadToPtn(move);
  }

  return undefined;
}

// Raw shape of https://api.playtak.com/v1/games-history/:id - see
// USTakAssociation/playtak-api's games.dto.ts. Only the fields used here are
// declared; a nonexistent game id returns a bare `null` body (HTTP 200, not
// 404) - confirmed live.
interface ArchiveResponse {
  player_white: string;
  player_black: string;
  size: number;
  timertime: number;
  timerinc: number;
  komi: number;
  unrated: number;
  tournament: number;
  result: string;
  notation: string;
}

// Fetches a finished game's full record from PlayTak's public game-history
// archive, for reconstructing a Review thread when nobody watched the game
// live (see reconstructThread() in watcher.ts). Returns undefined if the
// game isn't found, the API errors, or a move token can't be parsed -
// callers show a generic "couldn't find a record of that game" rather than a
// partial/corrupt reconstruction.
export async function fetchArchivedGame(gameNo: number): Promise<ArchivedGame | undefined> {
  try {
    const response = await fetch(`https://api.playtak.com/v1/games-history/${gameNo}`);
    if (!response.ok) return undefined;

    const body: ArchiveResponse | null = await response.json();
    if (!body) return undefined;

    const tokens = body.notation.length > 0 ? body.notation.split(',') : [];
    const plies: string[] = [];
    for (const token of tokens) {
      const ptn = tokenToPtn(token.trim());
      if (ptn === undefined) {
        console.error(`Unrecognized move token "${token}" in archived game #${gameNo}`);
        return undefined;
      }
      plies.push(ptn);
    }

    return {
      white: body.player_white,
      black: body.player_black,
      boardSize: body.size,
      timeSeconds: body.timertime,
      incrementSeconds: body.timerinc,
      komi: body.komi,
      unrated: body.unrated === 1,
      tournament: body.tournament === 1,
      result: body.result,
      plies,
    };
  } catch (err) {
    console.error(`Failed to fetch archived game #${gameNo}:`, err);
    return undefined;
  }
}
