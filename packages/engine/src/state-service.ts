import type { Session } from "@lending/session";

// The current state of a session, read live from the validated ledger. This is what the front end
// polls to watch a session evolve as humans and bots act — the vault's assets and shares, the
// broker's cover, the loans and their status, and the seat map with who holds each.
export interface SessionState {
  setupId: string;
  vault: { assetsTotal: string; assetsAvailable: string; shareMptId?: string } | null;
  broker: { coverAvailable: string } | null;
  loans: { loanId: string; borrower: string; principalOutstanding: string; totalOutstanding: string; paymentRemaining: number; defaulted: boolean }[];
  seats: { key: string; occupant: string; participant?: string }[];
}

const LSF_LOAN_DEFAULTED = 0x00010000;

export async function readSessionState(session: Session): Promise<SessionState> {
  const owner = session.env.accounts.owner.address;
  const vault = await firstObject(session, owner, "vault");
  const broker = await firstObject(session, owner, "loan_broker");

  const loans = [];
  for (const b of session.env.accounts.borrowers) {
    const res = await session.client.request({ command: "account_objects", account: b.address, type: "loan", ledger_index: "validated" });
    for (const loan of res.result.account_objects as unknown as Record<string, unknown>[]) {
      loans.push({
        loanId: String(loan.index),
        borrower: b.address,
        principalOutstanding: readAmount(loan.PrincipalOutstanding),
        totalOutstanding: readAmount(loan.TotalValueOutstanding),
        paymentRemaining: Number(loan.PaymentRemaining ?? 0),
        defaulted: (Number(loan.Flags ?? 0) & LSF_LOAN_DEFAULTED) !== 0,
      });
    }
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
