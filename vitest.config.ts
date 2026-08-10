import { defineConfig } from "vitest/config";

// Unit tests live beside the code they cover (packages/**/src/**/*.test.ts). They run against the
// pure logic layers only — no network, no ledger — so they are fast and deterministic. Live-on-Devnet
// checks and the negative suite remain separate.
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/src/**/*.test.ts"],
  },
});
