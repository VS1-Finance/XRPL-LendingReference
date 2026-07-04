import Fastify, { type FastifyInstance } from "fastify";
import type { EngineConfig } from "./config.js";
import { SessionService } from "./session-service.js";
import { registerSessionRoutes } from "./routes/sessions.js";

// Build the Fastify application: construct the services the engine owns and register the routes over
// them. The bot scheduler lifecycle is owned by the server (started on ready, stopped on close) and
// is wired in as the action and bot routes are added.
export function buildApp(config: EngineConfig): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const sessions = new SessionService(config.baseConfig);

  app.get("/health", async () => ({ status: "ok" }));

  registerSessionRoutes(app, sessions);

  return app;
}
