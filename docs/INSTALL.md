# Install FailTrace

Requires Node.js **22.12+** and npm. The published version used here is **1.4.1**. Review the [1.4.1 changes](../CHANGELOG.md#141) and [compatibility notes](COMPATIBILITY.md) when upgrading.

## Try without a global install

```sh
npx --yes failtrace@1.4.1 demo
```

This does not put a permanent `failtrace` command on your shell's PATH. Continue using `npx --yes failtrace@1.4.1 <command>`, or choose an installation below. npm can download the package on first use; subsequent invocations normally use its cache.

## Install for a project

```sh
npm install --save-dev failtrace@1.4.1
npx failtrace demo
```

Keep the dependency and lockfile with your project. Target commands need their own dependencies and setup. The project itself need not use JavaScript.

For an existing npm project, [name the baseline and verification actions](PROJECT-WORKFLOW.md) to reuse the same conditions without retyping the flags.

## Install globally

```sh
npm install --global failtrace@1.4.1
failtrace demo
```

For native Windows applications that do not resolve npm's shims automatically, use `failtrace.cmd` or `npx.cmd`. Shell syntax inside a target command remains platform-specific.

## Connect an AI coding agent

The CLI and MCP server ship in the same package. Follow the [MCP client setup guide](AGENT-WORKFLOWS.md). The configured client launches the stdio server; directly running `failtrace mcp` waits for protocol messages.

## GitHub release alternative

The verified [v1.4.1 archive and checksum](https://github.com/LBarimi/FailTrace/releases/tag/v1.4.1) include compiled code:

```sh
npm exec --yes --allow-remote=root --package=https://github.com/LBarimi/FailTrace/releases/download/v1.4.1/failtrace-1.4.1.tgz -- failtrace demo
```

The command-scoped `--allow-remote=root` permits the explicitly requested URL on npm 12. Registry installation does not need this flag, and the command does not change npm's persistent configuration. Older npm versions that do not recognize it can omit it. See [npm's URL install policy](https://docs.npmjs.com/using-npm/config/#allow-remote).

Before upgrading an existing integration, read the [compatibility contract](COMPATIBILITY.md) and [migration guide](MIGRATING-TO-1.md).

[Documentation index](README.md)
