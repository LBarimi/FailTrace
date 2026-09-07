# Third-party notices

FailTrace's own code is covered by [LICENSE](LICENSE). Its runtime dependencies retain their respective licenses and copyright notices. The complete notices linked below are included in the npm package and GitHub release archive.

This inventory covers the direct and transitive runtime versions reviewed in the release lockfile. npm installs these dependencies separately; installations may resolve newer compatible versions, whose own notices also apply.

| Package | Reviewed version | License information | Notice and origin |
| --- | --- | --- | --- |
| @modelcontextprotocol/core | 2.0.0 | MIT / Apache-2.0 transition; documentation CC-BY-4.0 | [Full notice](docs/licenses/mcp-sdk.txt) · [Source](https://registry.npmjs.org/@modelcontextprotocol/core/-/core-2.0.0.tgz) |
| @modelcontextprotocol/server | 2.0.0 | MIT / Apache-2.0 transition; documentation CC-BY-4.0 | [Full notice](docs/licenses/mcp-sdk.txt) · [Source](https://registry.npmjs.org/@modelcontextprotocol/server/-/server-2.0.0.tgz) |
| saxes | 6.0.0 | ISC (with historical notices) | [Full notice](docs/licenses/saxes.txt) · [Source](https://github.com/lddubeau/saxes/blob/v6.0.0/LICENSE) |
| xmlchars | 2.2.0 | MIT | [Full notice](docs/licenses/xmlchars.txt) · [Source](https://registry.npmjs.org/xmlchars/-/xmlchars-2.2.0.tgz) |
| zod | 4.5.4 | MIT | [Full notice](docs/licenses/zod.txt) · [Source](https://registry.npmjs.org/zod/-/zod-4.5.4.tgz) |

The MCP SDK notice contains its MIT-to-Apache-2.0 transition terms and documentation licensing. Preserve the entire notice; the package metadata's MIT label alone does not describe it fully. Both SDK packages use the same notice.

The saxes notice comes from its version 6.0.0 source tag because that npm archive omits the license file. Its complete upstream notice, including inherited and historical notices, is preserved here.

## Development tools

TypeScript, Vitest, Node.js type definitions and the MCP test client are development dependencies. The optional image renderer is a maintainer tool. Their code and installed dependency directories are not included in the FailTrace release archive. Preserve their licenses if redistributing those tools separately.

## Updating this inventory

When runtime dependencies change, review their exact distributed license and NOTICE files, retain the applicable texts in docs/licenses, and update the versions, source links and SHA-256 digests in [the manifest](docs/licenses/manifest.json). Do not infer a license solely from package metadata. Run node scripts/check-licenses.mjs --write to regenerate this index, then npm run check:licenses and npm run test:package. These checks cover the inventory and shipped notice files; they do not replace review of changed upstream terms.
