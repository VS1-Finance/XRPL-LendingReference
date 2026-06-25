import { db, disconnectDb } from "./db.js";

// Entry point for the history-store tooling. The start and query commands are wired alongside the
// subscriber and projection; this scope confirms the database connection.
async function main(): Promise<void> {
  await db().$queryRaw`SELECT 1`;
  console.log("history store reachable");
  await disconnectDb();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
