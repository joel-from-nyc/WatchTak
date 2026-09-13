import fs from 'fs';
import path from 'path';

// A small JSON file of per-channel settings, cached in memory. This process
// is the only writer. Files live in DATA_DIR (default: data/ at the project
// root) and are namespaced by DISCORD_GUILD_ID so two instances built from
// one dist/ keep separate state. The path is computed lazily because
// index.ts loads the env file after this module is imported.
export interface JsonStore<T extends object> {
  get(): T;
  set(state: T): void;
}

export function dataDir(): string {
  return process.env.DATA_DIR ?? path.join(__dirname, '..', '..', 'data');
}

function storePath(name: string): string {
  const guildId = process.env.DISCORD_GUILD_ID;
  return path.join(dataDir(), guildId ? `${name}.${guildId}.json` : `${name}.json`);
}

export function createJsonStore<T extends object>(name: string, empty: () => T): JsonStore<T> {
  let cached: T | undefined;

  const read = (): T => {
    try {
      return JSON.parse(fs.readFileSync(storePath(name), 'utf8'));
    } catch {
      return empty();
    }
  };

  // Written to a temp file and renamed, so a crash mid-write leaves the
  // previous file intact rather than a truncated one.
  const write = (state: T): void => {
    const target = storePath(name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, target);
  };

  return {
    get() {
      if (!cached) cached = read();
      return cached;
    },
    set(state: T) {
      cached = state;
      write(state);
    },
  };
}
