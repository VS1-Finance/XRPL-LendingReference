import { describe, it, expect } from "vitest";
import { resolveMptAssetScale, ValidationError } from "./session-service.js";

// resolveMptAssetScale validates the untyped `mptAssetScale` request field BEFORE any provisioning. The
// route has no JSON schema, so the assembled per-session config never re-runs zod — this helper is the
// only thing standing between a bad client value and 10^scale BigInt shaping (a non-integer throws) or an
// out-of-spec MPTokenIssuanceCreate.AssetScale on the ledger. Every bad shape must be a clean 400 here,
// not a 500 mid-provision after a whole environment has started funding.

describe("resolveMptAssetScale", () => {
  it("returns undefined when absent, so the MPT default (2) applies downstream", () => {
    expect(resolveMptAssetScale(undefined)).toBeUndefined();
    // null is an omitted field, not a wrong-typed value: fall through to the default rather than 400,
    // matching the old `opts.mptAssetScale !== undefined` config gate.
    expect(resolveMptAssetScale(null)).toBeUndefined();
  });

  it("accepts valid in-range integers verbatim, including the boundaries", () => {
    for (const ok of [0, 1, 2, 4, 15]) {
      expect(resolveMptAssetScale(ok)).toBe(ok);
    }
  });

  it("rejects out-of-range integers (16, 100, -1) with a ValidationError", () => {
    for (const bad of [16, 100, -1, -3]) {
      expect(() => resolveMptAssetScale(bad)).toThrow(/mptAssetScale must be between 0 and 15/);
    }
  });

  it("rejects non-integers (2.5, NaN, Infinity) — they throw in 10^scale BigInt shaping otherwise", () => {
    for (const bad of [2.5, NaN, Infinity, -Infinity, 0.1]) {
      expect(() => resolveMptAssetScale(bad)).toThrow(/mptAssetScale must be an integer/);
    }
  });

  it("rejects non-number shapes a schema-less route can receive (string, array, object, boolean)", () => {
    // "4" is the sharpest one: it coerces through 10^scale math but reaches the ledger as a JSON string
    // AssetScale, so it must be rejected at the boundary, not silently accepted.
    for (const bad of ["4", "2", ["2"], { scale: 2 }, true] as unknown[]) {
      expect(() => resolveMptAssetScale(bad)).toThrow(ValidationError);
    }
  });
});
