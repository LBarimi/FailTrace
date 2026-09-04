import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function signalProcess(pid: number, signal: NodeJS.Signals): string | undefined {
  try {
    process.kill(pid, signal);
  } catch (error) {
    // Already-exited processes are expected during process-tree cleanup.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return undefined;
}

/** Best-effort cleanup, with a bounded wait even when OS termination fails. */
export async function terminateProcessTree(child: ChildProcess): Promise<string | undefined> {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform !== 'win32') {
    // The runner starts the shell as a process-group leader. Kill the group
    // even if its shell exits first: a descendant may ignore SIGTERM.
    signalProcess(-pid, 'SIGTERM');
    await delay(250);
    const error = signalProcess(-pid, 'SIGKILL');
    return error === undefined ? undefined : `Process-group cleanup failed: ${error}`;
  }

  return new Promise<string | undefined>((resolve) => {
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    let killer: ChildProcess;
    try {
      killer = spawn(executable, ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      signalProcess(pid, 'SIGKILL');
      resolve(`Unable to start taskkill: ${String(error)}. Descendant cleanup may be incomplete.`);
      return;
    }

    let finished = false;
    const finish = (error?: string): void => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      // Fall back to the root process if taskkill is unavailable or fails.
      if (child.exitCode === null && child.signalCode === null) {
        signalProcess(pid, 'SIGKILL');
      }
      resolve(error);
    };
    const deadline = setTimeout(() => {
      if (killer.pid !== undefined) signalProcess(killer.pid, 'SIGKILL');
      killer.unref();
      finish('Timed out waiting for taskkill. Descendant cleanup may be incomplete.');
    }, 2_000);
    killer.once('close', (code) => finish(code === 0 ? undefined
      : `taskkill exited with code ${String(code)}. Descendant cleanup may be incomplete.`));
    killer.on('error', (error) => finish(
      `Unable to run taskkill: ${error.message}. Descendant cleanup may be incomplete.`,
    ));
  });
}
