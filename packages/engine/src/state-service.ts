import { dropsToXrpString, ledgerTimeSeconds, scaledToDecimal } from "@lending/shared";
import { isPermissioned } from "@lending/bootstrap";
import type { Session } from "@lending/session";

// Decimal places the vault-asset MPT issuance is created at. Mirrors MPT_ASSET_SCALE in
// bootstrap/steps.ts — kept here too since state is read directly off the ledger as raw integers and
// needs the same scale to render a whole-token display string.
const MPT_ASSET_SCALE = 2;

// The current state of a session, read live from the validated ledger. This is what the front end
// polls to watch a session evolve as humans and bots act — the vault's assets and shares, the
// broker's cover, the loans and their status, and the seat map with who holds each.
export interface SessionState {
  setupId: string;
  vault: { assetsTotal: string; assetsAvailable: string; shareMptId?: string; sharesTotal?: string; lossUnrealized?: string; scale?: number } | null;
  broker: { coverAvailable: string; debtTotal?: string; debtMaximum?: string; managementFeeRate?: number; coverRateMinimum?: number; coverRateLiquidation?: number } | null;
  // Per loan: its balances and status, plus whether it can be defaulted right now and, if not yet,
  // how many seconds until it can be (past its next payment due date plus grace period).
  loans: {
    loanId: string;
    borrower: string;
    principalOutstanding: string;
    totalOutstanding: string;
    paymentRemaining: number;
    defaulted: boolean;
    defaultableNow: boolean;
    defaultableInSeconds: number | null;
  }[];
  seats: { key: string; occupant: string; participant?: string }[];
  // Credential status per participant account, so the UI can tell who still needs to accept a
  // credential: "accepted" is active, "pending" was issued but not accepted, "none" has no credential.
  credentials: { address: string; status: "accepted" | "pending" | "none" }[];
}

const LSF_LOAN_DEFAULTED = 0x00010000;
const LSF_CREDENTIAL_ACCEPTED = 0x00010000;

