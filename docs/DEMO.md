# What the guided demo shows

Run the published example with `npx --yes failtrace@1.4.0 demo`. It uses bundled fixtures and writes to `.failtrace/demos/<id>/`.

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

## README animation

The README GIF summarizes the original CLI demo: a failure that comes and goes, a reduced input, an unrelated crash, and a checked patch. The first frame and poster show the observed failure immediately. The layout abbreviates output and edits timing; it depicts CLI results, not an autonomous agent session or a speed measurement. [Static poster](assets/demo-poster.png) · [Full static summary](assets/demo.svg)

The [recording manifest](assets/demo-recording.json) records the CLI version, checked outcomes and asset hashes. It contains no raw logs, environment values or local machine paths. The current recording uses a fresh public npm installation of 1.4.0.

To regenerate it, use Node.js and the optional maintainer image renderer. This does not add a runtime dependency to FailTrace:

```sh
npm install --prefix .failtrace/media-tools --no-save --package-lock=false sharp@0.35.4
npm run build
node scripts/render-demo.mjs
node scripts/render-demo-animation.mjs
npm run check:docs
```

The renderers execute the demo and validate the depicted results before writing the static SVG, GIF, poster and recording manifest. Use `--cli <installed-package>/dist/cli/index.js` on both renderers to record an independently installed package, or `--sharp <sharp-package-directory>` on the animation renderer to use an existing image library. Raw evidence and vector storyboards stay under `.failtrace/demos/<id>/`. Keep the GIF below 1 MiB.

Review each scene at README width before committing. Only validated fixture values enter the artwork. Generate the SVG before the animation so the manifest covers all three current assets; `check:docs` rejects stale versions or changed assets.

[Documentation index](README.md)
