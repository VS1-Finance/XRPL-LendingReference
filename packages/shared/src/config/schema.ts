import { z } from "zod";
import { AssetConfigSchema } from "./asset.js";

// Networks the harness knows how to reach. Both carry the full vault + lending amendment stack.
export const NetworkSchema = z.enum(["devnet", "wasm-devnet"]);
export type Network = z.infer<typeof NetworkSchema>;

// Only one withdrawal policy is exposed by the current ledger build:
// first-come-first-serve. Kept as a named enum so additional policies slot in without a config
// break if the ledger later exposes them.
export const WithdrawalPolicySchema = z.enum(["first-come-first-serve"]);
export type WithdrawalPolicy = z.infer<typeof WithdrawalPolicySchema>;

// A credential a domain will accept: an issuer plus a credential type. The type is given as
// readable ASCII in config and hex-encoded for the ledger at provision time.
const AcceptedCredentialSchema = z.object({
  // Optional and currently informational: the harness always issues credentials from its own derived
  // credential-issuer account (a separate account from the currency issuer), so a configured issuer here
  // is not yet honored by provisioning. Kept for forward compatibility.
  issuer: z
    .string()
    .regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/, "must be a classic r-address")
    .optional(),
  credentialType: z.string().min(1).max(64),
});

// Cover and fee rates are scaled integers on the ledger (a rate of 100000 reads as 100%).
// They are validated as non-negative integers here; semantic bounds are enforced at provision
// time against live broker fields.
const ScaledRate = z.number().int().nonnegative();

export const ConfigSchema = z
  .object({
    // Seed for deterministic account derivation. The same seed reproduces the same accounts,
    // so a re-run reuses addresses instead of leaking fresh ones.
    seed: z.string().min(16, "seed must be at least 16 characters of entropy"),

    network: NetworkSchema,

    // Identifies a provisioned environment end to end. Stamped on every transaction and used as
    // the key for idempotent re-runs and scoped teardown. Generated if omitted.
    setupId: z.string().min(1).max(64).optional(),

    asset: AssetConfigSchema,

    withdrawalPolicy: WithdrawalPolicySchema.default("first-come-first-serve"),

    // Optional. When present, the vault is permissioned: a domain gates access and only holders of an
    // accepted credential may deposit/borrow (the tecNO_AUTH enforcement story). When omitted, the vault
    // is public — anyone may deposit without a credential, and no domain or credentials are provisioned.
    domain: z
      .object({
        // The ledger caps a domain at 10 accepted credentials.
        acceptedCredentials: z
          .array(AcceptedCredentialSchema)
          .min(1, "a domain needs at least one accepted credential")
          .max(10, "a domain accepts at most 10 credentials"),
      })
      .optional(),

    coverRateMinimum: ScaledRate,
    coverRateLiquidation: ScaledRate,
    managementFeeRate: ScaledRate,

    // First-loss capital seeded into the broker, in whole asset units. Must clear the minimum
    // cover requirement; checked on-ledger after the broker exists.
    coverAmount: z.string().regex(/^\d+(\.\d+)?$/, "coverAmount must be a positive decimal string"),

    // Maximum aggregate debt the broker may originate, in whole asset units.
    debtMaximum: z.string().regex(/^\d+(\.\d+)?$/, "debtMaximum must be a positive decimal string"),

    pool: z.object({
      depositors: z.number().int().min(1),
      borrowers: z.number().int().min(1),
    }),

    // Legacy flat per-account funding amount. Funding is now sized per role from the live reserve rates
    // (see shared/reserves.ts), so this is only a fallback for the fan-out and no longer the primary
    // driver. Kept for config compatibility.
    fundingXrpPerAccount: z.number().int().positive().default(30),

    // Bot-run parameters. Optional: a run without this block uses built-in defaults. The seed makes
    // a bot run reproducible; the weights bias how variants are spread across a pool. Weights are
    // relative and need not sum to one.
    bots: z
      .object({
        seed: z.string().min(1).default("bots"),
        borrowerWeights: z
          .object({
            onTime: z.number().nonnegative().default(1),
            late: z.number().nonnegative().default(0),
            early: z.number().nonnegative().default(0),
            overpay: z.number().nonnegative().default(0),
            default: z.number().nonnegative().default(0),
          })
          .default({}),
        depositorWeights: z
          .object({
            hold: z.number().nonnegative().default(1),
            churn: z.number().nonnegative().default(0),
            topUp: z.number().nonnegative().default(0),
          })
          .default({}),
      })
      .default({}),

    // Default loan terms applied at origination when neither the per-origination request nor the
    // per-session create input supplies a value. The lowest-precedence source; omit the whole block to
    // fall back to the engine's built-in defaults (InterestRate 50000, PaymentInterval 60, GracePeriod
    // 60, term ledger-derived). interestRate is the ledger's scaled integer (100000 = 100%), consistent
    // with the other scaled rates in this schema; interval/grace are seconds, paymentTotal a payment count.
    loanDefaults: z
      .object({
        interestRate: ScaledRate.max(100000, "interestRate must be <= 100000 (100%)").optional(),
        paymentInterval: z.number().int().min(60, "paymentInterval must be >= 60 seconds").optional(),
        gracePeriod: z.number().int().nonnegative("gracePeriod must be >= 0").optional(),
        paymentTotal: z.number().int().positive("paymentTotal must be a positive integer").optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.coverRateLiquidation > cfg.coverRateMinimum) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coverRateLiquidation"],
        message: "coverRateLiquidation cannot exceed coverRateMinimum",
      });
    }
    const ld = cfg.loanDefaults;
    if (ld?.gracePeriod !== undefined && ld.paymentInterval !== undefined && ld.gracePeriod > ld.paymentInterval) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "loanDefaults.gracePeriod cannot exceed loanDefaults.paymentInterval", path: ["loanDefaults", "gracePeriod"] });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
