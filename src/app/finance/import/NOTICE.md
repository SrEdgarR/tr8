# Encrypted backup adaptation

Adapted from `lib/vault/backup-format.ts` and `lib/vault/backup.ts` in
[SrEdgarR/PULSO at b764bc55d08626c2ca57c131aaf76c0996356972](https://github.com/SrEdgarR/PULSO/tree/b764bc55d08626c2ca57c131aaf76c0996356972/lib/vault).

The v1 closed wrapper remains `pulso-encrypted-backup`, with the original
export-format version and authenticated envelope. Offline opening uses the
original encrypted owner and vault context, followed by strict financial-domain
validation. It does not infer identity from email or edit authenticated context.

These helpers are intended for a Worker-owned import session. Only bounded
summary metadata is returned by the separate `preview.ts` module. The old key is
not returned by `openEncryptedBackup`; opened plaintext stays in Worker memory.
There are no storage or network calls. JavaScript key-reference disposal is best
effort and is not a zeroization guarantee.

The source prototype's `confirmed` and `identityReauthenticated` booleans are not
ported as authorization. The trusted controller must obtain the destination head
and current identity, bind explicit acceptance to its preview ID, require full
custody, and use a durable expected-revision-zero receipt before activating an
import. A caller-provided null does not establish those facts.

The explicit import acceptance upgrades a strictly validated legacy snapshot to
the supported current domain, retaining internal financial IDs. It creates new
VDK, wraps, context and initial epochs. Same-context restore copies validated
data only, encrypting against the live key and live header; it is not a context
reset or proof that retired contexts may be revived.

No real Pulso data, credentials, snapshots or accounts are included here. Test
credentials and the compatibility vector are public synthetic fixtures only.
