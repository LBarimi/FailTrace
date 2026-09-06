# Publishing a verified release

Publish the exact reviewed GitHub release archive to npm using its public HTTPS URL. npm can record the publication input in public registry fields such as `_from` and `_resolved`; a local archive path can expose a machine directory even when that path is absent from the archive itself.

## Prepare and verify the public archive

Run `npm run check:docs` before release preparation. It checks package/runtime/MCP consistency, local documentation links, and the demo recording's asset hashes. Install examples and demo assets follow the published version declared in `docs/INSTALL.md`, which can lag a source release being prepared. After verifying publication, update that declaration, current install pins and demo assets together; retain historical versions in release records and migration notes. This offline check does not establish publication; public installation verification below remains required.

1. Use an exact version with matching package, runtime, lockfile, and MCP metadata. Keep the existing release gates: the exact `main` commit must pass all six Windows/macOS/Linux and Node.js 22/24 CI jobs, plus the `minimum-node` installed-package check on Node.js 22.12.0. Any existing version tag must point to that commit.
2. Run the [Prepare release tarball workflow](https://github.com/LBarimi/FailTrace/blob/main/.github/workflows/release.yml). It builds, packs, smoke-tests the installed package outside the checkout, and produces the archive, `SHA256SUMS`, and `release.json`. This workflow prepares artifacts; it does not publish them.
3. Review those artifacts, then attach the same archive and checksum to the corresponding public GitHub release. Download the HTTPS asset without authentication and confirm its SHA-256 matches the reviewed checksum. Preserve those exact bytes; do not repack the source or substitute another archive for npm publication.

## Publish from the public URL

Replace both `<VERSION>` placeholders with the exact version, without a leading `v`. After the release archive above is public and verified, use:

```sh
npm publish "https://github.com/LBarimi/FailTrace/releases/download/v<VERSION>/failtrace-<VERSION>.tgz" --access public --allow-remote=all --ignore-scripts --registry=https://registry.npmjs.org
```

The command-scoped `--allow-remote=all` permits the verified archive URL during publication without changing persistent configuration. npm 12.0.2 treats the publication archive fetch as non-root, so `--allow-remote=root` fails with `EALLOWREMOTE` even for this explicit URL. This command publishes one reviewed archive; it does not install its dependency tree. Keep the exact HTTPS URL and scope this option to the publication command. The installation examples use their own narrower URL policy.

`--ignore-scripts` disables lifecycle scripts for this publication; the archive has already been built and tested. Complete any required npm account authentication for the publication. Add `--browser=false` when printing a manual authentication link is preferable to opening a browser. Do not change the input to a local path when retrying.

## Verify the public result

Read the unauthenticated public version metadata after npm reports success. Replace `<VERSION>` with the published version. This check reports unexpected source fields without printing their potentially private values:

```sh
node --input-type=module -e "const v = '<VERSION>'; const r = await fetch('https://registry.npmjs.org/failtrace/' + v); if (!r.ok) throw new Error('HTTP ' + r.status); const p = await r.json(); const expected = 'https://github.com/LBarimi/FailTrace/releases/download/v' + v + '/failtrace-' + v + '.tgz'; for (const k of ['_from', '_resolved']) if (p[k] !== undefined && p[k] !== expected) throw new Error('Review unexpected source field: ' + k); console.log(JSON.stringify({name:p.name, version:p.version, mcpName:p.mcpName, sourceFieldsVerified:true}));"
```

- Confirm the package name, version, and `mcpName` match the reviewed release.
- Inspect `_from`, `_resolved`, and the full metadata locally for local filesystem paths. Source fields should be absent or identify the verified public HTTPS archive, without credentials or machine directories. Keep raw inspection output out of public logs.
- Download `dist.tarball` without authentication. Verify its `dist.integrity` and confirm its SHA-256 matches the reviewed GitHub archive. Preserve the release commit, CI run, public URLs, and digests as release evidence.
- Install the exact npm version in a separate temporary project with a fresh cache. Check the installed version, run the demo, replay its bundle, and verify the installed MCP tools as appropriate. A successful publication response alone is not an installation check.

After these checks, the existing [MCP Registry workflow](https://github.com/LBarimi/FailTrace/blob/main/.github/workflows/mcp-registry.yml) can publish the matching server metadata; it independently requires the exact public npm version and successful CI.

This procedure prevents local archive inputs in future publications. It does not remove metadata from versions already published. Treat any existing exposure as a separate registry issue and report only removal that has been verified publicly.

[Documentation index](README.md)
