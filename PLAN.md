# NanoClaw Calendar — Project Plan

## Goal

Personal assistant on a Raspberry Pi 5 that syncs with Notion (school assignments) and maintains a local todo list (personal tasks). Accessible via WhatsApp.

## Data Model

### `todos` table (add to `src/db.ts`)

```sql
CREATE TABLE todos (
  id TEXT PRIMARY KEY,                  -- Notion page ID, or UUID for local-only

  -- Core
  title TEXT NOT NULL,
  notes TEXT,
  status TEXT DEFAULT 'todo',           -- 'todo' | 'in_progress' | 'done' | 'cancelled'
  completed_at TEXT,

  -- Timing
  due_date TEXT,                        -- ISO date (YYYY-MM-DD), the hard deadline
  scheduled_time TEXT,                  -- ISO datetime, when it's planned (null = unscheduled)
  flexible INTEGER DEFAULT 1,           -- 1 = soft intention, 0 = hard appointment (never move)
  estimated_minutes INTEGER,            -- effort estimate for schedule optimization

  -- Classification
  category TEXT,                        -- 'school' | 'errand' | 'personal' | 'health' | etc.
  course TEXT,                          -- school only (e.g. 'COMP 101')
  tags TEXT,                            -- JSON array e.g. '["campus","urgent"]'
  location TEXT,                        -- for errands (e.g. 'grocery store')

  -- Priority & effort
  priority TEXT DEFAULT 'medium',       -- 'low' | 'medium' | 'high'
  energy_level TEXT,                    -- 'low' | 'medium' | 'high' — focus required

  -- Notion sync
  notion_id TEXT UNIQUE,                -- Notion page ID (null if local-only)
  notion_synced INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_todos_due_date ON todos(due_date);
CREATE INDEX idx_todos_status ON todos(status);
CREATE INDEX idx_todos_notion_id ON todos(notion_id);
```

**`due_date` vs `scheduled_time`:** deadline vs when you plan to do it. A task can be unscheduled but still have a deadline. `flexible=0` = fixed appointment, never move it during optimization. This separation makes schedule optimization tractable.

**`energy_level`:** high-energy tasks (essays, problem sets) get morning slots; low-energy ones (admin, errands) fill in wherever.

**`recurrence` is intentionally omitted.** NanoClaw already has a `scheduled_tasks` table with full cron support. A recurring todo is a scheduled task that creates a new `todos` row on each run — no need to duplicate that infrastructure here.

### Field Tiers (for agent behaviour)

| Tier | Fields | Agent behaviour |
|------|--------|-----------------|
| **Auto** | `status`, `flexible`, `priority`, `created_at`, `notion_synced` | Fill with defaults, never ask |
| **Infer** | `due_date`, `course`, `category`, `energy_level`, `location` | Extract from message if possible, leave null if not — don't ask |
| **Ask if missing and it matters** | `title` (always required), `scheduled_time` + time (if it sounds like an appointment), `category` (if ambiguous, because it drives the Notion decision) | Ask, but batch all questions in one message |

Rule: only ask if the missing value materially changes what gets written. Batch all clarifying questions into a single message, never one at a time.

### Notion-Mapped vs Local-Only Fields

| Notion-mapped | Local-only |
|---------------|------------|
| `title`, `due_date`, `status`, `course`, `notion_id` | `scheduled_time`, `flexible`, `estimated_minutes`, `energy_level`, `location`, `tags`, `priority`, `notes` |

When syncing from Notion, **only overwrite Notion-mapped fields.** Never touch local-only fields — they may have been enriched manually and Notion has no knowledge of them.

### Source of Truth

| Origin | School? | Notion | Local DB |
|--------|---------|--------|----------|
| Notion sync | Yes | ✓ | ✓ (upsert by notion_id) |
| WhatsApp message | Yes | ✓ (agent creates page) | ✓ |
| WhatsApp message | No | ✗ | ✓ |

Notion = source of truth for school. Local DB = source of truth for personal.

## Notion Integration

- Use `@notionhq/notion-mcp-server` inside agent container
- Add to `container/agent-runner/package.json`
- Store Notion token + database ID in a config file outside `.env` (e.g. `~/.config/nanoclaw/notion.json`)
- Mount that config into the container in `buildVolumeMounts` in `container-runner.ts`
- Register as MCP server in agent-runner config
- **No re-auth per container.** Notion uses a static integration token — read from the mounted config file at startup, never expires unless revoked.

