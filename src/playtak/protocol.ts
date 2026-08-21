// Parser for PlayTak's line-based WebSocket protocol.
//
// Field orders below are confirmed against the server source
// (USTakAssociation/playtak-api, server/src/main/java/tak/{Seek,Game,Client}.java)
// and cross-checked against live traffic captured with src/scripts/playtak-probe.ts.
// Anything not confirmed either way (e.g. "Game Start", "Game# P"/"Game# M" move
// encoding) is left as raw tokens rather than guessed at.

export interface Seek {
  id: number;
  player: string;
  boardSize: number;
  timeSeconds: number;
  incrementSeconds: number;
  color: 'A' | 'W' | 'B';
  komi: number;
  pieces: number;
  capstones: number;
  unrated: boolean;
  tournament: boolean;
  triggerMove: number;
  timeAmount: number;
  opponent: string;
}

export interface GameListEntry {
  gameNo: number;
  white: string;
  black: string;
  boardSize: number;
  timeSeconds: number;
  incrementSeconds: number;
  komi: number;
  pieces: number;
  capstones: number;
  unrated: boolean;
  tournament: boolean;
  triggerMove: number;
  timeAmount: number;
}

export interface PlaceMove {
  // File+rank as sent on the wire, e.g. "A1" (uppercase file, per server regex).
  square: string;
  isCapstone: boolean;
  isWall: boolean;
}

export interface SpreadMove {
  fromSquare: string;
  toSquare: string;
  drops: number[];
}

export type PlaytakEvent =
  | { type: 'welcome' }
  | { type: 'loginPrompt' }
  | { type: 'loggedIn'; username: string }
  | { type: 'ok' }
  | { type: 'nok' }
  | { type: 'online'; count: number }
  | { type: 'onlinePlayers'; players: string[] }
  | { type: 'seekNew'; seek: Seek }
  | { type: 'seekRemove'; seek: Seek }
  | { type: 'gameListAdd'; game: GameListEntry }
  | { type: 'gameListRemove'; game: GameListEntry }
  | { type: 'observeAck'; game: GameListEntry }
  | { type: 'gamePlace'; gameNo: number; move: PlaceMove }
  | { type: 'gameSpread'; gameNo: number; move: SpreadMove }
  | { type: 'gameTime'; gameNo: number; whiteSeconds: number; blackSeconds: number }
  | { type: 'gameUndo'; gameNo: number }
  | { type: 'gameOver'; gameNo: number; result: string }
  | { type: 'gameAbandoned'; gameNo: number; quittingPlayer: string }
  | { type: 'shout'; from: string; message: string }
  | { type: 'message'; text: string }
  | { type: 'tell'; from: string; message: string }
  | { type: 'unknown'; raw: string };

function parseSeekFields(tokens: string[]): Seek {
  const [
    id, player, boardSize, timeSeconds, incrementSeconds, color, komi,
    pieces, capstones, unrated, tournament, triggerMove, timeAmount, opponent,
  ] = tokens;
  return {
    id: Number(id),
    player,
    boardSize: Number(boardSize),
    timeSeconds: Number(timeSeconds),
    incrementSeconds: Number(incrementSeconds),
    color: color as Seek['color'],
    komi: Number(komi),
    pieces: Number(pieces),
    capstones: Number(capstones),
    unrated: unrated === '1',
    tournament: tournament === '1',
    triggerMove: Number(triggerMove),
    timeAmount: Number(timeAmount),
    opponent: opponent ?? '',
  };
}

function parseGameListFields(tokens: string[]): GameListEntry {
  const [
    gameNo, white, black, boardSize, timeSeconds, incrementSeconds, komi,
    pieces, capstones, unrated, tournament, triggerMove, timeAmount,
  ] = tokens;
  return {
    gameNo: Number(gameNo),
    white,
    black,
    boardSize: Number(boardSize),
    timeSeconds: Number(timeSeconds),
    incrementSeconds: Number(incrementSeconds),
    komi: Number(komi),
    pieces: Number(pieces),
    capstones: Number(capstones),
    unrated: unrated === '1',
    tournament: tournament === '1',
    triggerMove: Number(triggerMove),
    timeAmount: Number(timeAmount),
  };
}

