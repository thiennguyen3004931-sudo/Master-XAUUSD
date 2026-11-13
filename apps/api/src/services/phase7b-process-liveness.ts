type Phase7BPidProbe = (pid: number) => void;

function defaultPidProbe(pid: number): void {
  process.kill(pid, 0);
}

export function isPhase7BProcessAlive(
  pid: number | null | undefined,
  probe: Phase7BPidProbe = defaultPidProbe,
): boolean {
  if (!Number.isInteger(pid) || (pid ?? 0) <= 0) return false;

  try {
    probe(pid as number);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
    return code === "EPERM";
  }
}
