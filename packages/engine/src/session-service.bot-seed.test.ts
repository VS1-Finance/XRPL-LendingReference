import { describe, it, expect } from "vitest";
import { resolveBotSeed, ValidationError } from "./session-service.js";

// resolveBotSeed turns the untyped request field into the effective per-session bot seed. The route has
// no JSON schema, so it must handle any JSON type the client sends without crashing after a provision.

describe("resolveBotSeed", () => {
  it("uses a supplied non-blank string verbatim", () => {
    expect(resolveBotSeed("repro-123", "tok")).toBe("repro-123");
  });

  it("trims a supplied string", () => {
    expect(resolveBotSeed("  spaced  ", "tok")).toBe("spaced");
  });

  it("generates a seed-<8hex> when omitted", () => {
    const s = resolveBotSeed(undefined, "tok");
    expect(s).toMatch(/^seed-[0-9a-f]{8}$/);
  });

  it("is deterministic in the token: same token -> same generated seed", () => {
    expect(resolveBotSeed(undefined, "tok-A")).toBe(resolveBotSeed(undefined, "tok-A"));
    expect(resolveBotSeed(undefined, "tok-A")).not.toBe(resolveBotSeed(undefined, "tok-B"));
  });

  it("generates when the string is blank or whitespace-only", () => {
    expect(resolveBotSeed("", "tok")).toMatch(/^seed-[0-9a-f]{8}$/);
    expect(resolveBotSeed("   ", "tok")).toMatch(/^seed-[0-9a-f]{8}$/);
  });

  it("rejects a non-string seed with a ValidationError, before any provisioning", () => {
    // These are the shapes a schema-less route can receive; each must be a clean 400, not a 500 after a
    // full environment is funded (the bug this guard fixes: `.trim()` on a number threw post-provision).
    for (const bad of [12345, ["a", "b"], { x: 1 }, true, null] as unknown[]) {
      expect(() => resolveBotSeed(bad, "tok")).toThrow(ValidationError);
    }
  });

  it("does not treat null as absent (null is a client error, not an omitted field)", () => {
    // JSON null is a supplied value of the wrong type — reject it rather than silently generating, so a
    // client that sends the wrong shape learns about it.
    expect(() => resolveBotSeed(null, "tok")).toThrow(/botSeed must be a string/);
  });
});
