from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "repair-phase7c-scheduled-task-runner-hash-local.ps1"


def _source() -> str:
    assert SCRIPT.exists(), f"missing definition-only repair script: {SCRIPT}"
    return SCRIPT.read_text(encoding="utf-8")


def test_repair_is_bound_to_canonical_phase7c_task_identity():
    source = _source()

    assert "$TaskName = 'XAUUSD-Phase7C-Executors'" in source
    assert "$TaskPath = '\\'" in source
    assert "Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $projectRoot" in source
    assert "[string]$TaskName" not in source
    assert "[string]$RunnerPath" not in source


def test_repair_is_definition_only_and_uses_canonical_ownership_contract():
    source = _source()

    assert "phase7c-scheduled-task-ownership.ps1" in source
    assert "Test-Phase7CExecutorTaskActionOwnership" in source
    assert "Get-Phase7CExecutorTaskDrift" in source
    assert "New-Phase7CExecutorTaskGuardArguments" in source
    assert "Get-Phase7CScheduledTaskOwnershipVerdict" not in source
    assert "OWNED_HASH_DRIFT_REPAIR_REQUIRED" in source
    assert "RUNNER_HASH_DRIFT" in source
    assert source.count("Set-ScheduledTask") == 1

    forbidden = (
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
        "schtasks.exe",
        "Invoke-RestMethod",
        "Invoke-WebRequest",
        "Set-Content",
        "Add-Content",
        "Remove-Item",
        "Move-Item",
        "Copy-Item",
        "Set-ItemProperty",
    )
    for token in forbidden:
        assert token not in source, f"definition-only repair must not contain {token}"


def test_repair_is_fail_closed_to_runner_hash_drift_only():
    source = _source()

    assert "if (-not $preOwnership.owned)" in source
    assert "if (-not $preOwnership.repairRequired)" in source
    assert '$preOwnership.reason -ne "OWNED_HASH_DRIFT_REPAIR_REQUIRED"' in source
    assert "if ($preTaskDrift.Count -ne 0)" in source
    assert "PRE_REPAIR_TASK_DRIFT" in source
    assert "PRE_REPAIR_PRINCIPAL_NOT_CANONICAL_SYSTEM" in source
    assert "Get-FileHash" in source
    assert "Get-Phase7CTrustedGitFileSha256" in source
    assert "-Algorithm SHA256" in source
    assert "RUNNER_ACTUAL_SHA_MISMATCH" in source


def test_repair_requires_exact_observed_embedded_sha_before_mutation():
    source = _source()

    assert "ExpectedEmbeddedRunnerSha256" in source
    assert "PRE_REPAIR_EMBEDDED_SHA_MISMATCH" in source
    assert "$preEmbeddedSha -ne $expectedEmbeddedSha" in source
    assert "PRE_REPAIR_RUNNERSHA256=" in source


def test_repair_builds_the_same_guard_action_contract_as_canonical_library():
    source = _source()

    assert "New-Phase7CExecutorTaskGuardArguments" in source
    assert "-RunnerPath $resolvedRunnerPath" in source
    assert "-RunnerSha256 $expectedSha" in source
    assert "$existingAction = @($task.Actions)[0]" in source
    assert "$existingExecute = [string]$existingAction.Execute" in source
    assert "$existingWorkingDirectory = [string]$existingAction.WorkingDirectory" in source


def test_repair_rechecks_canonical_acceptance_after_definition_change():
    source = _source()

    assert source.count("Test-Phase7CExecutorTaskActionOwnership") >= 2
    assert source.count("Get-Phase7CExecutorTaskDrift") >= 2
    assert "if (-not $postOwnership.owned)" in source
    assert "if (-not $postOwnership.canonical)" in source
    assert "if ($postOwnership.repairRequired)" in source
    assert "if ($postTaskDrift.Count -ne 0)" in source
    assert "OWNERSHIP_OWNED=True" in source
    assert "OWNERSHIP_CANONICAL=True" in source
    assert "OWNERSHIP_REPAIRREQUIRED=False" in source
    assert "OWNERSHIP_RUNNERSHA256=" in source
    assert "TASK_DRIFT=NONE" in source
    assert "MUTATION=TASK_DEFINITION_ONLY" in source
    assert "REPAIR_SCOPE=RUNNER_HASH_ONLY" in source


def main() -> None:
    tests = (
        test_repair_is_bound_to_canonical_phase7c_task_identity,
        test_repair_is_definition_only_and_uses_canonical_ownership_contract,
        test_repair_is_fail_closed_to_runner_hash_drift_only,
        test_repair_requires_exact_observed_embedded_sha_before_mutation,
        test_repair_builds_the_same_guard_action_contract_as_canonical_library,
        test_repair_rechecks_canonical_acceptance_after_definition_change,
    )
    for test in tests:
        test()
    print(f"PASS: {len(tests)} definition-only repair contract checks")


if __name__ == "__main__":
    main()
