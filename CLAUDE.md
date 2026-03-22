# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Error Handling

Failures should be visible to the user, not silently swallowed into logs.

**Prefer notifying the user over silent failure.** If a scheduled task fails, an IPC operation is rejected, or a send fails, send a WhatsApp/channel message explaining what went wrong so the user can act on it. Wrap each notification call in its own try-catch so a failed notification doesn't mask the original error.

**Retry when the operation is stateless and idempotent.** Network hiccups and transient errors are good candidates. Do not retry operations that carry side effects (e.g. sending a message) — retrying those risks duplicates.

**Never let failures crash the process.** The host is a long-running daemon. Catch errors at subsystem boundaries (scheduler loop, IPC watcher, message loop) and log them, then continue. Only call `process.exit` for truly unrecoverable startup failures.

**Log everything, but surface actionable errors to the user.** `logger.error` / `logger.warn` for internal detail; a plain-language channel message for anything the user needs to know about or can fix.

## Testing

All new features must include tests. Run the suite with `npm test`.

Tests live in `src/**/*.test.ts` and `setup/**/*.test.ts` (picked up automatically by vitest).

**Norms:**
- Import `describe`, `it`, `expect`, `beforeEach` explicitly from `'vitest'` — globals are not enabled
- Use `.js` extensions on all local imports (e.g. `'./db.js'`)
- Reset state in a global `beforeEach` at the top of each test file (e.g. `_initTestDatabase()`)
- One `describe` block per function; test names use imperative verbs ("stores a message", "returns undefined for unknown id")
- Assertions: prefer `.toBe()` for primitives, `.toEqual()` for objects/arrays, `.toBeUndefined()` / `.toBeDefined()` for presence checks
- Add a helper function (e.g. `makeTodo()`, `store()`) to reduce fixture boilerplate — see existing examples in `src/db.test.ts`
- Test the happy path, optional fields being absent, and key edge cases (nulls, empty inputs, no-ops)
- SQLite nullable columns come back as `null` — db layer functions should convert these to `undefined` so return types match TypeScript interfaces

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
