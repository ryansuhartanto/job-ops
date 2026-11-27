/**
 * Database connection and initialization.
 */

import Database, { type Changes } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { getDataDir } from "../config/dataDir";
import * as schema from "./schema";

// Database path - can be overridden via env for Docker
const DB_PATH = join(getDataDir(), "jobs.db");

// Ensure data directory exists
const dataDir = dirname(DB_PATH);
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const sqlite = new Database(DB_PATH);
sqlite.run("PRAGMA journal_mode = WAL");
// better-sqlite3 enabled these by default; bun:sqlite does not.
sqlite.run("PRAGMA foreign_keys = ON");
sqlite.run("PRAGMA busy_timeout = 5000");
let isClosed = false;

// shortcut: drizzle 0.45 types bun-sqlite run results as void although bun:sqlite
// returns Changes; drop the cast once drizzle types it (1.0 does).
export const db = drizzle(sqlite, { schema }) as unknown as BaseSQLiteDatabase<
  "sync",
  Changes,
  typeof schema
>;

export { schema };

export function closeDb() {
  if (isClosed) return;
  sqlite.close();
  isClosed = true;
}
