if (process.env.FAILTRACE_TEST_MODE === 'boundary') {
  process.stdout.write('x'.repeat(65534) + 'TARGET' + 'x'.repeat(20));
} else if (process.env.FAILTRACE_TEST_MODE === 'redos') {
  process.stdout.write('a'.repeat(50_000) + '!');
} else {
  process.stdout.write(process.env.FAILTRACE_TEST_OUT ?? 'hello\n');
  process.stderr.write(process.env.FAILTRACE_TEST_ERR ?? 'diagnostic\n');
}
process.exitCode = Number(process.env.FAILTRACE_TEST_EXIT ?? 0);
