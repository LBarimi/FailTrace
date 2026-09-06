import { describe, expect, it } from 'vitest';
import { parseNUnitReport, MAX_TEST_REPORT_BYTES, type NUnitPredicate } from '../src/core/index.js';

const predicate: NUnitPredicate = { kind: 'nunit_test', fullName: 'Game.SaveRoundTrip' };
const test = (result: string, extra = '', content = '') => `<test-case fullname="Game.SaveRoundTrip" result="${result}" ${extra}>${content}</test-case>`;
function report(content: string, result = 'Passed', counts = 'total="1" passed="1" failed="0" skipped="0" inconclusive="0"') {
  return `<test-run result="${result}" ${counts}><test-suite result="${result}">${content}</test-suite></test-run>`;
}
function parse(xml: string, selected = predicate) { return parseNUnitReport(Buffer.from(xml), selected); }
const failedCounts = 'total="1" passed="0" failed="1" skipped="0" inconclusive="0"';

describe('bounded NUnit 3 test evidence', () => {
  it('distinguishes an executed passing test and a selected assertion failure', () => {
    expect(parse(report(test('Passed')))).toMatchObject({ outcome: 'passed', counts: { total: 1, passed: 1 } });
    const xml = report(test('Failed', '', '<failure><message><![CDATA[ITEM_LOST <item>]]></message></failure>'), 'Failed', failedCounts);
    expect(parse(xml, { ...predicate, messageContains: 'ITEM_LOST' })).toMatchObject({ outcome: 'failed', message: 'ITEM_LOST <item>' });
    expect(parse(xml, { ...predicate, messageContains: 'DIFFERENT' })).toMatchObject({ outcome: 'inconclusive', reason: expect.stringContaining('different failure') });
  });
  it('matches XML-escaped parameterized full names literally, never as a regex', () => {
    const xml = report(test('Passed').replace('Game.SaveRoundTrip', 'Game.Test(&quot;&lt;item&gt;&amp;&quot;)'));
    expect(parse(xml, { ...predicate, fullName: 'Game.Test("<item>&")' }).outcome).toBe('passed');
    expect(parse(xml, { ...predicate, fullName: 'Game.*' }).outcome).toBe('inconclusive');
  });
  it('accepts the Failed(Child) root emitted by Unity Test Framework 1.4.6', () => {
    const xml = report(test('Failed'), 'Failed', failedCounts).replace('<test-run result="Failed"', '<test-run result="Failed(Child)"');
    expect(parse(xml).outcome).toBe('failed');
  });
  it.each([
    report(''), report(test('Passed')).replace('total="1"', 'total="0"'),
    report(test('Passed')).replace('Game.SaveRoundTrip', 'Other'),
    report(test('Passed') + test('Passed'), 'Passed', 'total="2" passed="2" failed="0" skipped="0" inconclusive="0"'),
    report(test('Skipped'), 'Skipped', 'total="1" passed="0" failed="0" skipped="1" inconclusive="0"'),
    report(test('Inconclusive'), 'Inconclusive', 'total="1" passed="0" failed="0" skipped="0" inconclusive="1"'),
    report(test('Failed', 'site="SetUp"'), 'Failed', failedCounts),
    report(test('Failed', 'label="Invalid"'), 'Failed', failedCounts),
    report(test('Failed', 'label="Cancelled"'), 'Failed', failedCounts),
    report(test('Passed', 'runstate="NotRunnable"')),
    report(test('Passed', '', '<failure><message>Contradictory failure</message></failure>')),
    report(test('Passed')).replace('<test-suite result="Passed">', '<test-suite result="Failed" site="TearDown">').replace('<test-run result="Passed"', '<test-run result="Failed"'),
    report(test('Failed'), 'Passed', failedCounts),
    report(test('Failed'), 'Failed', failedCounts).replace('<test-suite result="Failed">', '<test-suite result="Failed" total="100">'),
    report(test('__proto__')),
    '<test-results total="1"/>', '<test-run>', report(test('Passed')) + '<extra/>',
    report(test('Passed')).replace('</test-suite>', '</other>'),
    report(test('Passed')).replace('result="Passed"', 'result="Passed" result="Failed"'),
    '<!DOCTYPE test-run [<!ENTITY x SYSTEM "file:///private">]>' + report(test('Passed')),
    report(test('Passed', '', '&unknown;')),
    '<test-run><output>' + test('Passed') + '</output></test-run>',
    report(test('Passed') + '<test-case fullname="Other" result="Failed"/>', 'Failed', 'total="2" passed="1" failed="1" skipped="0" inconclusive="0"'),
    report(test('Passed')).replace('<test-suite result="Passed">', '<test-suite result="Passed">'.repeat(65)).replace('</test-suite>', '</test-suite>'.repeat(65)),
  ])('rejects absent, skipped, unrelated, inconsistent or invalid evidence (%#)', xml => {
    expect(parse(xml).outcome).toBe('inconclusive');
  });
  it('does not interpret escaped or CDATA markup as additional test cases', () => {
    expect(parse(report(test('Passed', '', '<output><![CDATA[<test-case fullname="Other" result="Failed"/>]]></output>'))).outcome).toBe('passed');
  });
  it('bounds bytes, invalid UTF-8 and requested test identifiers', () => {
    expect(parseNUnitReport(Buffer.alloc(MAX_TEST_REPORT_BYTES + 1), predicate).outcome).toBe('inconclusive');
    expect(parseNUnitReport(Buffer.from([0xff]), predicate).outcome).toBe('inconclusive');
    expect(() => parse('', { ...predicate, fullName: '' })).toThrow('exact fullName');
    expect(() => parse('', { ...predicate, messageContains: '' })).toThrow('messageContains');
  });
});
