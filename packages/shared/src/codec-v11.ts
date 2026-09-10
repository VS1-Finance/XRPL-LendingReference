import { createRequire } from "node:module";
import path from "node:path";
import { XrplDefinitions, DEFAULT_DEFINITIONS } from "ripple-binary-codec";

// The three fields LendingProtocolV1_1 adds, with their exact protocol codes (rippled sfields.macro,
// verified): VaultKind UInt8/22, SubscriptionDate UInt32/75, RedemptionDate UInt32/76. Our pinned codec
// (2.9.0-batch.1) predates V1_1 and lacks them, so xrpl's Wallet.sign() cannot serialize a VaultCreate
// that carries them. This registers them on the live DEFAULT_DEFINITIONS singleton — the same instance
// xrpl's signing path uses (verified identical) — so signing picks them up at runtime.
const V11_FIELDS = [
  ["VaultKind",        { nth: 22, isVLEncoded: false, isSerialized: true, isSigningField: true, type: "UInt8" }],
  ["SubscriptionDate", { nth: 75, isVLEncoded: false, isSerialized: true, isSigningField: true, type: "UInt32" }],
  ["RedemptionDate",   { nth: 76, isVLEncoded: false, isSerialized: true, isSigningField: true, type: "UInt32" }],
] as const;

let registered = false;

export function registerLendingV11Fields(): void {
  if (registered) return;
  const field = (DEFAULT_DEFINITIONS as unknown as { field: Record<string, unknown> }).field;
  if (V11_FIELDS.every(([name]) => field[name as string] !== undefined)) { registered = true; return; }

  // The codec's definitions.json is not a package-export subpath, so resolve the codec's package dir
  // from its main entry and read the JSON beside it. createRequire gives a CJS require in this ESM module.
  const require = createRequire(import.meta.url);
  const codecMain = require.resolve("ripple-binary-codec"); // .../dist/index.js
  const defs = require(path.join(path.dirname(codecMain), "enums", "definitions.json")) as { FIELDS: unknown[] };

  const merged = { ...defs, FIELDS: [...defs.FIELDS, ...V11_FIELDS.map(([n, m]) => [n, m])] };
  const rebuilt = new XrplDefinitions(merged as never);
  for (const [name] of V11_FIELDS) {
    const entry = (rebuilt as unknown as { field: Record<string, { ordinal: number } | undefined> }).field[name as string];
    if (!entry) throw new Error(`registerLendingV11Fields: rebuilt definitions missing field "${name}"`);
    // CRITICAL: FieldLookup indexes every field under BOTH its name AND its ordinal-string
    // (ripple-binary-codec field.js: `this[name] = ...; this[ordinal.toString()] = this[name]`). ENCODE
    // resolves by name, but DECODE resolves by ordinal (binary-parser.js: `field.fromString(ordinal)`).
    // Wallet.sign() decodes its own output to compute the signing hash, so registering the name key ALONE
    // makes sign() throw on decode. Both keys are required.
    field[name as string] = entry;
    field[entry.ordinal.toString()] = entry;
  }
  registered = true;
}
