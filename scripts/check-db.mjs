import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const argument = process.argv[2];
if (!argument || process.argv.length !== 3) {
  console.error("Usage: npm run check-db -- <database.db>");
  process.exitCode = 1;
} else {
  const path = resolve(argument);
  let database;
  try {
    if (!existsSync(path)) throw new Error("Database file does not exist");
    database = new DatabaseSync(path, { readOnly: true });
    const integrity = database.prepare("PRAGMA integrity_check").all();
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error(`SQLite integrity check failed (${integrity.length} result rows)`);
    }
    if (foreignKeys.length > 0) {
      throw new Error(`SQLite foreign-key check failed (${foreignKeys.length} violations)`);
    }
    console.log(`SQLite integrity and foreign keys OK: ${path}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    database?.close();
  }
}
