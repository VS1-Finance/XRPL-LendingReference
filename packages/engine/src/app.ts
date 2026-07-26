import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { EngineConfig } from "./config.js";
import { SessionService } from "./session-service.js";
import { BotService } from "./bot-service.js";
import { EngineStore } from "./store.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSeatRoutes } from "./routes/seats.js";
import { registerActionRoutes } from "./routes/actions.js";
import { registerBotRoutes } from "./routes/bots.js";

// Build the Fastify application: connect the durable store, reload persisted sessions, construct the
// services the engine owns, and register the routes over them. The store is a hard dependency — the
// engine persists every session and action, so it fails fast if the database is unreachable. The bot
// scheduler lifecycle is owned by the server (stopped on close), and the store is disconnected on close.
export async function buildApp(config: EngineConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  // A browser client is served from a different origin than the engine, so cross-origin requests are
  // allowed. CORS_ORIGIN restricts this to a known origin in a deployment; it defaults to permissive
  // for local development where the web app runs on another port.
  app.register(cors, { origin: process.env.CORS_ORIGIN ?? true });

  const store = new EngineStore();
  await store.connect();

  const sessions = new SessionService(config.baseConfig, store);
  const bots = new BotService(config.baseConfig.bots, sessions);

  // Bring back every session that survived a previous run.
  const restored = await sessions.loadPersisted();
  if (restored > 0) app.log.info(`restored ${restored} session(s) from the store`);

  app.get("/health", async () => ({ status: "ok" }));

  registerSessionRoutes(app, sessions, bots);
  registerSeatRoutes(app, sessions);
  registerActionRoutes(app, sessions);
  registerBotRoutes(app, sessions, bots);

  // Stop every running scheduler and release the store when the server shuts down.
  app.addHook("onClose", async () => {
    bots.stopAll();
    await store.disconnect();
  });

  return app;
}
