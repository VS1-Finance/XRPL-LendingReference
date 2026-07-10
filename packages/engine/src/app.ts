import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { EngineConfig } from "./config.js";
import { SessionService } from "./session-service.js";
import { BotService } from "./bot-service.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSeatRoutes } from "./routes/seats.js";
import { registerActionRoutes } from "./routes/actions.js";
import { registerBotRoutes } from "./routes/bots.js";

// Build the Fastify application: construct the services the engine owns and register the routes over
// them. The bot scheduler lifecycle is owned by the server (started on ready, stopped on close) and
// is wired in as the action and bot routes are added.
export function buildApp(config: EngineConfig): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  // A browser client is served from a different origin than the engine, so cross-origin requests are
  // allowed. CORS_ORIGIN restricts this to a known origin in a deployment; it defaults to permissive
  // for local development where the web app runs on another port.
  app.register(cors, { origin: process.env.CORS_ORIGIN ?? true });

  const sessions = new SessionService(config.baseConfig);
  const bots = new BotService(config.baseConfig.bots);

  app.get("/health", async () => ({ status: "ok" }));

  registerSessionRoutes(app, sessions);
  registerSeatRoutes(app, sessions);
  registerActionRoutes(app, sessions);
  registerBotRoutes(app, sessions, bots);

  // Stop every running scheduler when the server shuts down.
  app.addHook("onClose", async () => bots.stopAll());

  return app;
}