## Sync Architecture

### Core principle: only fetch what changed

Notion's API supports filtering pages by `last_edited_time`. Store the last successful sync timestamp in NanoClaw's existing `router_state` table (key: `notion_last_sync_at`). On each sync run, only fetch pages edited after that timestamp. On a quiet day this is a single API call returning zero results — effectively free.

### 12-hour incremental sync (the common path)

```
1. Read notion_last_sync_at from router_state
2. Query Notion: pages where last_edited_time > notion_last_sync_at
3. If empty → update notion_last_sync_at to now, done
4. For each changed page:
   a. notion_id already in local DB → compare Notion-mapped fields, UPDATE only what changed
   b. notion_id not in local DB → INSERT with Notion fields; local-only fields = NULL
5. Update notion_last_sync_at to now
```

Step 4a compares field-by-field before writing — avoids unnecessary DB writes and never clobbers local enrichment.

### Handling unsynced local items (school todos added via WhatsApp)

The agent creates the Notion page immediately during the conversation and sets `notion_id` on the local row. If that API call fails, the row lands with `notion_synced=0` and no `notion_id`. The sync job catches these as a fallback:

```
Any row where category='school' AND notion_id IS NULL → push to Notion, set notion_id
```

### Weekly full sync (deletions)

Incremental sync can't detect deletions (archived Notion pages won't appear in `last_edited_time` queries). Once a week, fetch all page IDs from Notion and mark any local rows whose `notion_id` is no longer present as `status='cancelled'`. Keep this separate from the 12-hour job.

### Handling NULLs in queries

Optimization queries handle NULLs explicitly rather than enforcing at schema level:
- No `estimated_minutes` → exclude from "fit tasks into N minutes" queries, still show in deadline queries
- No `energy_level` → treat as 'medium'
- No `scheduled_time` → treat as unscheduled/flexible

## Agent Instructions (`groups/global/CLAUDE.md`)

```markdown
## Todo Management

Local `todos` table in SQLite at /workspace/project/store/messages.db.
Notion database ID: <id>
Courses: <list your courses>

Rules:
- School assignments → write to Notion AND local todos (agent creates Notion page immediately)
- Personal todos → local todos only, never Notion
- Notion syncs every 12 hours; treat it as source of truth for school items
- When syncing from Notion, never overwrite: scheduled_time, flexible, estimated_minutes,
  energy_level, location, tags, priority, notes

Field tiers:
- Auto (never ask): status='todo', flexible=1, priority='medium'
- Infer silently: due_date, course, category, energy_level, location
- Ask if missing and matters: title, scheduled_time (if appointment), category (if ambiguous)
- Batch all clarifying questions into one message

Useful queries:
  Due this week:  SELECT * FROM todos WHERE status='todo' AND due_date BETWEEN date('now') AND date('now','+7 days') ORDER BY due_date;
  Overdue:        SELECT * FROM todos WHERE status='todo' AND due_date < date('now');
  Unscheduled:    SELECT * FROM todos WHERE status='todo' AND scheduled_time IS NULL ORDER BY priority DESC, due_date;
```

## Known Gaps & Constraints

### Agent can't write SQLite directly
The project root is mounted **read-only** into containers, so `store/messages.db` is not writable from inside a container. The IPC system (currently handles `messages/` and `tasks/` subdirs) needs a `todos/` subdirectory added so containers can request todo writes. The host process executes the actual SQL.

