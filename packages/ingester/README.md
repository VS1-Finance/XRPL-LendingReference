# @lending/ingester

The off-chain history store for a provisioned lending environment. A ledger reset wipes the chain,
so this store is the durable source of truth for what happened — it captures every relevant
transaction into Postgres, normalizes it into typed events, and projects the current derived state.

## What it does

- **Subscribes** to the ledger transaction stream filtered to a setup's accounts, and backfills the
  gap since the last captured ledger from account history.
- **Captures** each transaction idempotently keyed on its tx hash, writing the transaction row and
  an outbox marker in one database transaction (at-least-once, no double-count on replay).
- **Normalizes** each transaction into a typed event (deposit, origination, payment, cover
  operation, credential operation, …), carrying the setup and correlation ids stamped in the
  transaction's memos.
- **Projects** the current vault, loan, broker, and credential state per setup, in integer base
  units, so the derived "what is true now" matches the chain.

The schema carries `networkId`, `ledgerIndex`, and a `resetEpoch` column on every table so the
history remains attributable across a network reset.

## Requirements

- Postgres (connection via `DATABASE_URL`)
- Node ≥ 22, pnpm 10

## Setup

```sh
cp .env.example .env          # point DATABASE_URL at your Postgres
pnpm --filter @lending/ingester prisma:migrate
```

## Usage

```sh
# capture a run's history (backfill, then follow the live stream)
pnpm ingester start --provisioned ./out/<setup-id>.json

# backfill once and exit
pnpm ingester start --provisioned ./out/<setup-id>.json --once

# list a run's actions in order
pnpm ingester query --setup-id <id>

# show current derived state
pnpm ingester query --setup-id <id> --state
```

## Restart safety

Each setup has an ingestion cursor recording the last ledger index fully persisted. On restart the
subscriber resumes from there, and because capture is idempotent on tx hash, any transaction seen
again is a no-op — so a restart produces no gaps and no duplicates.
