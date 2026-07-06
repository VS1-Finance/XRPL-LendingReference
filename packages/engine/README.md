# @lending/engine

An HTTP service over the lending session engine. It provisions sessions, lets participants claim and
release role seats, dispatches per-role actions to the ledger under a seat's identity, drives the bot
pools that fill unheld seats, and reports each session's live on-chain state. A front end talks to
this service; it never touches the ledger directly.

## Running it

```sh
ENGINE_CONFIG=./packages/bootstrap/config.example.json PORT=4000 pnpm engine
```

The base configuration is the template every session is provisioned from; each session gets a unique
setup id and derivation seed so sessions never collide on-chain.

## API

| Method + path | Purpose |
|---|---|
| `GET /health` | liveness |
| `POST /sessions` | provision a session (body: `{ label? }`) |
| `GET /sessions` | list sessions with their seat maps |
| `GET /sessions/:id` | one session's seats and occupancy |
| `GET /sessions/:id/state` | live on-chain state: vault, broker, loans, seats |
| `POST /sessions/:id/seats/:seat/claim` | claim a seat (body: `{ participant }`) |
| `POST /sessions/:id/seats/:seat/release` | release a seat (body: `{ participant }`) |
| `POST /sessions/:id/actions` | act as a seat (body: `{ participant, seat, action, params }`) |
| `POST /sessions/:id/bots/start` | start the bot pool (body: `{ intervalSeconds? }`) |
| `POST /sessions/:id/bots/stop` | stop the bot pool |

### Actions

An action is submitted under the identity of the seat that owns it; the seat must be held by the
requesting participant.

| Action | Seat | Params |
|---|---|---|
| `deposit` | depositor | `amount` |
| `withdraw` | depositor | `amount` |
| `originate` | owner | `borrower`, `principal`, `interestRate?`, `interval?`, `grace?` |
| `repay` | borrower | `loanId`, `amount` |
| `issue-credential` | issuer | `subject`, `credentialType?` |
| `revoke-credential` | issuer | `subject`, `credentialType?` |
| `set-vault` | owner | `assetsMaximum?` |
| `set-domain` | owner | `issuer?`, `credentialType?` |

Origination is bilateral: the owner signs and the borrower counter-signs the same `LoanSet`.

## Seats and bots

Each role is a seat bound to one account. A seat is open, bot-filled, or held by a participant, with
exclusive occupancy. The bot scheduler drives every seat no human holds and skips a seat a human
claims, so a participant and the bot pool coexist. The scheduler runs in the engine process and is
stopped when the server shuts down.
