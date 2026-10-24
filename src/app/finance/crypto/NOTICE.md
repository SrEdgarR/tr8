# Pulso v1 crypto adaptation

Adapted from [SrEdgarR/PULSO at
b764bc55d08626c2ca57c131aaf76c0996356972](https://github.com/SrEdgarR/PULSO/tree/b764bc55d08626c2ca57c131aaf76c0996356972/lib/vault):
`native-crypto.ts`, `argon2.ts`, `password.ts`, `recovery.ts`, `credentials.ts`,
`payload.ts` and `rotations.ts`. Relative imports use the TR8 6A protocol; its
suite names, AAD tuples and epoch semantics are preserved.

The password is normalized with NFC, without trimming or case folding. It must
contain at least 16 Unicode code points after NFC and at most 1024 UTF-8 bytes.
Ill-formed UTF-16 is rejected before normalization. Canonically equivalent NFC
passwords derive the same key, as in the pinned source.

The only KDF is the pinned local ESM `libsodium-wrappers-sumo` 0.8.4 plus
`libsodium-sumo` 0.8.4: Argon2id v1.3, 64 MiB, three passes, one lane and 32-byte
output with a 16-byte salt. The ESM package is WASM-only; do not replace it with
the CJS build, which has a different loading/fallback path. There is no reduced
profile, remote CDN, weak cipher, alternate KDF or plaintext local mode.

`plaintext.ts` only validates the bounded JSON transport shape
`{schemaVersion:1,financialSpace:{...}}`. It does not validate financial accounts,
currencies, balances or operations. That domain is a separate delivery.

Raw VDKs and private buffers are short-lived owned copies, wiped best effort.
Operational Web Crypto keys are non-extractable. JavaScript strings, garbage
collection and compromised code/device memory cannot be reliably zeroized.
These functions provide no storage or HTTP access. Worker lifecycle, recovery
read-only mode, full custody confirmation and confirmed backend receipts must
be enforced by their caller before activating writes.

The public synthetic vector and upstream provenance remain in
[`../compatibility/NOTICE.md`](../compatibility/NOTICE.md). No production financial
material is part of these tests and this adaptation is not a cryptographic audit.
