import type { Session } from "@lending/session";

// The current state of a session, read live from the validated ledger. This is what the front end
// polls to watch a session evolve as humans and bots act — the vault's assets and shares, the
// broker's cover, the loans and their status, and the seat map with who holds each.
export interface SessionState {
  setupId: string;
  vault: { assetsTotal: string; assetsAvailable: string; shareMptId?: string } | null;
  broker: { coverAvailable: string } | null;
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

// The XRP Ledger epoch (2000-01-01) that ledger time fields are measured from.
const RIPPLE_EPOCH = 946684800;
const nowRipple = (): number => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;

export async function readSessionState(session: Session): Promise<SessionState> {
  const owner = session.env.accounts.owner.address;
  const vault = await firstObject(session, owner, "vault");
  const broker = await firstObject(session, owner, "loan_broker");

  const loans = [];
  for (const b of session.env.accounts.borrowers) {
    const res = await session.client.request({ command: "account_objects", account: b.address, type: "loan", ledger_index: "validated" });
    for (const loan of res.result.account_objects as unknown as Record<string, unknown>[]) {
      const defaulted = (Number(loan.Flags ?? 0) & LSF_LOAN_DEFAULTED) !== 0;
      const paymentRemaining = Number(loan.PaymentRemaining ?? 0);
      // A loan may be defaulted only once its next payment is overdue past the grace period. Compute
      // whether that moment has passed, and if not, how long until it does.
      const defaultableAt = Number(loan.NextPaymentDueDate ?? 0) + Number(loan.GracePeriod ?? 0);
      const secondsUntil = defaultableAt - nowRipple();
      const defaultableNow = !defaulted && paymentRemaining > 0 && defaultableAt > 0 && secondsUntil <= 0;
      loans.push({
        loanId: String(loan.index),
        borrower: b.address,
        principalOutstanding: readAmount(loan.PrincipalOutstanding),
        totalOutstanding: readAmount(loan.TotalValueOutstanding),
        paymentRemaining,
        defaulted,
        defaultableNow,
        defaultableInSeconds: defaultableNow || defaulted || paymentRemaining <= 0 ? null : Math.max(0, secondsUntil),
      });
    }
  }

  // Credential status for each participant that receives one — the depositors and borrowers. The
  // issuer and owner are provisioned separately and are not domain subjects.
  const issuer = session.env.accounts.issuer.address;
  const credentials: SessionState["credentials"] = [];
  for (const acct of [...session.env.accounts.depositors, ...session.env.accounts.borrowers]) {
    const res = await session.client.request({ command: "account_objects", account: acct.address, type: "credential", ledger_index: "validated" });
    const creds = res.result.account_objects as unknown as Record<string, unknown>[];
    const mine = creds.find((c) => c.Issuer === issuer && c.Subject === acct.address);
    const status: "accepted" | "pending" | "none" = !mine
      ? "none"
      : (Number(mine.Flags ?? 0) & LSF_CREDENTIAL_ACCEPTED) !== 0
        ? "accepted"
        : "pending";
    credentials.push({ address: acct.address, status });
  }

  return {
    setupId: session.setupId,
    vault: vault ? { assetsTotal: readAmount(vault.AssetsTotal), assetsAvailable: readAmount(vault.AssetsAvailable), ...(session.env.objects.shareMptId ? { shareMptId: session.env.objects.shareMptId } : {}) } : null,
    broker: broker ? { coverAvailable: readAmount(broker.CoverAvailable) } : null,
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

function readAmount(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) return String((value as { value: unknown }).value);
  return "0";
}
