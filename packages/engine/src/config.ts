import { loadConfig, type Config } from "@lending/shared";

// Engine runtime settings. The base configuration is the template every session is provisioned from;
// each new session gets a fresh setup id and derivation seed derived from it, so sessions do not
// collide on-chain.
export interface EngineConfig {
  port: number;
  host: string;
  baseConfig: Config;
}

export function loadEngineConfig(): EngineConfig {
  const configPath = process.env.ENGINE_CONFIG ?? "./packages/bootstrap/config.example.json";
  return {
    port: Number(process.env.PORT ?? 4000),
    host: process.env.HOST ?? "0.0.0.0",
    baseConfig: loadConfig(configPath),
  };
}
