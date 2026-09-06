import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { matchesFailure, MAX_REGEX_OUTPUT_BYTES } from '../src/core/predicates.js';
import { runTrials } from '../src/core/index.js';
import { cleanupDirectories, quoteShellArgument, temporaryDirectory } from './helpers.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

const directories: string[] = [];
afterEach(async () => { vi.mocked(fs.stat).mockReset(); await cleanupDirectories(directories); });

it('bounds regex allocation again inside its worker if output grows after the caller size check', async () => {
  const cwd = await temporaryDirectory(); directories.push(cwd);
  await fs.writeFile(join(cwd, 'target.mjs'), "process.stdout.write('TARGET'); process.exitCode = 1;");
  const run = await runTrials({ cwd, command: `${quoteShellArgument(process.execPath)} target.mjs`, repeat: 1 });
  const trial = run.trials[0]!;
  const output = join(run.artifactDirectory, trial.stdoutPath);
  const actual = await vi.importActual<typeof fs>('node:fs/promises');
  const earlier = await actual.stat(output);
  vi.mocked(fs.stat).mockImplementationOnce(async () => {
    await fs.writeFile(output, Buffer.alloc(MAX_REGEX_OUTPUT_BYTES + 1, 120));
    return earlier;
  });
  await expect(matchesFailure(trial, run.artifactDirectory, { kind: 'stdout_regex', pattern: 'x' }))
    .rejects.toThrow('exceeds 16 MiB');
});
