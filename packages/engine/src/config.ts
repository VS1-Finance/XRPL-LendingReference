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
  const baseConfig = loadConfig(configPath);

  // The seed derives every account's keys, so it is a secret: in a deployment it is supplied through
  // ENGINE_SEED (env/secret) rather than committed in the config file. The network may likewise be
  // overridden. Anything unset falls back to the config file.
  const seed = process.env.ENGINE_SEED?.trim();
  const network = process.env.ENGINE_NETWORK?.trim();

  return {
    port: Number(process.env.PORT ?? 4000),
    host: process.env.HOST ?? "0.0.0.0",
    baseConfig: {
      ...baseConfig,
      ...(seed ? { seed } : {}),
      ...(network ? { network: network as Config["network"] } : {}),
    },
  };
}
