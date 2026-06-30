# @lending/session

Turns a provisioned lending environment into a **session** whose roles are **seats**. Bots fill
every seat no human holds; a participant claims a seat to act as that role. Several participants can
hold different seats in the same session at once.

## Concepts

- **Session** — a provisioned environment (one vault, broker, domain, and pooled accounts),
  identified by its setup id.
- **Seat** — one role slot (`issuer`, `owner`, `depositor:N`, `borrower:N`), bound to a single
  on-chain account. A seat is `open`, `bot`-filled, or held by a `human`. Occupancy is exclusive, so
  the account is only ever driven by one party.
- **Signer** — how a seat's account acts. Today a seat signs with its derived key server-side; the
  same seat surface would carry an external-wallet signer without changing callers.
- **Bots** — per-role behavioral variants. A scheduler visits the bot-held seats each round and runs
  their variant; seats a human holds are skipped, so claiming a seat stands its bot down and
  releasing it lets the bot resume.

## Usage

```sh
# create a session (provisions a fresh environment; all seats start bot-filled)
session create --config ./packages/bootstrap/config.example.json

# list sessions found on disk
session list

# claim a seat as a participant
session join --setup-id <id> --seat borrower:0 --as alice --seed <seed>

# drive the bots (the seat alice holds is left alone)
session run-bots --setup-id <id> --seed <seed> --rounds 5

# drive a mixed pool: some depositors hold, some churn; borrowers span on-time, late,
# overpaying and defaulting, spread across the seats automatically
session run-bots --setup-id <id> --seed <seed> --profile adversarial --rounds 5

# hand the seat back; a bot fills it again
session release --setup-id <id> --seat borrower:0 --as alice --seed <seed>
```

Seat occupancy is session metadata (not on-chain) and is persisted next to the environment graph, so
the bot runner and joining participants agree on who holds which seat across separate invocations.
