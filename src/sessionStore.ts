// Minimal in-memory store linking a game session ID to the Discord channel
// that should receive updates about it. Swap this for a real database
// (Redis, Postgres, etc.) once you move past the proof-of-concept stage —
// an in-memory Map is wiped every time the bot restarts.

interface SessionInfo {
  channelId: string;
  createdAt: number;
}

const sessions = new Map<string, SessionInfo>();

export function registerSession(sessionId: string, channelId: string) {
  sessions.set(sessionId, { channelId, createdAt: Date.now() });
}

export function getSession(sessionId: string): SessionInfo | undefined {
  return sessions.get(sessionId);
}
