import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildApp } from "./app.js";
import { loadEngineConfig } from "./config.js";

// Load the engine package's .env (for ENGINE_DATABASE_URL and friends) if present, so `pnpm engine`
// works from the repo root without exporting variables by hand. Uses Node's built-in loader — no
// dependency — and never overrides variables already set in the environment.
function loadPackageEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "..", ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

async function main(): Promise<void> {
  loadPackageEnv();
  const config = loadEngineConfig();
  const app = await buildApp(config);

  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
