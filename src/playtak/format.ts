// Shared text formatting for Discord messages.

// `halfKomi` is the wire value, double the real komi: 4 means 2, 5 means 2½.
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

// "gruppler (1836)", or the bare name when no rating is known.
export function formatPlayerName(name: string, rating: number | undefined): string {
  return rating === undefined ? name : `${name} (${rating})`;
}

// Same with the name in bold. Not for use inside code blocks, where Discord
// does not render markdown.
export function formatPlayerNameBold(name: string, rating: number | undefined): string {
  return rating === undefined ? `**${name}**` : `**${name}** (${rating})`;
}

// "Label:   value", with the label padded to `width` so colons line up.
export function alignedLine(label: string, value: string, width: number): string {
  return `${label}:`.padEnd(width + 2) + value;
}

// A plain fenced code block: fixed-width alignment, markdown inert.
export function codeBlock(lines: string[]): string {
  return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

// A `<t:UNIX:style>` tag, which Discord renders in each viewer's own
// timezone. Not rendered inside code blocks.
export function discordTime(atMs: number, style: 'f' | 'R' | 't' = 'f'): string {
  return `<t:${Math.floor(atMs / 1000)}:${style}>`;
}

// "9:05" from a clock value in seconds.
export function formatSeconds(totalSeconds: number): string {
  const clamped = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// "24 minutes", "1 hour 5 minutes".
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
