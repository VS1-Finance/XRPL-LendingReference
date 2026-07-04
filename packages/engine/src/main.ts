import { buildApp } from "./app.js";
import { loadEngineConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadEngineConfig();
  const app = buildApp(config);

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
