from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "preflight-phase7c-task-repair-readiness-local.ps1"


def _source() -> str:
    assert SCRIPT.exists(), f"missing read-only task repair readiness probe: {SCRIPT}"
    return SCRIPT.read_text(encoding="utf-8")


def test_probe_is_strictly_read_only():
    source = _source()

    required_markers = (
        "READ_ONLY=TRUE",
        "HTTP_METHODS=GET_ONLY",
        "GIT_MUTATION=NONE",
        "TASK_MUTATION=NONE",
        "PROCESS_MUTATION=NONE",
        "LIFECYCLE_MUTATION=NONE",
        "MODE_MUTATION=NONE",
        "ARM_MUTATION=NONE",
        "ORDER_MUTATION=NONE",
        "POSITION_MUTATION=NONE",
        "LIVE_TEST_ORDER=NONE",
    )
    for marker in required_markers:
        assert marker in source

    forbidden = (
        "Set-ScheduledTask",
        "Start-ScheduledTask",
        "Stop-ScheduledTask",
        "Register-ScheduledTask",
        "Unregister-ScheduledTask",
        "Enable-ScheduledTask",
        "Disable-ScheduledTask",
        "Start-Process",
        "Stop-Process",
        "Start-Service",
        "Stop-Service",
        "Restart-Service",
        "git pull",
        "git fetch",
        "git checkout",
        "git reset",
        "git clean",
        "Set-Content",
        "Add-Content",
        "Remove-Item",
        "Move-Item",
        "Copy-Item",
    )
    for token in forbidden:
        assert token not in source, f"read-only preflight must not contain {token}"


def test_probe_binds_source_to_exact_accepted_main():
    source = _source()

    assert "[string]$ExpectedMainCommit" in source
    assert "branch --show-current" in source
    assert "rev-parse HEAD" in source
    assert "status --porcelain" in source
    assert "ls-remote --heads origin refs/heads/main" in source
    assert "LOCAL_BRANCH_NOT_MAIN" in source
    assert "LOCAL_HEAD_NOT_EXPECTED_MAIN" in source
    assert "REMOTE_MAIN_NOT_EXPECTED" in source
    assert "LOCAL_WORKTREE_NOT_CLEAN" in source
    assert "SOURCE_GATE=" in source


def test_probe_requires_safe_stopped_flat_runtime():
    source = _source()

    assert "/api/v1/phase7c/bot-mode" in source
    assert "/api/v1/phase7c/lifecycle" in source
    assert "/api/v1/phase7c-live-arm-control/capability" in source
    assert "/v1/positions?symbol=XAUUSD" in source
    assert "/v1/orders?symbol=XAUUSD" in source
    assert "MODE_NOT_PAUSE" in source
    assert "ARM_NOT_DISARMED" in source
    assert "LIFECYCLE_NOT_STOPPED" in source
    assert "LIFECYCLE_READY_NOT_FALSE" in source
    assert "XAUUSD_POSITIONS_NONZERO" in source
    assert "XAUUSD_PENDING_ORDERS_NONZERO" in source
    assert "LIFECYCLE_READY=" in source


def test_probe_uses_canonical_task_ownership_and_exact_hash_evidence():
    source = _source()

    assert "$TaskName = 'XAUUSD-Phase7C-Executors'" in source
    assert "phase7c-scheduled-task-ownership.ps1" in source
    assert "Get-Phase7CExecutorTaskRunnerPath" in source
    assert "Get-Phase7CTrustedGitFileSha256" in source
    assert "Test-Phase7CExecutorTaskActionOwnership" in source
    assert "Get-Phase7CExecutorTaskDrift" in source
    assert "OWNED_HASH_DRIFT_REPAIR_REQUIRED" in source
    assert "[string]$ExpectedEmbeddedRunnerSha256" in source
    assert "[string]$ExpectedRunnerSha256" in source
    assert "RUNNER_ACTUAL_SHA_MISMATCH" in source
    assert "PRE_REPAIR_EMBEDDED_SHA_MISMATCH" in source
    assert "TASK_DRIFT_NOT_NONE" in source
    assert "PRINCIPAL_NOT_CANONICAL_SYSTEM" in source


def test_probe_outputs_machine_readable_repair_decision():
    source = _source()

    required = (
        "EXPECTED_MAIN=",
        "LOCAL_HEAD=",
        "REMOTE_MAIN=",
        "MODE=",
        "ARM=",
        "LIFECYCLE_RUNNING=",
        "LIFECYCLE_READY=",
        "XAUUSD_POSITIONS=",
        "XAUUSD_PENDING_ORDERS=",
        "RUNNER_ACTUAL_SHA=",
        "TASK_EMBEDDED_SHA=",
        "OWNERSHIP_OWNED=",
        "OWNERSHIP_CANONICAL=",
        "OWNERSHIP_REPAIRREQUIRED=",
        "OWNERSHIP_REASON=",
        "TASK_DRIFT=",
        "REPAIR_ALLOWED=",
        "BLOCKED_BY=",
        "PHASE7C_TASK_REPAIR_READINESS_PREFLIGHT=",
    )
    for marker in required:
        assert marker in source


if __name__ == "__main__":
    test_probe_is_strictly_read_only()
    test_probe_binds_source_to_exact_accepted_main()
    test_probe_requires_safe_stopped_flat_runtime()
    test_probe_uses_canonical_task_ownership_and_exact_hash_evidence()
    test_probe_outputs_machine_readable_repair_decision()
    print("task repair readiness preflight contract: PASS")
