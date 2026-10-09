/**
 * Test-only crash injection. With PIO_FAILPOINT=<name> the process kills itself (SIGKILL: no cleanup, exactly
 * like a crash or an OOM kill) the moment it reaches that named point. Without the variable it does nothing.
 */
export function failpoint(name: string): void {
  if (process.env.PIO_FAILPOINT === name) process.kill(process.pid, "SIGKILL");
}
