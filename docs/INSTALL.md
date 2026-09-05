# Install FailTrace

Requires Node.js **22.12+** and npm. The published version used here is **1.0.0**. Unreleased source changes are described separately in the [changelog](../CHANGELOG.md#unreleased).

## Try without a global install

```sh
npx --yes failtrace@1.0.0 demo
```

This does not put a permanent `failtrace` command on your shell's PATH. Continue using `npx --yes failtrace@1.0.0 <command>`, or choose an installation below. npm can download the package on first use; subsequent invocations normally use its cache.

## Install for a project

```sh
npm install --save-dev failtrace@1.0.0
npx failtrace demo
```

Keep the dependency and lockfile with your project. Target commands need their own dependencies and setup. The project itself need not use JavaScript.

## Install globally

```sh
npm install --global failtrace@1.0.0
failtrace demo
```

For native Windows applications that do not resolve npm's shims automatically, use `failtrace.cmd` or `npx.cmd`. Shell syntax inside a target command remains platform-specific.

## Connect an AI coding agent

The CLI and MCP server ship in the same package. Follow the [Codex, Claude Code, Cursor, and generic MCP setup guide](AGENT-WORKFLOWS.md). The configured client launches the stdio server; directly running `failtrace mcp` waits for protocol messages.

## GitHub release alternative

The verified [v1.0.0 archive and checksum](https://github.com/LBarimi/FailTrace/releases/tag/v1.0.0) include compiled code:

```sh
npm exec --yes --allow-remote=root --package=https://github.com/LBarimi/FailTrace/releases/download/v1.0.0/failtrace-1.0.0.tgz -- failtrace demo
```

The command-scoped `--allow-remote=root` permits the explicitly requested URL on npm 12. Registry installation does not need this flag, and the command does not change npm's persistent configuration. Older npm versions that do not recognize it can omit it. See [npm's URL install policy](https://docs.npmjs.com/using-npm/config/#allow-remote).

Before upgrading an existing integration, read the [compatibility contract](COMPATIBILITY.md) and [migration guide](MIGRATING-TO-1.md).
