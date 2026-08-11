import { z } from "zod";

// A vault asset is either native XRP or an IOU (currency + issuer).
//
// The default asset is an issued currency, because issuer powers (clawback, freeze) only exist
// on an issued asset — they cannot be exercised on an XRP vault, which has no issuer.
//
// Currency codes follow xrpl.js conventions: a 3-char ISO-like code, or a 40-char hex code for
// non-standard currencies.
const Currency = z
  .string()
  .refine((c) => c === "XRP" || /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/.test(c) || /^[0-9A-Fa-f]{40}$/.test(c), {
    message: "currency must be 'XRP', a 3-char code, or a 40-char hex code",
  });

const ClassicAddress = z
  .string()
  .regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/, "must be a classic r-address");

export const XrpAssetSchema = z.object({
  currency: z.literal("XRP"),
});

export const IouAssetSchema = z.object({
  currency: Currency.refine((c) => c !== "XRP" && c !== "MPT", "IOU currency cannot be XRP or MPT"),
  issuer: ClassicAddress,
});

// An MPT (Multi-Purpose Token) asset is identified by its 192-bit MPTokenIssuanceID (48 hex
// chars), not by a currency+issuer pair. The `currency: "MPT"` discriminant mirrors how XRP uses
// `currency: "XRP"`, keeping the union unambiguous. `mptIssuanceId` may be omitted when the
// harness is asked to stand up its own issuance; in that case it is filled in at provision time,
// mirroring the IOU `issuer` optional case.
export const MptAssetSchema = z.object({
  currency: z.literal("MPT"),
  mptIssuanceId: z
    .string()
    .regex(/^[0-9A-Fa-f]{48}$/, "mptIssuanceId must be a 48-character hex string")
    .optional(),
  // Decimal places the vault-asset MPT issuance is created at (MPTokenIssuanceCreate's AssetScale).
  // Omitted when the harness is asked to stand up its own issuance at the default scale; in that case
  // the runtime falls back to 2 wherever this is read, matching today's hardcoded behavior exactly.
  assetScale: z.number().int().min(0).max(15).optional(),
});

// Asset reference as it appears in config. For an IOU the issuer may be omitted when the
// harness is asked to stand up its own issuer; in that case `issuer` is filled in at provision
// time from the derived issuer account.
export const AssetConfigSchema = z.union([
  XrpAssetSchema,
  MptAssetSchema,
  z.object({
    currency: Currency.refine((c) => c !== "XRP" && c !== "MPT", "IOU currency cannot be XRP or MPT"),
    issuer: ClassicAddress.optional(),
  }),
]);

export type AssetConfig = z.infer<typeof AssetConfigSchema>;

export function isXrpAsset(a: AssetConfig): a is z.infer<typeof XrpAssetSchema> {
  return a.currency === "XRP";
}

export function isMptAsset(a: AssetConfig): a is z.infer<typeof MptAssetSchema> {
  return a.currency === "MPT";
}