For the sync job specifically (no Claude needed — it's deterministic ETL), run it as a host-side Node.js script on a timer rather than a container task. Faster, simpler, no container overhead.

### `id` is always a local UUID
`id` is always a locally-generated UUID. `notion_id` is always the Notion page ID. Never use the Notion page ID as the primary key — at INSERT time (local creation) you don't have the Notion page ID yet. The flow is: INSERT with UUID → create Notion page → set `notion_id` on the local row.

### Cold start sync
On first run, `notion_last_sync_at` doesn't exist in `router_state`. The sync script must detect this and perform a full fetch of all Notion pages before setting the cursor.

### Notion schema alignment
The Notion MCP server maps by property name. Document your exact Notion DB property names before writing sync code — mismatches produce silent nulls. Agree on a canonical set: e.g. `Name` (title), `Due`, `Course`, `Status`.

### Pagination
Notion returns max 100 pages per request (cursor-based). The 12-hour incremental sync likely won't hit this. The weekly full sync must loop until `has_more = false`.

### Sync cursor safety
Update `notion_last_sync_at` only after the entire batch completes successfully. A partial failure should leave the cursor unchanged so the next run retries from the same point.

### Timezone
SQLite `date('now')` uses the process timezone. Set `TZ=Your/Timezone` in `.env`. NanoClaw already reads this in `config.ts`. Without it, deadline queries will be off by your UTC offset.

## Implementation Order

1. Add `todos` migration + indexes to `src/db.ts`
2. Add todo CRUD functions to `src/db.ts`
3. Extend IPC watcher (`src/ipc.ts`) with `todos/` subdirectory handling
4. Write host-side sync script (`src/notion-sync.ts`)
5. Register sync on a timer in `src/index.ts`
6. Add Notion MCP server to container, mount config file
7. Write `groups/global/CLAUDE.md` with rules, schema, course list
8. Set `TZ` in `.env`
9. Deploy: git clone on Pi, `npm install`, `./container/build.sh`, `.env`, WhatsApp QR scan


## Mac → Pi Deployment Notes

- Develop entirely on Mac, push to git, pull on Pi
- Apple Silicon Docker builds `arm64` → directly compatible with Pi 5 (can `docker save`/`docker load` to skip Pi rebuild)
- WhatsApp session **cannot** transfer — fresh QR scan required on Pi (~2 min)
- `.env` must be recreated on Pi (same values, not in git)
- Session reuse is automatic (built into `src/db.ts` via `sessions` table) — no config needed

## Security

### HTTP Exposure
None needed. NanoClaw is outbound-only (WhatsApp WebSocket, Anthropic API). The credential proxy (port 3001) already binds to the `docker0` bridge IP on Linux — only containers can reach it, nothing external. No router port forwarding required.

### SSH / Remote Access
- **Tailscale** — install on Pi + Mac/phone; gives Pi a stable private IP (`100.x.x.x`), zero port forwarding, free for personal use
- SSH key-only auth: set `PasswordAuthentication no`, `PermitRootLogin no` in `/etc/ssh/sshd_config`
- UFW: `deny incoming` by default, `allow in on tailscale0`

### SQLite
- Run nanoclaw as a dedicated non-root user: `sudo useradd -r nanoclaw && sudo usermod -aG docker nanoclaw`
- `chmod 600 store/messages.db && chown nanoclaw:nanoclaw store/`
- Containers already mount project root read-only — agents can't write the DB directly
- Add a cron backup: `sqlite3 store/messages.db ".backup store/messages.db.bak"`
- WAL mode in `src/db.ts` (safer for concurrent reads during backup)

### Already Handled by the Codebase
- `.env` shadowed with `/dev/null` inside containers
- Sender allowlist controls who can trigger the agent
- Mount allowlist prevents arbitrary container mounts

## Future Ideas

### Queries & Summaries
- "What do I have due this week?" — query by `due_date` range
- "What can I get done in 2 hours?" — filter by `estimated_minutes`, exclude `flexible=0` fixed slots
- "What's overdue?" — `due_date < today AND status != 'done'`
- Morning briefing scheduled task — daily digest of what's due soon

### Schedule Optimization
- Given fixed appointments (`flexible=0`, `scheduled_time` set) as anchors, fill remaining time with flexible tasks ranked by priority + deadline proximity + energy level
- Produce a suggested day plan on request
- "I have 90 free minutes this afternoon, what should I work on?"

### Recurring Tasks
- Implement as NanoClaw scheduled tasks that INSERT a new `todos` row on each run
- Good for: weekly readings, recurring lab reports, gym, etc.

### Reminders
- Scheduled tasks via IPC that fire X hours before a deadline
- "Remind me about COMP 101 lab the day before it's due"

### Marking Done
- "Done with COMP 101 lab" → sets `status='done'`, `completed_at=now`, updates Notion page if `notion_id` set
- Batch: "mark everything from today as done"

### Location-Aware Errands
- Group errands by location: "what errands do I have near campus?"

### Dependencies (stretch)
- `blocked_by TEXT` — another todo's ID
- Prevents scheduling a task before its dependency is done
