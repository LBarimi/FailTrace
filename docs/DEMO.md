# What the guided demo shows

Run the published example with `npx --yes failtrace@1.1.0 demo`. It works from any directory and writes to `.failtrace/demos/<id>/`.

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

The README GIF is an animated summary of a recorded FailTrace 1.0.0 CLI demo. It follows the same observations above and highlights the unrelated-error check. The layout abbreviates the CLI output and edits timing for readability; it is not a recording of an autonomous agent, a GUI shipped with FailTrace, or a speed measurement. [Static poster](assets/demo-poster.png) · [Full static summary](assets/demo.svg)

To regenerate it, use Node.js and the optional maintainer image renderer. This does not add a runtime dependency to FailTrace:

```sh
npm install --prefix .failtrace/media-tools --no-save --package-lock=false sharp@0.35.4
npm run build
node scripts/render-demo-animation.mjs
```

The renderer executes the demo and validates the depicted results before writing `docs/assets/demo.gif` and `docs/assets/demo-poster.png`. Use `--cli <installed-package>/dist/cli/index.js` to record an independently installed release, or `--sharp <sharp-package-directory>` to use an existing renderer installation. Raw evidence and vector storyboards stay under the generated `.failtrace/demos/<id>/` directory. The GIF must remain below 1 MiB. Rendering uses [Sharp's GIF output](https://sharp.pixelplumbing.com/api-output/#gif).

Review each scene and the animation at README width before committing. Only validated demo values enter the artwork; local command paths, artifact paths, environment values and raw logs must remain private. Keep the caption's recorded version consistent with the CLI used to render. `node scripts/render-demo.mjs` separately regenerates the full static SVG summary from a fresh source demo.
