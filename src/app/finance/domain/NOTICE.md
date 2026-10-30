# Financial domain adaptation for TR8 6B.3

Adapted from [SrEdgarR/PULSO, commit b764bc55d08626c2ca57c131aaf76c0996356972](https://github.com/SrEdgarR/PULSO/tree/b764bc55d08626c2ca57c131aaf76c0996356972/lib/financial-domain).
The source inventory below records the Git blob identities of the reviewed files.
No upstream license was inferred or invented; original authorship and source URLs
are preserved. This directory is a local pure domain, not a backend, bank connection,
repository, or a financial action service.

| Source file                                    | Git blob SHA                               |
| ---------------------------------------------- | ------------------------------------------ |
| `lib/financial-domain/accounts.ts`             | `4d9cac87449d2568eb91cf906cc3ba8dd2f84bf6` |
| `lib/financial-domain/balance-range.ts`        | `872d5a01851b905f0a635c9b53c6ae34049f4703` |
| `lib/financial-domain/balances.ts`             | `391fb4e43a4a464895cb8eabfee6fd2e13f9590e` |
| `lib/financial-domain/catalog.ts`              | `669f6bbaa283cabbe7ab17bd88d59223e009eecc` |
| `lib/financial-domain/connected-operations.ts` | `1d2f34caaccc2965ecccf0bb88942121ccd1e6c8` |
| `lib/financial-domain/money.ts`                | `8016ebbd8861f7b2476010eac069bb3837179735` |
| `lib/financial-domain/operations.ts`           | `f1c6ef5d6767fc1376c46c47ab69bc2bed9ac073` |
| `lib/financial-domain/plan-validation.ts`      | `b16c27f6d46e907bab95c7d785d5775e36c86d1d` |
| `lib/financial-domain/plans.ts`                | `9b155964ffe9e17830b19ad82f9743c2c5a4f8d7` |
| `lib/financial-domain/projection.ts`           | `900d1a48b21de3746ed55468f010b6ba084481da` |
| `lib/financial-domain/types.ts`                | `8fea86b1577f460c329593b04173f5de5a31310d` |
| `lib/financial-domain/validation.ts`           | `c94cc75781e0bfdfe0ae909951fa726dd5d557c5` |
| `lib/financial-domain/workspace-operations.ts` | `d6fc697a94f01dd065648945f69ae7bb98569b2b` |
| `lib/financial-domain/workspace-records.ts`    | `d7f3cb166db65b04ad0548e786231f277af94542` |
| `lib/financial-domain/workspace-types.ts`      | `e54c893b0ed8ecbcaa0ea3b51e537ed9cc0fa984` |
| `lib/financial-domain/workspace-validation.ts` | `e6f4337a642a89dbc02051f57ddce6e42eb44a48` |
| `lib/financial-domain/workspace.ts`            | `8fa2f20ae87ece67852b7e907ce8882a5b413248` |
| `lib/vault/plaintext.ts`                       | `da62f00fd42cd088703613593cfad8aba655e490` |
| `lib/expenses/types.ts`                        | `ae14faa6991d36e5472d322483aa67e793a8b9ec` |
| `lib/expenses/domain.ts`                       | `363b312b22115fcb17db47c4082dd1839c7b7125` |

The 17 financial-domain modules keep the source money, account, ledger, refund,
plan and projection contracts. `categories.ts` contains only the category constants
and corresponding types used from `lib/expenses/types.ts`; `dates.ts` adapts the
source calendar-date validator without instant/timezone conversion.
`snapshot.ts` adapts the closed current/legacy plaintext validation from
`lib/vault/plaintext.ts`. Relative imports and module boundaries target TR8.

TR8 adds the existing bounded JSON clone before domain validation, rejecting
accessors, hidden properties, foreign prototypes, malformed Unicode, sparse
collections, cycles, unsupported numbers, negative zero and payloads above 1 MiB.
Commands and selectors validate the whole snapshot root rather than silently
discarding unknown root fields. Scalar helpers also reject negative zero and
unsafe object descriptors. The generic 6B.2 crypto plaintext remains unchanged.

Current financial snapshots use domain versions 2/3/4/5 with exact versioned
currency definitions; version 4 has plans and version 5 supports explicit
cross-currency card payments. New snapshots use `currency-catalog-v1`
with DOP/USD/EUR/BOB, all with two minor digits, and no global currency or FX rate.
The historical v1 public fixture remains readable only through the explicitly
legacy-capable validator. `upgradeSnapshot` is a local explicit upgrade to v4
(preserving an existing v5),
not a write or automatic data repair: unknown fields or records invalid under
the target invariants are rejected rather than dropped. IDs and integer amounts
are preserved. Adding descriptions/categories for v1 follows the pinned source.

A cross-currency card payment is one ledger operation with the source debit in
`currency`/`amountMinor` and the actual card credit in
`destinationCurrency`/`destinationAmountMinor`. Both amounts are explicit safe
integer minor units. The command promotes to v5 only when this payment or its
plan is saved; opening an older snapshot does not rewrite it. Ordinary transfers
remain single-currency. There is no inferred or externally fetched exchange rate.
Card credits reduce the oldest unpaid statement before the unbilled balance.

Balances use signed safe integer minor units and BigInt arithmetic internally.
Credit debt, liquid money and available capacity remain distinct and separate
by currency. Transfers and card payments do not manufacture income or expense.
Pending plans (including overdue ones) never change the real ledger; projections
include only pending movement dates after today and within the requested horizon.
A confirmed plan and its resulting ledger operation are one immutable snapshot
change. There is no scheduled worker, banking transaction or external side effect.

Projection reuses the normalized operation lists and sweeps their date-ordered
BigInt deltas rather than recalculating and normalizing the whole ledger at every
point. It still emits every source date point and the target date, checks each
closing balance and keeps current/overdue/future semantics. A test-only copy of
the pre-optimization calculator/projection compares an adversarial corpus against
the sweep. This optimization adds no new data cap, approximation or FX conversion.

Tests use only public or freshly constructed synthetic content. This code does
not migrate real Pulso data, enable a production vault, create an Auth account,
change a service plan, or grant team administrators financial access.
