# Customer key and credential hardening assessment V1

Baseline assessment was performed on private Core `main@197803efee5ab2c718c65076d1a9dcb16fe1319f`; addendum below describes the new unmerged DPAPI identity integration proposal. This is not an independent security penetration test.

## Confirmed design and gaps

| Control | Observed source | Assessment |
| --- | --- | --- |
| Installation key generation | `customer-release/bin/generate-installation-identity.mjs` uses Ed25519 and rejects regeneration/partial replacement | Positive against accidental identity rotation |
| Local private-key protection | New code in PR under review uses DPAPI `CurrentUser` envelope (`keys/installation-private.dpapi`) and public-key match on loading | Synthetic Windows CI required; **effective NTFS ACL, legacy PEM migration, Windows profile loss, and actual customer host acceptance NOT VERIFIED**. Existing customer legacy PEM is not removed |
| Token use | `customer-release/bin/activate-customer-agent.mjs` reads `XAUUSD_CUSTOMER_API_TOKEN` from process environment | Better than committed config; ensure process lifetime, rotation, revocation and spill controls |
| Server token verification | `customer-api-gateway-v1` documents hashed bearer tokens, timing-safe comparison and customer binding | Architecture documented; validate credential rotation, expiry and incident response in deployed gateway |
| Server state | SQLite transactional grants, challenges and revocation/migration audit | Define encrypted, access-restricted backups and offline recovery test |
| New PC / loss of key | Explicit revoke + create fresh installation identity + new license/grant | Preserves identity isolation; do not transfer the old private key |
| Signing key | Copy signer private keys must stay server-side | Audit actual deployment secret-store/rotation and key-ID trust overlap separately |

## Gate for customer distribution (no automatic migration in this PR)

1. Verify Windows DPAPI CurrentUser identity generator/activation integration on exact PR head and accepted main, including current-user round-trip and public/private identity match. **Legacy PEM still requires a separately approved migration; no automatic deletion**.
2. Verify NTFS ACL against the actual customer account, other local users, SYSTEM, administrators and backup context; prevent inherited overly broad access. Record masked evidence; never print or upload private keys.
3. Add crash-consistent encrypted key migration with rollback, non-exportable handling where supported, and fail-closed startup on corruption. Prevent silent key recreation. Test with temporary fake identities on a separate Windows runner.
4. Define server-side bearer-token issue/revoke/rotation/expiry and one-time incident response. Avoid tokens in arguments, JSON, verbose logs, GitHub Issues or action artifacts.
5. Back up encrypted license/grant/audit state with access controls and retention; restore into an isolated environment and prove old revoked grants remain revoked and replay stays denied.
6. Keep Master signing keys outside both public and private Git repositories and customer artifacts; inventory signer key IDs and deliberate trust-overlap rotation.
7. Separate security CI from live deployment; no production credential rotation without explicit operator change window and recovery authorization.

**Acceptance for this assessment:** findings documented. Existing Windows DPAPI primitive passed synthetic CI before this proposal, but integration remains unaccepted until the new PR's CI is green. No assertion that host ACL audit, legacy migration, token rotation or restore drill have passed. Those are follow-up implementation and host-level verification gates.

Safety: no BOT_MODE, ARM, MT5, orders, positions, or production secret mutation.
