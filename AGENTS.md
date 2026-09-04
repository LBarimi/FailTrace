# Working on FailTrace

- Read README.md and this file before changing code.
- Use strict TypeScript and Node.js built-ins where sufficient. Avoid unnecessary dependencies.
- Keep the reusable engine in `src/core`. Core must never import CLI or MCP code.
- Prefer small modules, explicit data structures, and narrow changes. Do not add speculative factories, adapters, inheritance, or plugin frameworks.
- Add or update deterministic tests for behavioral changes. Treat target-command failures as data, not application crashes.
- Before completing work, run `npm test`, `npm run typecheck`, and `npm run build`; manually exercise user-visible CLI changes.
- Preserve Windows, macOS, and Linux compatibility, especially shell quoting, paths, signals, and process-tree cleanup.
- Update README.md when user-visible behavior changes. Never advertise planned features as implemented.
- Keep generated FailTrace artifacts inside `.failtrace/` by default. Never overwrite unrelated project files.
- Work only on requested milestones. Milestones 1–6 are currently authorized: repetition, failure predicates/comparison, regression isolation, minimization, reproduction bundles, and a thin MCP adapter.
- Do not add SaaS, cloud, database, authentication, telemetry, AI API, or LLM SDK functionality.

## Layout

- `src/core`: execution, orchestration, statistics, artifacts, and public types.
- `src/cli`: argument parsing and terminal presentation only.
- `src/mcp`: official MCP SDK adapter; algorithms must stay in Core. Reserve stdout for protocol messages.
- `tests`: deterministic unit and integration tests; no external network calls.
- `examples`: small runnable demonstrations.

CLI and future adapters depend on Core. Important behavior belongs in Core, independently of terminal output and process-global signal listeners.
