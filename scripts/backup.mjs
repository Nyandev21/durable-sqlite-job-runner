import { randomUUID } from "node:crypto";
import { existsSync, linkSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const [sourceArg, targetArg] = process.argv.slice(2);
if (!sourceArg || !targetArg) {
  console.error("Usage: npm run backup -- <source.db> <backup.db>");
  process.exitCode = 1;
} else {
  const source = resolve(sourceArg);
  const target = resolve(targetArg);
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  let database;
  try {
    if (source === target) throw new Error("Source and destination must differ");
    if (!existsSync(source)) throw new Error("Source database does not exist");
    if (existsSync(target)) throw new Error("Destination already exists");
    database = new DatabaseSync(source, { readOnly: true });
    await backup(database, temporary);
    // Publish atomically without replacing an existing backup.
    linkSync(temporary, target);
    console.log(`Backup created: ${target}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    database?.close();
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
