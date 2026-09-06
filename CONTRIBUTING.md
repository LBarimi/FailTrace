# Contributing to FailTrace

Help a developer or coding agent turn a difficult failure into useful evidence. A reproducible bug report, a clearer installation step, or a small original reproducer can be more valuable than another feature.

## Try it, then tell us what happened

Start with the README quick start and `failtrace demo`. Then try a command from your own project with a small repeat count and a specific failure predicate. Open a **Debugging workflow report** to tell us what helped, where you got stuck, or what your coding agent could not use. Reports are optional; do not attach private logs or secrets.

For a bug, include your OS, Node.js version, FailTrace version, exact command, expected behavior, and a small fixture when possible. Preserve the target exit code and predicate: a target failing is expected behavior, while missing evidence or an incorrect conclusion is a FailTrace bug.

## Development

Requires Node.js 22.12+ and Git.

```sh
git clone https://github.com/LBarimi/FailTrace.git
cd FailTrace
npm ci
npm run build
node dist/cli/index.js demo
npm run typecheck
npm run check:docs
npm test
npm run test:package
```

The package check installs the packed artifact in a temporary directory and exercises its public entry points. CI runs on Windows, macOS, and Linux with Node.js 22 and 24.

Read the repository's [AGENTS.md](https://github.com/LBarimi/FailTrace/blob/main/AGENTS.md) for repository conventions. Put algorithms in `src/core`; CLI, demos, and MCP call Core. Use deterministic fixtures and inspectable evidence. Keep temporary output in `.failtrace/` or ignored test directories. Avoid global configuration changes in tests.

## Choose a useful contribution

- Reproduce and fix a reported first-install, process cleanup, or artifact problem.
- Improve an agent setup recipe against the client's official documentation.
- Add a small original example that shows a failure being isolated or reduced.
- Improve an error that leaves a new user unsure what to do next.

Discuss substantial features in an issue first. Describe the user's debugging task, the current workaround, and why the existing operations are insufficient. We prioritize adoption and integration over feature count.

## Pull requests

Explain the concrete problem and resulting behavior. Include a command or fixture that demonstrates the result, relevant tests, and any OS limitations. Keep changes focused and update the user-facing documentation. Do not include generated investigations, credentials, or private project data.

Contributions are made under the repository's [MIT license](LICENSE).
