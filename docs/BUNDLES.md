# Review a bundle before sharing

The controls on this page require FailTrace 1.0. Version 0.6.0 includes original evidence and captured environment values by default. See [installation and publication status](../README.md#quick-start) when selecting a package version.

A reproduction bundle is a local directory with selected source/input files, execution settings and an included Node Core engine. Creation never executes or uploads the target. The original investigation remains intact.

## Default selection

```sh
node dist/cli/index.js bundle <run> --file reproduce.js --input <reduced-input>
```

The new default excludes original run metadata/logs and all captured environment values. `repro.json` still contains the replay command, failure predicate, settings and explicit source/input selections. These selected contents can themselves contain private information; the bundle is not automatically sanitized.

The command returns a `manifestPath` and prints it in human-readable output. Before sending the directory to someone else, inspect:

- `manifest.json`: every content file's relative path, category, byte count and SHA-256 hash, plus included environment key names and omitted environment prerequisites.
- `repro.json`: the actual command, predicate and explicitly included environment values.
- Selected source and input files, and original evidence if you chose to include it.

The manifest excludes itself from its file list and `contentBytes`; the returned `fileCount` and `totalBytes` include it. Hashes describe creation-time content and do not certify trust, detect secrets or cover later modifications. Replay writes new logs under `replay-artifacts/`, which need separate review before sharing again.

## Include original evidence deliberately

```sh
node dist/cli/index.js bundle <run> --file reproduce.js --include-evidence
```

`--include-evidence` / Core and MCP `includeEvidence: true` adds original `run.json`, trial records and stdout/stderr under `logs/`. Those bytes are copied unchanged. This includes any original machine paths, selected environment values or private output in them, even if no environment value was selected for replay. The manifest and CLI explicitly report that original evidence is included. Excluding it from a bundle never deletes or modifies the original investigation.

## Choose environment values

```sh
node dist/cli/index.js bundle <run> --file reproduce.js --include-env FEATURE_MODE
node dist/cli/index.js bundle <run> --file reproduce.js --env-file reviewed-environment.json
```

Repeat `--include-env KEY` / supply Core or MCP `includeEnv: ["FEATURE_MODE"]` to include specific values from the run's captured snapshot. Uncaptured names are rejected. An explicit `env` object or CLI `--env-file` also opts in the provided values and overrides the selected captured values for matching keys. JSON null unsets a key. Portable environment names are limited to 256 ASCII letters, digits or underscores, starting with a letter or underscore; case-only collisions are rejected.

Omitted captured keys are retained as `requiredEnvironment: [{ key, state: "set" | "unset" }]`, without their values. The recipient must set or unset these keys before replay. An unmet prerequisite exits 2 before creating a new run or executing the target. Presence alone cannot establish that the supplied value is equivalent to the original. Choose values appropriate to the original experiment or deliberately include reviewed captured values.

When an input file/directory is selected, FailTrace supplies the relocated `FAILTRACE_INPUT` or `FAILTRACE_INPUT_DIR` itself. These managed input variables do not retain source-machine paths or become recipient prerequisites. Other uncaptured environment state is inherited; a bundle does not fully reconstruct the original environment.

## Copy and replay limits

`--max-bundle-bytes` / `maxBundleBytes` bounds all included content and the manifest, defaulting to 536870912 bytes (512 MiB). There are at most 10000 files, 10000 traversed directory entries, and 64 destination path levels. Generated JSON/documents are at most 32 MiB each. Use a positive safe integer for an explicit larger byte allowance.

Local copies use bounded snapshot reads and reject changing sources. Git source exports reserve the immutable blob's size before copying it. Symbolic links, special files, traversal and nonportable names are rejected. Exceeding a limit fails creation and removes only the fresh, owned incomplete destination. Existing destinations and original inputs/evidence are never overwritten. Destination replacement causes cleanup to stop rather than delete an unrelated directory.

Replay configurations use schema 2 for these environment prerequisites and sharing choices. New replay scripts require their matching configuration. Previously created bundles retain their included engine/scripts and behavior; rebuilding a bundle from an older saved run uses the new defaults and limits.

Replay still needs the target's tools, dependencies, services and platform shell. It reports finite target observations, not proof that a defect is absent. See the [command reference](CLI.md#create-a-portable-local-bundle) and [resource limits](RESOURCE-LIMITS.md).
