# Customer Revoke / New-PC Migration / Recovery V1

## Goal

Provide a transactional server-side path to revoke an old customer installation and provision a replacement installation while preserving auditability and fail-closed behavior.

## Transaction

A migration atomically:

1. validates the current old grant/license binding;
2. validates the replacement license and grant;
3. revokes the old license;
4. revokes the old grant with revision increment;
5. invalidates outstanding challenges for the old installation;
6. inserts the replacement license;
7. inserts the replacement grant;
8. writes an INSTALLATION_MIGRATED audit record.

Any persistence failure rolls the transaction back.

## Old-machine behavior

After migration:

- old AUTO exposure is denied;
- old outstanding challenges cannot be consumed;
- old grant/license remain persisted as REVOKED for audit;
- no old source record is silently deleted.

## New-machine behavior

The replacement installation receives a new license ID, grant ID, installation ID, and installation key pair.

After service restart, the new machine can authenticate and activate through the same Gateway/Agent flow.

## Audit

Audit records contain:

- customer ID;
- old/new license IDs;
- old/new grant IDs;
- old/new installation IDs;
- migration time;
- server-side authorizedBy identity.

## Safety

No MT5 mutation.
No ARM mutation.
No Master BOT_MODE mutation.
No order/position mutation.
No LIVE test order.
