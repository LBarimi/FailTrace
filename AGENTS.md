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
- Prioritize adoption over feature count. The six initial milestones are implemented; current work should help real developers and coding agents install, try, integrate, and repeatedly use them.
- Before adding a major feature, identify the recognizable debugging problem, the evidence it matters to users, and how it improves adoption. Prefer a faster first success, reliable integration, and useful demos over speculative capabilities.
- Keep install instructions executable against an actually available package or source revision. Verify the installed artifact outside this checkout, not just the source build. Do not present stars, downloads, or green tests as proof of active use.
- Publish npm releases from the verified public GitHub release HTTPS tarball URL, never a local archive path; preserve the reviewed archive and digests, keep the existing CI gates, and verify public registry metadata after publication as described in `docs/RELEASING.md`.
- Do not add SaaS, cloud, database, authentication, telemetry, AI API, or LLM SDK functionality.

## Layout

- `src/core`: execution, orchestration, statistics, artifacts, and public types.
- `src/cli`: argument parsing and terminal presentation only.
- `src/mcp`: official MCP SDK adapter; algorithms must stay in Core. Reserve stdout for protocol messages.
- `tests`: deterministic unit and integration tests; no external network calls.
- `examples`: small runnable demonstrations.

CLI and future adapters depend on Core. Important behavior belongs in Core, independently of terminal output and process-global signal listeners.

See `docs/ADOPTION.md` for the adoption objective, baseline, and evidence-driven priorities. Do not add telemetry or contact other projects on the user's behalf without explicit authorization.
