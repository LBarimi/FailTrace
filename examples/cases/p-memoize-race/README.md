# A real race in promise memoization

Two callers request the same value while the first request is still pending. **p-memoize 6.0.2 runs the underlying operation twice; 7.0.0 shares the pending operation.** This can turn memoized work into duplicate API calls when requests overlap.

The upstream report describes concurrent calls during page generation and the resulting extra requests: [issue #43](https://github.com/sindresorhus/p-memoize/issues/43). [Merged PR #48](https://github.com/sindresorhus/p-memoize/pull/48) changes when pending promises are cached. The [7.0.0 release notes](https://github.com/sindresorhus/p-memoize/releases/tag/v7.0.0) identify that fix and compare against 6.0.2.

This is an authored, offline reproducer of that real race. A promise barrier controls whether a second same-key request overlaps the first or starts after it finishes. It uses neither a remote API nor random delays. The six schedules are declared in `schedule.json` before either version runs: overlap, sequential, repeated three times. The affected release has three matching schedule outcomes; the fixed release completes all six successfully. **These counts describe controlled schedule coverage, not a naturally sampled flaky-failure probability.**

## Run the checker

Requires Node.js 22.12+ and npm. From this directory:

```sh
npm ci --ignore-scripts
npm test
node check.mjs
```

The final command runs the first, overlapping schedule against the affected release and exits 1 after printing `P_MEMOIZE_DUPLICATE_IN_FLIGHT`. That is the expected reproduced bug. Both exact dependency versions and the transitive dependency are locked. Execution is offline after installation.

## Verify the pinned fix

The Verify investigation uses the new Verify Core API, targeted for FailTrace 0.5.0. On a source branch containing that API, build from the repository root first:

```sh
npm ci
npm run build
cd examples/cases/p-memoize-race
npm ci --ignore-scripts
npm run verify
```

The shared loader selects the checkout's built Core, checks its version against the root manifest, and requires its `verifyFix` export. It does not accidentally load an older globally installed package. For validation against an installed release archive, set `FAILTRACE_PACKAGE` to that installation's `dist/core/index.js` and `FAILTRACE_EXPECT_VERSION` to the intended release before running the command. An explicit path is canonicalized and must work; there is no fallback. For example, after installing the Verify release:

```powershell
$env:FAILTRACE_PACKAGE = 'C:\path\to\package\dist\core\index.js'
$env:FAILTRACE_EXPECT_VERSION = '0.5.0'
npm run verify
```

On POSIX shells:

```sh
export FAILTRACE_PACKAGE='/path/to/package/dist/core/index.js'
export FAILTRACE_EXPECT_VERSION='0.5.0'
npm run verify
```

Replace these placeholder paths with the actual installation. The example does not install or select a release implicitly.

The script copies the authored fixture into a fresh `.failtrace/verify-*/target` workspace. Every run uses the same command, cwd, predicate, six-trial budget and schedule file. It captures input, setup and source file identities. Both dependency versions are installed together; the intentional intervention changes only the copied `release.mjs` selector from the affected alias to the fixed alias. That source change must be explicitly allowed with a reason. The original checker, selector, dependency files and schedules remain untouched.

Before the fixed control, the script verifies that an unchanged candidate and a source edit still selecting the old version both retain the target. A deliberately invalid selector must be `inconclusive`, even though it produces no target matches. Missing imports, invalid versions and malformed schedules exit 2 with `CASE_SETUP_ERROR`, never the target signature.

The successful fixed-control result is `target_not_observed`, with 0/6 target matches and six healthy exits. It is not a declaration that the library is universally bug-free. Reports and full trial evidence stay in `.failtrace/`; review generated files before sharing them because they contain local paths and command output. CI exercises the checker and Verify workflow on Windows, macOS and Linux using the built checkout.

## Attribution

`p-memoize` and its dependency are MIT licensed; npm installations retain their license files. This case contains independently authored harness code, with upstream attribution above, and does not vendor the upstream implementation. The historical defect and its fix belong to the upstream project. Use an appropriate maintained dependency release in a real application; these versions are pinned for this investigation.