export function parseLine(line: string): PlaytakEvent {
  if (line === 'Welcome!') return { type: 'welcome' };
  if (line === 'Login or Register') return { type: 'loginPrompt' };
  if (line === 'OK') return { type: 'ok' };
  if (line === 'NOK') return { type: 'nok' };

  const welcomeMatch = /^Welcome (.+)!$/.exec(line);
  if (welcomeMatch) return { type: 'loggedIn', username: welcomeMatch[1] };

  const onlineMatch = /^Online (\d+)$/.exec(line);
  if (onlineMatch) return { type: 'online', count: Number(onlineMatch[1]) };

  const onlinePlayersMatch = /^OnlinePlayers (\[.*\])$/.exec(line);
  if (onlinePlayersMatch) {
    try {
      const players = JSON.parse(onlinePlayersMatch[1]) as string[];
      return { type: 'onlinePlayers', players };
    } catch {
      return { type: 'unknown', raw: line };
    }
  }

  const seekNewMatch = /^Seek new (.+)$/.exec(line);
  if (seekNewMatch) {
    return { type: 'seekNew', seek: parseSeekFields(seekNewMatch[1].trim().split(' ')) };
  }
  const seekRemoveMatch = /^Seek remove (.+)$/.exec(line);
  if (seekRemoveMatch) {
    return { type: 'seekRemove', seek: parseSeekFields(seekRemoveMatch[1].trim().split(' ')) };
  }

  const gameListAddMatch = /^GameList Add (.+)$/.exec(line);
  if (gameListAddMatch) {
    return { type: 'gameListAdd', game: parseGameListFields(gameListAddMatch[1].trim().split(' ')) };
  }
  const gameListRemoveMatch = /^GameList Remove (.+)$/.exec(line);
  if (gameListRemoveMatch) {
    return { type: 'gameListRemove', game: parseGameListFields(gameListRemoveMatch[1].trim().split(' ')) };
  }

  const observeMatch = /^Observe (.+)$/.exec(line);
  if (observeMatch) {
    return { type: 'observeAck', game: parseGameListFields(observeMatch[1].trim().split(' ')) };
  }

  // Field shapes below match the server's own parsing regexes exactly
  // (server/src/main/java/tak/Client.java: placePattern / movePattern).
  const placeMatch = /^Game#(\d+) P ([A-Z])(\d)( C)?( W)?$/.exec(line);
  if (placeMatch) {
    return {
      type: 'gamePlace',
      gameNo: Number(placeMatch[1]),
      move: {
        square: `${placeMatch[2]}${placeMatch[3]}`,
        isCapstone: Boolean(placeMatch[4]),
        isWall: Boolean(placeMatch[5]),
      },
    };
  }

  const moveMatch = /^Game#(\d+) M ([A-Z])(\d) ([A-Z])(\d)((?: \d+)+)$/.exec(line);
  if (moveMatch) {
    return {
      type: 'gameSpread',
      gameNo: Number(moveMatch[1]),
      move: {
        fromSquare: `${moveMatch[2]}${moveMatch[3]}`,
        toSquare: `${moveMatch[4]}${moveMatch[5]}`,
        drops: moveMatch[6].trim().split(' ').map(Number),
      },
    };
  }

  const gameTimeMatch = /^Game#(\d+) Time (\d+) (\d+)$/.exec(line);
  if (gameTimeMatch) {
    return {
      type: 'gameTime',
      gameNo: Number(gameTimeMatch[1]),
      whiteSeconds: Number(gameTimeMatch[2]),
      blackSeconds: Number(gameTimeMatch[3]),
    };
  }

  const gameUndoMatch = /^Game#(\d+) Undo$/.exec(line);
  if (gameUndoMatch) return { type: 'gameUndo', gameNo: Number(gameUndoMatch[1]) };

  const gameOverMatch = /^Game#(\d+) Over (.+)$/.exec(line);
  if (gameOverMatch) {
    return { type: 'gameOver', gameNo: Number(gameOverMatch[1]), result: gameOverMatch[2] };
  }

  const gameAbandonedMatch = /^Game#(\d+) Abandoned\. (\S+) quit$/.exec(line);
  if (gameAbandonedMatch) {
    return {
      type: 'gameAbandoned',
      gameNo: Number(gameAbandonedMatch[1]),
      quittingPlayer: gameAbandonedMatch[2],
    };
  }

  const shoutMatch = /^Shout <(.+?)> (.*)$/.exec(line);
  if (shoutMatch) return { type: 'shout', from: shoutMatch[1], message: shoutMatch[2] };

  const tellMatch = /^Tell <(.+?)> (.*)$/.exec(line);
  if (tellMatch) return { type: 'tell', from: tellMatch[1], message: tellMatch[2] };

  const messageMatch = /^Message (.*)$/.exec(line);
  if (messageMatch) return { type: 'message', text: messageMatch[1] };

  return { type: 'unknown', raw: line };
}
