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
  currency: Currency.refine((c) => c !== "XRP", "IOU currency cannot be XRP"),
  issuer: ClassicAddress,
});

// Asset reference as it appears in config. For an IOU the issuer may be omitted when the
// harness is asked to stand up its own issuer; in that case `issuer` is filled in at provision
// time from the derived issuer account.
export const AssetConfigSchema = z.union([
  XrpAssetSchema,
  z.object({
    currency: Currency.refine((c) => c !== "XRP", "IOU currency cannot be XRP"),
    issuer: ClassicAddress.optional(),
  }),
]);

export type AssetConfig = z.infer<typeof AssetConfigSchema>;

export function isXrpAsset(a: AssetConfig): a is z.infer<typeof XrpAssetSchema> {
  return a.currency === "XRP";
}
