# Clean distribution repository migration

Status: public distribution validated; private core acceptance pending.

- Replacement: `thiennguyen3004931-sudo/xauusd-ai-master`, repository ID `1432234586`; owner changed visibility to public.
- Validated public main: `bdf6dd163afed23d3e5d2079ab5fc94132b2c0bd`.
- Original sanitized import: `06dc6901874839bbaba58fc37e51790c3d366c59`, tree `c0be424f1ea023129e8c095ca75b11813c077b5c`.
- History: root README, sanitized import, then remediation-ledger correction. Legacy ancestry was not imported.
- 54 allowlisted files. All three governed package tree hashes remain unchanged.
- Core and `xauusd-ai-master-legacy-private` remain private.

## Validation

Initial Actions jobs were blocked before execution by account billing/spending limits (owner-supplied annotation). After the owner made the distribution public, retries executed successfully for Copy Protocol, License Service, Installation Proof and Public Distribution on the original sanitized import.

The full-history redacted Gitleaks scan reported no leaks. Boundary validation correctly rejected 11 obsolete ledger entries from legacy commits absent from the new repository. The corrective public commit empties that ledger; scanner settings and strict remediation validation are unchanged. Nine remediation validator unit tests passed locally.

On the corrected public commit:
- Public Distribution CI: PASS, run 40101165387.
- Public Private Repository Boundary CI: PASS, run 40101165440, including Linux and Windows workspace tests/build/typecheck and full-history secret scanning.
- Remote package tree SHA verification: PASS for all three packages.

## Remaining core gates

PR #152 pins the corrected public commit. Private Master Core and Canonical PR Gate must execute and pass at the final PR head before merge. Observed prior core jobs remain queued without an assigned runner, requesting `self-hosted, Windows, X64, xauusd-core-ci`; this alone does not establish whether the runner is offline, busy or mismatched.

Check Settings > Actions > Runners in the private core repository and restore the dedicated CI runner using docs/private/SELF-HOSTED-CI.md. Do not use the production bot host as the CI runner. The distribution is now public, so its pinned commit can be fetched without a cross-repository private credential; the actual core gate must still verify this.

Keep this PR draft pending executed core gates. No production runtime, strategy, risk, execution, MT5, account, ARM or bot-mode change is included.
