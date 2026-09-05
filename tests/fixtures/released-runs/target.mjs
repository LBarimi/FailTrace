const index = Number(process.env.FAILTRACE_TRIAL_INDEX);
process.stdout.write(`trial ${index}\n`);
if (index === 2) {
  process.stderr.write('COMPAT_TARGET\n');
  process.exitCode = 7;
}
