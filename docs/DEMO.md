# What the guided demo shows

Run the published example with `npx --yes failtrace@1.0.0 demo`. It works from any directory and writes to `.failtrace/demos/<id>/`.

The target is deliberately controlled so the workflow is easy to inspect:

1. Ten trials produce seven passes and three failures.
2. A six-element JSON input is reduced to `["BUG"]` and independently rechecked.
3. The minimized affected target is observed twice as a captured verification baseline.
4. An unrelated crash is rejected as inconclusive.
5. A proposed fix produces two healthy observations without a target match.
6. The affected implementation is restored in a bundle and a replay command is printed.

These counts demonstrate the command flow and its controls. They are not a naturally sampled production failure rate, a performance benchmark, or evidence of independent adoption. The target-free sample does not prove defect elimination.

The guided demo exits `0` when its expected controls complete. Replaying its intentionally failing bundle exits `1`. Check each command's [exit meaning](CLI.md#artifacts-and-exit-codes) instead of assuming every nonzero exit is a FailTrace application error.

For your own investigation, choose a specific failure signature, arrange the target dependencies, and select an appropriate trial budget. Capture [verification context](VERIFY.md) before modifying code. Review the [bundle contents and prerequisites](BUNDLES.md) before sharing.

[Return to quick start](../README.md#quick-start)
