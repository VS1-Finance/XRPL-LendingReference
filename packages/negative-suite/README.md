# @lending/negative-suite

An adversarial negative-test suite for the permissioned lending protocol. Each case drives a
disallowed (or loss-bearing) action against a live environment and asserts the exact engine result
the ledger returns — so a regression that silently changes a rejection code is caught.

The expected codes are the ones observed on-chain, not values guessed from prose. A case passes only
when the ledger reproduces its observed outcome.

## Catalogue

| Case | Action | Expected |
|---|---|---|
| N1 | deposit with no accepted credential | `tecNO_AUTH` |
| N2 | deposit with wrong credential type | `tecNO_AUTH` |
| N3 | deposit with credential from an unrecognized issuer | `tecNO_AUTH` |
| N4 | deposit after credential revoked | `tecNO_AUTH` |
| N5 | share transfer to a non-member | `tecNO_AUTH` |
| N6 | issuer rotation mid-flight | deferred (protocol decision) |
| N7 | delete a vault with an attached broker | `tecHAS_OBLIGATIONS` |
| N8 | clawback against a non-member | `tecNO_AUTH` |
| N9 | withdrawal under loss (correctness) | `tesSUCCESS` |
| N10 | single-signed `LoanSet` | rejected (bad signer) |
| N11 | stranger pays another's loan | `tecNO_PERMISSION` |
| N12 | overpayment with the overpayment flag | `tecNO_PERMISSION` |
| N13 | withdraw broker cover below the floor | `tecINSUFFICIENT_FUNDS` |
| N14 | premature default | `tecTOO_SOON` |
| N15 | delete an active loan | `tecHAS_OBLIGATIONS` |

N9 is a correctness case, not a rejection: under cover-protected loss the withdrawal succeeds. N6 is
reported without being asserted — its intended outcome is a protocol decision, not an observable
code.

## Usage

```sh
negatives run --config ./packages/bootstrap/config.example.json
negatives run --config ./packages/bootstrap/config.example.json --only N1,N7,N14
```

The suite provisions its own environments from the config. Cases that originate a loan each run
against a dedicated environment (a broker holds one loan at a time), so they do not interfere. The
run emits a results record to `out/<setup-id>.negatives.json` and exits non-zero if any asserted case
fails.
