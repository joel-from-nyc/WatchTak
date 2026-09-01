// Shared text formatting for game/seek details shown in Discord messages
// (the /watch thread intro and /announce's seek posts).

// `halfKomi` is the raw wire value - double the real komi, e.g. 4 means 2
// komi, 5 means 2.5 komi (see Seek.java: `.komi(komi / 2.f)`). Half-point
// values are shown as "½" to match the convention tps-ninja's own board
// rendering uses.
export function formatKomi(halfKomi: number): string {
  const whole = Math.floor(halfKomi / 2);
  const isHalf = halfKomi % 2 !== 0;
  if (!isHalf) return String(whole);
  return whole > 0 ? `${whole}½` : '½';
}

export function formatGameType(unrated: boolean, tournament: boolean): string {
  if (tournament) return 'Tournament';
  return unrated ? 'Unrated' : 'Rated';
}

export function formatSeekColor(color: 'A' | 'W' | 'B'): string {
  if (color === 'A') return 'Random Color';
  return color === 'W' ? 'white' : 'black';
}

// "gruppler (1836)", or just "gruppler" when no rating is known - guests and
// never-rated accounts have none, and PlayTak's own ratings page hides those
// rows rather than showing a zero (see ratings.ts). Omitting the parenthetical
// reads better than repeating "(unrated)" on every name.
export function formatPlayerName(name: string, rating: number | undefined): string {
  return rating === undefined ? name : `${name} (${rating})`;
}

// Same as formatPlayerName(), but with the name itself in bold markdown and
// the rating left plain - for the main-channel messages that bold player
// names. Never used inside a code block (Discord doesn't render markdown
// there - see watchStartText() in watcher.ts, which uses formatPlayerName()
// unbolded instead).
export function formatPlayerNameBold(name: string, rating: number | undefined): string {
  return rating === undefined ? `**${name}**` : `**${name}** (${rating})`;
}

// "Label:   value" with the label padded so the colon column lines up across
// every line sharing the same width - watch threads use this for move/time
// lines (see MOVE_LABEL_WIDTH in catchup.ts) and the thread intro block.
export function alignedLine(label: string, value: string, width: number): string {
  return `${label}:`.padEnd(width + 2) + value;
}

// Every watcher/catch-up post wraps its text in a plain fenced code block -
// keeps the fixed-width alignment intact and Discord markdown inert.
export function codeBlock(lines: string[]): string {
  return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

// Discord renders `<t:UNIX:f>` in each viewer's own timezone and locale, which
// matters for an international community - so times are always emitted as
// these tags rather than as a server-side formatted string. Note they do NOT
// render inside a code block, so callers must keep them outside the fence.
export function discordTime(atMs: number, style: 'f' | 'R' | 't' = 'f'): string {
  return `<t:${Math.floor(atMs / 1000)}:${style}>`;
}

// "24 minutes", "1 hour 5 minutes" - how long a game ran, for the finished
// notice and the thread's Game Over block. Only ever called when both ends of
// the interval are actually known.
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  if (totalMinutes < 1) return 'under a minute';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  return parts.join(' ');
}
