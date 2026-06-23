import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { ConfigSchema, type Config } from "./schema.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// Validate an already-parsed object against the config schema. Throws ConfigError with a
// readable, multi-line summary of every problem rather than a raw zod dump.
export function validateConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (result.success) return result.data;
  throw new ConfigError(formatIssues(result.error));
}

// Read, JSON-parse and validate a config file. Fails fast: a missing file, malformed JSON, or an
// invalid field each throw a ConfigError before any network work begins.
export function loadConfig(path: string): Config {
  const abs = resolve(path);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`cannot read config at ${abs}: ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`config at ${abs} is not valid JSON: ${reason}`);
  }

  return validateConfig(parsed);
}

function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const where = issue.path.length ? issue.path.join(".") : "(root)";
    return `  - ${where}: ${issue.message}`;
  });
  return `invalid config:\n${lines.join("\n")}`;
}
