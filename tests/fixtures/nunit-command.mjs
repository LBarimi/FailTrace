// Controlled NUnit 3 report producer for integration tests; does not launch Unity.
import { readFile, writeFile } from 'node:fs/promises';
const mode = process.argv[2] ?? 'failed';
const output = process.argv[3] ?? process.env.FAILTRACE_TEST_REPORT;
if (!output || (process.argv[3] && output !== process.env.FAILTRACE_TEST_REPORT)) throw new Error('Report argument/environment mismatch');
if (mode === 'missing') process.exit(0);
if (mode === 'invalid') { await writeFile(output, '<test-run>'); process.exit(0); }
let failed = mode === 'failed' || mode === 'unrelated' || mode === 'different';
if (mode === 'input') failed = (await readFile(process.argv[4], 'utf8')).includes('X');
const skipped = mode === 'skipped';
const name = mode === 'absent' || mode === 'unrelated' ? 'Game.Other' : 'Game.SaveRoundTrip';
const result = skipped ? 'Skipped' : failed ? 'Failed' : 'Passed';
const counts = `total="1" passed="${!failed && !skipped ? 1 : 0}" failed="${failed ? 1 : 0}" skipped="${skipped ? 1 : 0}" inconclusive="0"`;
await writeFile(output, `<?xml version="1.0" encoding="utf-8"?>\n<test-run result="${result}" ${counts}>
<test-suite type="Assembly" result="${result}" ${counts}>
<test-case fullname="${name}" result="${result}">${failed ? `<failure><message><![CDATA[${mode === 'different' ? 'OTHER_ASSERTION' : 'ITEM_LOST'}]]></message></failure>` : ''}</test-case>
</test-suite></test-run>`);
process.exitCode = failed || mode === 'bad-exit' ? 1 : 0;
