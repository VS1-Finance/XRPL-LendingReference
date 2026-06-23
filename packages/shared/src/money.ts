// Money is handled as integers, never floats. XRP is counted in drops (1 XRP = 1,000,000 drops);
// issued amounts are kept as decimal strings and scaled to integer base units for arithmetic.

const DROPS_PER_XRP = 1_000_000n;

export function xrpToDropsBig(xrp: number | string): bigint {
  return decimalToScaled(String(xrp), 6);
}

export function dropsToXrpString(drops: bigint | string): string {
  return scaledToDecimal(BigInt(drops), 6);
}

// Parse a non-negative decimal string into an integer scaled by 10^decimals. Rejects anything
// that is not a clean decimal, and rejects more fractional digits than the scale allows rather
// than silently truncating value.
export function decimalToScaled(value: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`not a non-negative decimal: ${value}`);
  const whole = match[1] ?? "0";
  const frac = match[2] ?? "";
  if (frac.length > decimals) {
    throw new Error(`value ${value} has more than ${decimals} fractional digits`);
  }
  const padded = frac.padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

// Render a scaled integer back to a decimal string with no trailing-zero noise.
export function scaledToDecimal(scaled: bigint, decimals: number): string {
  const sign = scaled < 0n ? "-" : "";
  const abs = scaled < 0n ? -scaled : scaled;
  const factor = 10n ** BigInt(decimals);
  const whole = abs / factor;
  const frac = (abs % factor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

// Issued amounts on the XRP Ledger carry at most 15 significant digits. A value with more
// precision than that is rejected by the ledger, so amounts read from on-ledger objects must be
// reduced to 15 significant digits before they are used in a payment. Rounding is done upward so
// a derived repayment never falls a sub-unit short of what is owed.
const MAX_SIGNIFICANT_DIGITS = 15;

export function clampIssuedValueUp(value: string): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`not a non-negative decimal: ${value}`);
  const digits = (match[1] ?? "") + (match[2] ?? "");
  const significant = digits.replace(/^0+/, "");
  if (significant.length <= MAX_SIGNIFICANT_DIGITS) return value.trim();

  const dropCount = significant.length - MAX_SIGNIFICANT_DIGITS;
  const fracLen = (match[2] ?? "").length;
  const scaled = decimalToScaledArbitrary(value.trim(), fracLen);
  const factor = 10n ** BigInt(dropCount);
  const roundedUp = (scaled + factor - 1n) / factor * factor;
  return scaledToDecimal(roundedUp, fracLen);
}

function decimalToScaledArbitrary(value: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  const whole = match?.[1] ?? "0";
  const frac = (match?.[2] ?? "").padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac || "0");
}
