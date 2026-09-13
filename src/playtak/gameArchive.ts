import { PlaceMove, SpreadMove } from './protocol';
import { placeToPtn, spreadToPtn } from './ptn';

// A finished game from PlayTak's public archive. `komi` is the raw wire
// half-point value, as in GameListEntry.
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
  // The game's start, as epoch milliseconds. The archive stores no end time.
  startedAtMs: number;
  // Ratings at the time the game was played.
  ratingWhite?: number;
  ratingBlack?: number;
}

// Archive move tokens use the live wire format without the "Game#<no> "
// prefix, comma-separated.
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

// https://api.playtak.com/v1/games-history/:id, fields used here only. An
// unknown id returns a bare `null` body with HTTP 200.
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
  date: number;
  rating_white: number;
  rating_black: number;
}

// Returns undefined if the game is not found, the request fails, or a move
// token cannot be parsed.
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
      startedAtMs: body.date,
      // 0 means no rating.
      ratingWhite: body.rating_white || undefined,
      ratingBlack: body.rating_black || undefined,
    };
  } catch (err) {
    console.error(`Failed to fetch archived game #${gameNo}:`, err);
    return undefined;
  }
}