export async function readSessionState(session: Session): Promise<SessionState> {
  // Whether the session asset is native XRP, so on-ledger drops amounts can be shown as whole XRP.
  const isXrp = session.env.asset.currency === "XRP" && !session.env.asset.issuer;
  // Whether the session asset is MPT, so on-ledger raw integer amounts (at MPT_ASSET_SCALE) can be
  // shown as whole tokens.
  const isMpt = session.env.asset.currency === "MPT";
  // An asset-denominated ledger amount as a whole-token string. XRP fields come off the ledger in
  // drops and are divided down to whole XRP; MPT fields come off the ledger as raw integers at
  // MPT_ASSET_SCALE and are divided down by that scale; issued amounts are already in token units.
  // This keeps the state the front end renders consistent across every asset kind.
  const assetValue = (v: unknown): string =>
    isXrp ? dropsToXrpString(readAmount(v)) : isMpt ? scaledToDecimal(BigInt(readAmount(v)), MPT_ASSET_SCALE) : readAmount(v);

  const owner = session.env.accounts.owner.address;
  const vault = await firstObject(session, owner, "vault");
  const broker = await firstObject(session, owner, "loan_broker");
  // Total shares in issue lives on the share MPT issuance, not the vault — one extra read.
  const sharesTotal = await shareOutstanding(session, session.env.objects.shareMptId);

  const loans = [];
  // "Now" is the ledger's last-validated close time, the same clock the loan-default bots use, so the
  // UI's "defaultable in Xs" countdown agrees with what the ledger enforces. Read once for the whole
  // projection so every loan is measured against one consistent time.
  const now = await ledgerTimeSeconds(session.client);
  for (const b of session.env.accounts.borrowers) {
    const res = await session.client.request({ command: "account_objects", account: b.address, type: "loan", ledger_index: "validated" });
    for (const loan of res.result.account_objects as unknown as Record<string, unknown>[]) {
      const defaulted = (Number(loan.Flags ?? 0) & LSF_LOAN_DEFAULTED) !== 0;
      const paymentRemaining = Number(loan.PaymentRemaining ?? 0);
      // A loan may be defaulted only once its next payment is overdue past the grace period. Compute
      // whether that moment has passed, and if not, how long until it does.
      const defaultableAt = Number(loan.NextPaymentDueDate ?? 0) + Number(loan.GracePeriod ?? 0);
      const secondsUntil = defaultableAt - now;
      const defaultableNow = !defaulted && paymentRemaining > 0 && defaultableAt > 0 && secondsUntil <= 0;
      loans.push({
        loanId: String(loan.index),
        borrower: b.address,
        principalOutstanding: assetValue(loan.PrincipalOutstanding),
        totalOutstanding: assetValue(loan.TotalValueOutstanding),
        paymentRemaining,
        defaulted,
        defaultableNow,
        defaultableInSeconds: defaultableNow || defaulted || paymentRemaining <= 0 ? null : Math.max(0, secondsUntil),
      });
    }
  }

  // Credential status for each participant that receives one — the depositors and borrowers. The
  // issuer and owner are provisioned separately and are not domain subjects. A public (non-permissioned)
  // vault has no credentials at all, so the list is empty and no per-account lookup is needed.
  // Credentials are issued by the credential issuer (present only for a permissioned session), so
  // membership is judged against that account, not the currency issuer.
  const credentialIssuer = session.env.accounts.credentialIssuer?.address;
  const credentials: SessionState["credentials"] = [];
  const subjects = isPermissioned(session.env) && credentialIssuer ? [...session.env.accounts.depositors, ...session.env.accounts.borrowers] : [];
  for (const acct of subjects) {
    const res = await session.client.request({ command: "account_objects", account: acct.address, type: "credential", ledger_index: "validated" });
    const creds = res.result.account_objects as unknown as Record<string, unknown>[];
    const mine = creds.find((c) => c.Issuer === credentialIssuer && c.Subject === acct.address);
    const status: "accepted" | "pending" | "none" = !mine
      ? "none"
      : (Number(mine.Flags ?? 0) & LSF_CREDENTIAL_ACCEPTED) !== 0
        ? "accepted"
        : "pending";
    credentials.push({ address: acct.address, status });
  }

  return {
    setupId: session.setupId,
    vault: vault
      ? {
          assetsTotal: assetValue(vault.AssetsTotal),
          assetsAvailable: assetValue(vault.AssetsAvailable),
          ...(session.env.objects.shareMptId ? { shareMptId: session.env.objects.shareMptId } : {}),
          sharesTotal,
          lossUnrealized: assetValue(vault.LossUnrealized),
          scale: Number(vault.Scale ?? 0),
        }
      : null,
    broker: broker
      ? {
          coverAvailable: assetValue(broker.CoverAvailable),
          debtTotal: assetValue(broker.DebtTotal),
          debtMaximum: assetValue(broker.DebtMaximum),
          managementFeeRate: Number(broker.ManagementFeeRate ?? 0),
          coverRateMinimum: Number(broker.CoverRateMinimum ?? 0),
          coverRateLiquidation: Number(broker.CoverRateLiquidation ?? 0),
        }
      : null,
    loans,
    seats: [...session.seats.values()].map((s) => ({
      key: `${s.role}:${s.index}`,
      occupant: s.occupant.kind,
      ...(s.occupant.kind === "human" ? { participant: s.occupant.id } : {}),
    })),
    credentials,
  };
}

async function firstObject(session: Session, account: string, type: "vault" | "loan_broker"): Promise<Record<string, unknown> | undefined> {
  const res = await session.client.request({ command: "account_objects", account, type, ledger_index: "validated" });
  return (res.result.account_objects as unknown as Record<string, unknown>[])[0];
}

// Total vault shares in issue, read from the share MPT issuance (the vault object does not carry a
// share total). Shares are raw integer base units on the issuance. Missing/failed reads are "0".
async function shareOutstanding(session: Session, shareMptId: string | undefined): Promise<string> {
  if (!shareMptId) return "0";
  try {
    const res = await session.client.request({ command: "ledger_entry", mpt_issuance: shareMptId, ledger_index: "validated" });
    const node = res.result.node as unknown as Record<string, unknown> | undefined;
    return String(node?.OutstandingAmount ?? "0");
  } catch {
    return "0";
  }
}

function readAmount(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) return String((value as { value: unknown }).value);
  return "0";
}
