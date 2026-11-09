# V6 / Master-XAUUSD — M2 bootstrap provenance is blocked (read-only resolution)

**Status: intentionally BLOCKED as of 2026-11-09.** The PR `fix/v6-entry-structural-sl-trailing-20261109` remains **DRAFT**. The private production/provenance gate **must not pass** until the proper target repository has verifiable ancestry and an operator-approved attestation.

## Evidence observed on PR #1

- The GitHub-hosted V6, Canonical PR Gate, Web Quality and customer read-only checks passed on commit `3b4b7014`; the self-hosted Windows runner diagnostic also passed.
- `Private Master Core Self-Hosted CI` run [42566209381](https://github.com/thiennguyen3004931-sudo/Master-XAUUSD/actions/runs/42566209381) passed its M6 pinned public contract, synthetic DPAPI/security and source tests, then **FAILED** at `M2 provenance status`.
- The stored `security/private-bootstrap-attestation.json` asserts the private repository is `thiennguyen3004931-sudo/xauusd-ai-master-core`, **not** `thiennguyen3004931-sudo/Master-XAUUSD`.
- It pins the M2 bootstrap commit `de777c713da0bf4dd6d1c562898846dad1b82f3b` and tree `2527080bafe962a7ad69bf27fcc5263f103971ab`. The current repository has a different root commit `05c4a750df9493f41b39e6e8781a7276df75585f` (no parents), so that older bootstrap commit is **not in this branch's ancestry**.
- The verifier's `git rev-parse <M2>^{tree}` failed with `unknown revision`. This is a **provenance failure**, not a PowerShell, network, registry or MT5 execution failure.
- The M2 verifier now explicitly refuses to attest a GitHub target repository different from the one in the attestation, with `PRIVATE_BOOTSTRAP_TARGET_REPOSITORY_MISMATCH`.

## Read-only operator checks

On a **dedicated CI machine** with a fresh trusted checkout, in the actual `Master-XAUUSD` repository directory:

```powershell
git rev-list --max-parents=0 HEAD
git cat-file -e 'de777c713da0bf4dd6d1c562898846dad1b82f3b^{commit}'
git merge-base --is-ancestor de777c713da0bf4dd6d1c562898846dad1b82f3b HEAD
Get-Content .\security\private-bootstrap-attestation.json -Raw |
    ConvertFrom-Json |
    Select-Object publicRepository, privateRepository, publicCommit, privateBootstrapCommit
```

A failed `cat-file` or `merge-base` is **expected evidence of missing ancestry**, not permission to rewrite Git history or to turn off CI.

## Required human review to resolve legitimately

1. Decide whether `Master-XAUUSD` is intended to be a **new, independent V6 repository** or a verified continuation of the legacy `xauusd-ai-master-core`. These are *not* equivalent provenance claims.
2. If the M2/M3 acceptance applies only to the **legacy private repository**, keep that gate attached to the appropriate legacy release process. Do not claim `Master-XAUUSD` passed it.
3. If an M2 bootstrap attest is required for `Master-XAUUSD`, an authorized operator must verify the import history and source/tree identity from independently trusted repository objects, establish an appropriate **new versioned provenance model** for the new repository, and obtain review. Do not self-certify by editing two repository names, inventing a commit SHA, or weakening the ancestor/tree checks.
4. Rerun the unchanged gate after the reviewed provenance evidence has been added. A green V6 offline test does **not** equal an M3 private production acceptance or a broker-trade authorization.

**No API credentials, secrets, registration tokens, LIVE broker interactions or deployment are required for this investigation.**
