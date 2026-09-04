export const AXES = {
  durations: { noop: 0, '10ms': 10, '100ms': 100, '1s': 1000 },
  outputs: { '0': 0, '10KiB': 10 * 1024, '1MiB': 1024 * 1024 },
  predicates: ['nonzero_exit', 'exit_code', 'substring', 'regex'],
};
export function quoteExecutable(executable) {
  return process.platform === 'win32' ? `"${executable}"` : `'${executable.replaceAll("'", "'\\''")}'`;
}
export function parseOptions(args) {
  const options = { suite: 'smoke', check: false, hash: false, experiments: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--check' || flag === '--hash' || flag === '--experiments') { options[flag.slice(2)] = true; continue; }
    if (flag === '--help') { options.help = true; continue; }
    if (!['--suite', '--core', '--output', '--label', '--durations', '--repeats', '--outputs', '--predicates'].includes(flag)) {
      throw new Error(`Unknown benchmark option: ${flag}`);
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    options[flag.slice(2)] = value;
  }
  if (!['smoke', 'ci', 'full'].includes(options.suite)) throw new Error('Suite must be smoke, ci, or full.');
  if (options.label && !/^[a-zA-Z0-9._-]{1,80}$/.test(options.label)) throw new Error('Label must be 1–80 letters, digits, dots, underscores, or hyphens.');
  for (const name of ['durations', 'outputs', 'predicates']) {
    if (options[name] === undefined) continue;
    const allowed = name === 'predicates' ? AXES.predicates : Object.keys(AXES[name]);
    const selected = options[name].split(',');
    if (selected.some((value) => !allowed.includes(value))) throw new Error(`Invalid ${name}; choose ${allowed.join(',')}.`);
    options[name] = [...new Set(selected)];
  }
  if (options.repeats !== undefined) {
    const selected = options.repeats.split(',').map(Number);
    if (selected.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 1000)) throw new Error('Benchmark repeats must be integers from 1 to 1000.');
    options.repeats = [...new Set(selected)];
  }
  return options;
}
const item = (duration, repeat, output, predicate) => ({ durationMs: AXES.durations[duration], repeat, outputBytes: AXES.outputs[output], predicate });
export function buildCases(options) {
  const filtered = ['durations', 'repeats', 'outputs', 'predicates'].some((key) => options[key] !== undefined);
  if (options.suite === 'full' || filtered) {
    const cases = [];
    for (const duration of options.durations ?? Object.keys(AXES.durations))
      for (const repeat of options.repeats ?? [1, 10, 100, 1000])
        for (const output of options.outputs ?? Object.keys(AXES.outputs))
          for (const predicate of options.predicates ?? AXES.predicates) cases.push(item(duration, repeat, output, predicate));
    return cases;
  }
  const structural = [item('noop', 10, '0', 'nonzero_exit'), item('noop', 100, '0', 'nonzero_exit')];
  if (options.suite === 'ci') return [...structural, item('noop', 10, '10KiB', 'substring'), item('noop', 10, '1MiB', 'regex')];
  return [...structural, item('noop', 1, '0', 'exit_code'), item('10ms', 10, '10KiB', 'substring'),
    item('100ms', 1, '1MiB', 'regex'), item('1s', 1, '0', 'nonzero_exit')];
}
export function checkBudgets(results) {
  const failures = [];
  const core = results.filter((result) => result.mode === 'failtrace' && result.case.experiment === undefined);
  for (const result of core) {
    const { repeat } = result.case;
    if (result.io.metadataBytesWritten <= 0 || result.io.unmeasuredWriteCalls > 0) failures.push(`${result.id}: metadata instrumentation incomplete`);
    // Deliberately broad ceilings; reject quadratic metadata growth, not machine noise.
    if (result.io.metadataBytesWritten > 40_000 + 8_192 * repeat) failures.push(`${result.id}: metadata byte budget exceeded`);
    if (result.io.fsyncCalls > 8 + repeat) failures.push(`${result.id}: fsync budget exceeded`);
    const baseline = results.find((candidate) => candidate.mode === 'direct-shell'
      && candidate.case.durationMs === result.case.durationMs && candidate.case.repeat === repeat
      && candidate.case.outputBytes === result.case.outputBytes);
    if (!baseline) failures.push(`${result.id}: direct-shell baseline missing`);
    else if (result.wallMs > baseline.wallMs * 8 + 3_000) failures.push(`${result.id}: broad wall-time budget exceeded`);
  }
  const small = core.find((result) => result.case.repeat === 10 && result.case.outputBytes === 0 && result.case.durationMs === 0 && result.case.predicate === 'nonzero_exit');
  const large = core.find((result) => result.case.repeat === 100 && result.case.outputBytes === 0 && result.case.durationMs === 0 && result.case.predicate === 'nonzero_exit');
  if (!small || !large) failures.push('Structural guard requires noop / 0 bytes / nonzero_exit cases at repeats 10 and 100.');
  else if (large.io.metadataBytesWritten > small.io.metadataBytesWritten * 15) failures.push('Metadata growth exceeds the 15x allowance for 10x more trials.');
  return failures;
}
