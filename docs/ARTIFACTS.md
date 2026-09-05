# Inspect local evidence storage

**Unreleased source functionality.** Published `failtrace@1.1.0` does not include `artifacts` or the `inventoryArtifacts` Core API. Build this checkout before using these commands.

Repeated investigations retain logs, copied inputs and reports. To see where that space went without executing a saved command:

```sh
npm run build
node dist/cli/index.js artifacts
node dist/cli/index.js artifacts --cwd /path/to/project --json
```

The default storage root is `.failtrace` within the chosen working directory. Select a custom **storage root**, such as one previously passed to Core `artifactsDir`, with `--directory`. Do not select an individual run when you want its neighboring investigations and references included.

The table groups runs, bisects, minimizations, verifications, reproduction bundles and demos by investigation. Nested candidate runs count toward their enclosing investigation; their bytes are not counted again as separate entries. Other files and folders are visible as `unknown` rather than treated as disposable output.

JSON includes logical regular-file bytes, file counts, reported status, scan issues, and known links between investigations. `referencedBy` helps identify a baseline that another saved investigation still uses. External reference destinations are counted without displaying their paths. Commands, captured environment values and log contents are not returned. Storage paths themselves can be private.

## Read the limits with the totals

- The scan is read-only and does not create a missing `.failtrace` directory. It never runs target commands or deletes files.
- At most 20000 filesystem entries are visited by default. `--max-entries N` accepts 1–100000; depth is capped at 64. Both files and directories count toward the entry cap.
- Only selected report filenames are parsed for state and known path fields. Metadata reads are bounded to 32 MiB per document and 96 MiB overall, with a separate nesting/value limit. Trial logs are counted by size and never read.
- The chosen working directory is canonicalized first, allowing OS temporary-directory aliases. Within the selected storage path, observed symbolic links, junctions and special files are not followed; linked roots or ancestors are rejected. Unreadable, invalid, changed or oversized entries are reported; a scan cannot establish an atomic snapshot of an actively changing filesystem.
- `complete: false` means at least one scan or reference check was incomplete. Size totals may then be a lower bound. CLI exits `2`; it still returns the observations already collected. Exit `0` means the bounded scan completed, including an empty or missing storage root.
- Bytes mean file lengths, not allocated disk blocks. Hard-linked files count at every observed path. Target-created files outside the selected root, other storage roots and omitted subtrees are outside the total.

The `snapshot` field fingerprints observed paths and filesystem identities/timestamps. It detects ordinary changes between scans; it is not a content hash, tamper-proof evidence, lock or cleanup approval.

## Preserve an investigation's evidence

A reported `completed` state is not proof that no process is reading the data. References are only those found in the scanned report fields: another project, script or copied report may still depend on a run. A missing `referencedBy` entry does not establish that deletion is safe. Legacy metadata may also contain original absolute paths after it has been copied elsewhere.

Keep a parent investigation and its child runs together. Review a baseline's consumers before removing it through your own storage policy. Stop relevant work and preserve any evidence needed for Verify, comparison, inspection or bundle creation. This command deliberately provides no deletion or retention schedule.

Core callers use the same engine:

```js
import { inventoryArtifacts } from 'failtrace';

const inventory = await inventoryArtifacts({ cwd: projectDirectory, maxEntries: 20000 });
// Inspect inventory.complete and inventory.issues before interpreting totals.
```

Shell-capable agents can use the CLI with `--json`. This source addition does not add a new MCP tool. See [per-experiment limits](RESOURCE-LIMITS.md) for controls that bound newly generated evidence.
