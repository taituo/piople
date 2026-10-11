import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Make a database file ready to be opened: its directory (created as 0700 when it is new) and the file itself (created as
 * 0600 when it is new). A database holds everything people wrote in a case, and SQLite creates files with the umask, usually
 * 0644: any other user on the machine could read it. SQLite gives the -wal and -shm files the mode of the database file.
 * Existing files and directories are left as they are: they are the operator's.
 */
export function preparePrivateDatabase(path: string): void {
  if (path === ":memory:") return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
}
