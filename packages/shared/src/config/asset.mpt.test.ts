import { describe, it, expect } from "vitest";
import { AssetConfigSchema, isMptAsset, isXrpAsset } from "./asset.js";

// A syntactically valid 48-char hex MPTokenIssuanceID, and 47/49-char variants derived from it.
const HEX_48 = "00081A9C7E4C5EFD1DFD0C6E8F5F3B0A5E4E2A1B2C3D4E5F";
const HEX_47 = HEX_48.slice(0, 47);
const HEX_49 = HEX_48 + "0";

describe("MPT asset schema", () => {
  it("parses {currency:'MPT'} with no mptIssuanceId", () => {
    const r = AssetConfigSchema.safeParse({ currency: "MPT" });
    expect(r.success).toBe(true);
  });

  it("parses {currency:'MPT', mptIssuanceId:<48 hex>}", () => {
    expect(HEX_48).toHaveLength(48);
    const r = AssetConfigSchema.safeParse({ currency: "MPT", mptIssuanceId: HEX_48 });
    expect(r.success).toBe(true);
    if (r.success) {
      const a = r.data;
      expect(isMptAsset(a)).toBe(true);
      if (isMptAsset(a)) expect(a.mptIssuanceId).toBe(HEX_48);
    }
  });

  it("isMptAsset returns true for a parsed MPT asset", () => {
    const r = AssetConfigSchema.safeParse({ currency: "MPT" });
    expect(r.success).toBe(true);
    if (r.success) expect(isMptAsset(r.data)).toBe(true);
  });

  it("isMptAsset returns false for XRP", () => {
    const r = AssetConfigSchema.safeParse({ currency: "XRP" });
    expect(r.success).toBe(true);
    if (r.success) expect(isMptAsset(r.data)).toBe(false);
  });

  it("isMptAsset returns false for an IOU", () => {
    const r = AssetConfigSchema.safeParse({ currency: "USD", issuer: "rP9jPyP5kyvFRb6ZiRghAGw5u8SGAmU4bd" });
    expect(r.success).toBe(true);
    if (r.success) expect(isMptAsset(r.data)).toBe(false);
  });

  it("isXrpAsset returns false for MPT", () => {
    const r = AssetConfigSchema.safeParse({ currency: "MPT" });
    expect(r.success).toBe(true);
    if (r.success) expect(isXrpAsset(r.data)).toBe(false);
  });

  it("rejects a 47-char mptIssuanceId (too short)", () => {
    const r = AssetConfigSchema.safeParse({ currency: "MPT", mptIssuanceId: HEX_47 });
    expect(r.success).toBe(false);
  });

  it("rejects a 49-char mptIssuanceId (too long)", () => {
    const r = AssetConfigSchema.safeParse({ currency: "MPT", mptIssuanceId: HEX_49 });
    expect(r.success).toBe(false);
  });

  it("does not match {currency:'MPT'} as the IOU variant (no issuer required, unambiguous discrimination)", () => {
    const r = AssetConfigSchema.safeParse({ currency: "MPT" });
    expect(r.success).toBe(true);
    if (r.success) {
      // If this had matched the IOU union member, isMptAsset would be false since IOU has no
      // currency==="MPT" allowance. Confirms MPT variant won discrimination.
      expect(isMptAsset(r.data)).toBe(true);
    }
  });

  describe("assetScale", () => {
    it("parses {currency:'MPT'} with no assetScale (defaults downstream to 2)", () => {
      const r = AssetConfigSchema.safeParse({ currency: "MPT" });
      expect(r.success).toBe(true);
      if (r.success && isMptAsset(r.data)) expect(r.data.assetScale).toBeUndefined();
    });

    it.each([0, 1, 2, 4, 15])("accepts assetScale %d (in-bounds)", (assetScale) => {
      const r = AssetConfigSchema.safeParse({ currency: "MPT", assetScale });
      expect(r.success).toBe(true);
      if (r.success && isMptAsset(r.data)) expect(r.data.assetScale).toBe(assetScale);
    });

    it("rejects assetScale -1 (below minimum)", () => {
      const r = AssetConfigSchema.safeParse({ currency: "MPT", assetScale: -1 });
      expect(r.success).toBe(false);
    });

    it("rejects assetScale 16 (above maximum)", () => {
      const r = AssetConfigSchema.safeParse({ currency: "MPT", assetScale: 16 });
      expect(r.success).toBe(false);
    });

    it("rejects a non-integer assetScale", () => {
      const r = AssetConfigSchema.safeParse({ currency: "MPT", assetScale: 2.5 });
      expect(r.success).toBe(false);
    });

    it("assetScale is not part of the XRP or IOU variants", () => {
      const xrp = AssetConfigSchema.safeParse({ currency: "XRP", assetScale: 4 });
      expect(xrp.success).toBe(true);
      if (xrp.success) expect((xrp.data as Record<string, unknown>).assetScale).toBeUndefined();

      const iou = AssetConfigSchema.safeParse({ currency: "USD", issuer: "rP9jPyP5kyvFRb6ZiRghAGw5u8SGAmU4bd", assetScale: 4 });
      expect(iou.success).toBe(true);
      if (iou.success) expect((iou.data as Record<string, unknown>).assetScale).toBeUndefined();
    });
  });
});
