# P0 #176 — Migration Replay / Challenge / Audit Rollback Witness

**Status: SYNTHETIC TEST ONLY — RESTORE SECURITY NOT IMPLEMENTED OR ACCEPTED.**

This supplements [customer-sqlite-restore-anti-rollback-design.md](./customer-sqlite-restore-anti-rollback-design.md).
The test `packages/customer-runtime-session/src/sqlite-restore-migration-rollback.test.ts`
uses only disposable files in an OS temp directory and fake identities. It does not
start a Gateway, connect to MT5, or modify real customer/production state.

## Demonstrated sequence

1. Create a fake old license/grant and an unconsumed challenge in SQLite.
2. **Close** the SQLite connection and copy the old database into a disposable
   file. This is NOT an online/WAL-safe backup recipe.
3. On the original file, complete a properly authorized synthetic installation
   migration. Verify the old license/grant become `REVOKED`, the challenge is
   invalidated, the new binding is present and exactly one audit is committed.
4. Reopen the *old file copy*. It still exposes the formerly active license/grant,
   permits the pre-migration challenge once and lacks the audit/new binding.
5. Reopen the current file. It still rejects the challenge and retains the
   revocation and migration audit.

A green test **confirms the vulnerability witness**, not mitigation or
customer release readiness. SQLite local transaction protections cannot
distinguish a stale physical snapshot from the latest trusted security state.

## Required future fail-closed gates (NOT implemented here)

| Threat | Required trusted independent evidence | Missing-evidence decision |
| --- | --- | --- |
| Revoked license/grant resurrected by old backup | Non-rollbackable authenticated revocation generation and binding identity | BLOCKED |
| Consumed/invalidated challenge replay | Durable challenge consumption / invalidation watermark outside restored DB | BLOCKED |
| Migration audit silently disappears | Independently authenticated monotonic audit chain/high-water mark | BLOCKED |
| Token reissue/expiry/revocation rolled back | Independently approved persisted token lifecycle and revocation state | BLOCKED |
| Backup taken with active SQLite WAL | Consistent snapshot procedure, encrypted archive and verified key recovery | BLOCKED |
| Tampered authority or unavailable trust root | Operator-approved trusted authority, verified key material and replay checks | BLOCKED |

A digital signature bundled **inside the same old archive** does not protect
against replay of that archive. Verify independent authority before opening a
customer Gateway or activating any session. No automatic reissuance of revoked
identities. Real recovery needs explicit operator authorization, host security
review, detached signed evidence, fail-closed rollback and separate customer
pilot acceptance.

## Checks / boundaries

- Run the existing `@xauusd/customer-runtime-session` Vitest and typecheck
  workflows on the exact PR head and after any eventual merge.
- The witness does not include a WAL-consistent live snapshot test; that
  separate gate remains open in [#176](../../issues/176).
- Do not mark #176 or parent release blocker [#166](../../issues/166) closed.
- Do not change BOT_MODE, ARM, MT5 orders, customer DBs, keys, tokens, runner
  services, production startup or distribution state.
