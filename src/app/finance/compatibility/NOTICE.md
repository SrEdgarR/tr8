# Pulso compatibility prototype

Protocol and AAD adapted from [SrEdgarR/PULSO](https://github.com/SrEdgarR/PULSO)
at commit [b764bc55d08626c2ca57c131aaf76c0996356972](https://github.com/SrEdgarR/PULSO/commit/b764bc55d08626c2ca57c131aaf76c0996356972):
`lib/vault/{constants,types,errors,encoding,strict-json,envelope,opaque-contract,aad}.ts`.
Imports are consolidated into local modules; the financial plaintext types are
outside this compatibility cut. The `pulso-` identifiers and ordered AAD tuples
are preserved because they authenticate the original format.

The fixture is the upstream `tests/fixtures/vault-vectors.json`, Git blob
`fb2bbea678180f6f4d6d70f5662341649a03af25`. It is explicitly public,
synthetic test material, including its test passwords and keys. The upstream
generator `tests/fixtures/generate-vault-vectors.mjs` describes independent
Node 24.14/OpenSSL generation; TR8 does not run that generator or claim its
historical test results.

This cut checks structure, positional AAD, CAS/epoch transitions and the public
AES-GCM/HKDF vector with Web Crypto. It does **not** implement or validate an
Argon2 WASM adapter, private-password handling, backup import, browser lifecycle
locking, production identity/session authority or durable storage. There is no
financial route, database migration, enabled vault or real financial material.
It is not a cryptographic audit.

No upstream license text was found at `LICENSE` in the pinned commit. This
notice records provenance and makes no claim of a third-party license grant.
