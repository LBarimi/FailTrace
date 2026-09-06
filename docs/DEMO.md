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

## README images and animation

The README GIF summarizes the original CLI demo: a failure that comes and goes, a reduced input, an unrelated crash, and a checked patch. The first frame and poster show the observed failure immediately. [Static poster](assets/demo-poster.png) · [Full static summary](assets/demo.svg)

Three additional images sit beside their feature descriptions:

- [MCP session](assets/agent-session.png): capture a failure, inspect saved output and verify a patch through the stdio server.
- [NUnit evidence](assets/unit-test-evidence.png): process failed, passed and skipped NUnit 3 XML fixtures through MCP.
- [Reproduction bundle](assets/reproduction-bundle.png): package the reduced input and source files, then replay the failure.

The [demo manifest](assets/demo-recording.json) and [feature-image manifest](assets/readme-scenes.json) record the CLI version, checked outcomes and asset hashes. They contain no raw logs, environment values or local machine paths. The current recordings use the verified public npm installation of 1.4.0.

To regenerate it, use Node.js and the optional maintainer image renderer. This does not add a runtime dependency to FailTrace:

```sh
npm install --prefix .failtrace/media-tools --no-save --package-lock=false sharp@0.35.4
npm run build
node scripts/render-demo.mjs
node scripts/render-demo-animation.mjs
node scripts/render-readme-scenes.mjs
npm run check:docs
```

The renderers validate the depicted outcomes before writing assets. Use `--cli <installed-package>/dist/cli/index.js` on each renderer to record an independently installed package, or `--sharp <sharp-package-directory>` on either PNG/GIF renderer to use an existing image library. Raw evidence and vector storyboards stay under `.failtrace/demos/<id>/` and `.failtrace/readme-media/`. The feature recorder uses the development MCP client to call the installed server. Keep the GIF below 1 MiB and each feature image below 250 KiB.

Review each scene at README width before committing. Only validated fixture values enter the artwork. Generate the SVG before the animation so its manifest covers all three demo assets; the feature recorder writes its own manifest. `check:docs` rejects stale versions or changed assets in either set.

[Documentation index](README.md)
