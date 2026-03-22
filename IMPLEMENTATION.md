# Implementation Guide

Step-by-step implementation of the NanoClaw calendar/todo system. Follow in order — each step builds on the previous.

---

## Step 1 — `todos` table migration (`src/db.ts`)

Add the table inside `createSchema()` alongside the existing tables:

```typescript
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT,
  status TEXT DEFAULT 'todo',
  completed_at TEXT,
  due_date TEXT,
  scheduled_time TEXT,
  flexible INTEGER DEFAULT 1,
  estimated_minutes INTEGER,
  category TEXT,
  course TEXT,
  tags TEXT,
  location TEXT,
  priority TEXT DEFAULT 'medium',
  energy_level TEXT,
  notion_id TEXT UNIQUE,
  notion_synced INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_todos_due_date ON todos(due_date);
CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_notion_id ON todos(notion_id);
```

Also add CRUD functions to `src/db.ts`:

```typescript
// types: define Todo interface in src/types.ts matching the schema

export function createTodo(todo: Omit<Todo, 'created_at' | 'updated_at'>): void
export function updateTodo(id: string, fields: Partial<Todo>): void
export function getTodoById(id: string): Todo | undefined
export function getTodoByNotionId(notionId: string): Todo | undefined
export function getRouterState(key: string): string | undefined
export function setRouterState(key: string, value: string): void
// getRouterState/setRouterState may already exist — check first
```

`updateTodo` should always set `updated_at = datetime('now')` on every write.

---

## Step 2 — Extend IPC for todo writes (`src/ipc.ts`)

Containers can't write to SQLite directly (project root is read-only). Add a `todos/` subdirectory to the IPC namespace, parallel to the existing `messages/` and `tasks/` directories.

**IPC file format** (container writes to `/workspace/ipc/{group}/todos/{uuid}.json`):

```json
// create
{ "type": "create_todo", "payload": { "id": "uuid", "title": "...", ... } }

// update
{ "type": "update_todo", "id": "existing-uuid", "payload": { "status": "done", "completed_at": "2026-03-22T14:00:00" } }
```

In `startIpcWatcher`, add a `todosDir` block parallel to the existing `messagesDir` and `tasksDir` blocks:

```typescript
const todosDir = path.join(ipcBaseDir, sourceGroup, 'todos');
// read *.json files, call processTodoIpc(data, sourceGroup, isMain), unlink on success
```

Add `processTodoIpc`:
- `create_todo` → validate required fields (`id`, `title`), call `createTodo()`
- `update_todo` → validate `id` exists, call `updateTodo()`
- Authorization: any group can write its own todos; main can write for any group

**Key consideration:** The container needs to generate the UUID itself (not rely on the host) so it can immediately reference the todo in its response before the IPC file is processed. Use `crypto.randomUUID()` inside the container.

---

## Step 3 — Notion MCP server in container

### 3a. Add to container dependencies

In `container/agent-runner/package.json`, add:
```json
"@notionhq/notion-mcp-server": "latest"
```

### 3b. Config file

Create `~/.config/nanoclaw/notion.json` on the host (never in the repo):
```json
{
  "token": "secret_...",
  "databaseId": "your-notion-database-id"
}
```

Notion setup:
1. Go to notion.so/my-integrations → create integration → copy token
2. Open your assignments database in Notion → "..." menu → "Add connections" → select your integration
3. Copy the database ID from the URL: `notion.so/{workspace}/{DATABASE_ID}?v=...`

### 3c. Mount config into containers

In `src/container-runner.ts`, inside `buildVolumeMounts`, add:
```typescript
const notionConfigPath = path.join(os.homedir(), '.config', 'nanoclaw', 'notion.json');
if (fs.existsSync(notionConfigPath)) {
  mounts.push({
    hostPath: notionConfigPath,
    containerPath: '/workspace/config/notion.json',
    readonly: true,
  });
}
```

### 3d. Register MCP server in agent-runner

In `container/agent-runner/src/index.ts`, register the Notion MCP server so it's available as a tool. The exact registration depends on the Claude Agent SDK version — follow the pattern of any existing MCP server registrations in that file.

Pass the config path and token to the server via the mounted file at `/workspace/config/notion.json`.

### 3e. Align with your Notion database schema

Before writing any sync code, open your Notion database and document the exact property names. Example:

| Notion property | Local field |
|----------------|-------------|
| `Name` | `title` |
| `Due` | `due_date` |
| `Course` | `course` |
| `Status` | `status` |

Hardcode these mappings in the sync script. Mismatches produce silent nulls.

---

## Step 4 — Host-side sync script (`src/notion-sync.ts`)

The sync runs on the host (not in a container) — it's deterministic ETL, no Claude needed. Faster and simpler.

### Structure

```typescript
import { Client } from '@notionhq/client';  // add to main package.json

export async function runIncrementalSync(): Promise<void>
export async function runFullSync(): Promise<void>
```

### `runIncrementalSync` logic

```
1. cursor = getRouterState('notion_last_sync_at')  // may be null on cold start
2. if cursor is null → call runFullSync() instead, return
3. pages = fetchNotionPages({ last_edited_time: { after: cursor } })
4. if pages.length === 0 → setRouterState('notion_last_sync_at', now), return
5. for each page:
   a. map Notion properties → local fields (title, due_date, status, course, notion_id)
   b. existing = getTodoByNotionId(page.id)
   c. if existing:
      - compare only Notion-mapped fields
      - if any differ → updateTodo(existing.id, changedFields)
      - never touch: scheduled_time, flexible, estimated_minutes, energy_level,
                     location, tags, priority, notes
   d. if not existing → createTodo({ id: randomUUID(), notion_id: page.id, ...mapped })
6. setRouterState('notion_last_sync_at', now)  // only on full success
```

**Critical:** step 6 runs only after the loop completes. If an error is thrown mid-loop, the cursor does not advance and the next run retries from the same point.

### `runFullSync` logic

```
1. fetch ALL pages from Notion database (paginate until has_more = false)
2. upsert each page (same mapping logic as above)
3. for weekly deletion detection:
   - collect all notion_ids returned by Notion
   - UPDATE todos SET status='cancelled'
     WHERE notion_id IS NOT NULL AND notion_id NOT IN (returned ids) AND status != 'done'
4. setRouterState('notion_last_sync_at', now)
```

### Pagination loop

```typescript
let cursor: string | undefined;
const pages = [];
do {
  const response = await notion.databases.query({
    database_id: databaseId,
    start_cursor: cursor,
    filter: lastEditedAfter ? { ... } : undefined,
  });
  pages.push(...response.results);
  cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
} while (cursor);
```

---

## Step 5 — Register sync timers (`src/index.ts`)

Add two timers after the main service starts:

```typescript
// 12-hour incremental sync
setInterval(() => runIncrementalSync().catch(err =>
  logger.error({ err }, 'Notion incremental sync failed')
), 12 * 60 * 60 * 1000);

// Weekly full sync (for deletion detection)
setInterval(() => runFullSync().catch(err =>
  logger.error({ err }, 'Notion full sync failed')
), 7 * 24 * 60 * 60 * 1000);

// Run incremental sync immediately on startup (handles cold start via null cursor check)
runIncrementalSync().catch(err => logger.error({ err }, 'Notion startup sync failed'));
```

Running `runIncrementalSync` on startup handles the cold start: if `notion_last_sync_at` is null it delegates to `runFullSync`, setting the cursor for the first time.

---

## Step 6 — Agent instructions (`groups/global/CLAUDE.md`)

```markdown
## Todo Management

SQLite todos table at /workspace/project/store/messages.db.
Notion database ID: <your-id> (for reference only — use MCP tools to interact with Notion)

### Notion property → local field mapping
| Notion | Local |
|--------|-------|
| Name   | title |
| Due    | due_date (YYYY-MM-DD) |
| Course | course |
| Status | status ('todo'/'done') |

### Rules
- School assignments → write to Notion (MCP tool) AND request local todo via IPC
- Personal todos → IPC only, never Notion
- Notion syncs every 12h automatically; treat it as source of truth for school items
- When a school assignment is marked done → update Notion page status AND local todo status

### Field inference tiers
- Auto (never ask): status='todo', flexible=1, priority='medium'
- Infer silently from message: due_date, course, category, energy_level, location
- Ask if missing and matters: title (always), scheduled_time+time (if appointment),
  category (if ambiguous — determines whether Notion is written)
- Batch all clarifying questions into ONE message, never one at a time

### IPC format for todo writes
Write JSON to /workspace/ipc/{group_folder}/todos/{uuid}.json

Create:
{ "type": "create_todo", "payload": { "id": "<uuid>", "title": "...", <other fields> } }

Update:
{ "type": "update_todo", "id": "<existing-uuid>", "payload": { "status": "done", "completed_at": "<iso>" } }

Generate the UUID yourself with crypto.randomUUID().

### Useful queries (read-only via sqlite3 or bash)
Due this week:
  SELECT title, due_date, course, priority FROM todos
  WHERE status='todo' AND due_date BETWEEN date('now') AND date('now','+7 days')
  ORDER BY due_date;

Overdue:
  SELECT title, due_date, course FROM todos
  WHERE status='todo' AND due_date < date('now');

Unscheduled flexible tasks:
  SELECT title, due_date, estimated_minutes, energy_level FROM todos
  WHERE status='todo' AND scheduled_time IS NULL AND flexible=1
  ORDER BY priority DESC, due_date;

Fit into N minutes:
  SELECT title, estimated_minutes, energy_level FROM todos
  WHERE status='todo' AND flexible=1 AND estimated_minutes IS NOT NULL
  AND estimated_minutes <= <N>
  ORDER BY priority DESC, due_date;
```

---

## Step 7 — Environment & timezone

In `.env`:
```
TZ=America/Your_Timezone   # e.g. America/Toronto, Europe/London
ASSISTANT_NAME=YourName
ANTHROPIC_API_KEY=sk-...
```

Confirm the Pi's system timezone matches:
```bash
sudo timedatectl set-timezone America/Your_Timezone
```

SQLite's `date('now')` uses the process timezone. Without `TZ` set correctly, "due today" queries will be off by your UTC offset.

---

## Step 8 — Pi deployment

```bash
# On Pi
git clone <your-repo> nanoclaw
cd nanoclaw
npm install

# Build container image (arm64 native on Pi 5)
./container/build.sh

# Create .env (copy values from Mac, update TZ)
cp .env.example .env
nano .env

# Set file permissions
sudo useradd -r -s /bin/false nanoclaw
sudo usermod -aG docker nanoclaw
sudo chown -R nanoclaw:nanoclaw .
chmod 700 store/

# Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# UFW
sudo ufw default deny incoming
sudo ufw allow in on tailscale0
sudo ufw enable

# SSH hardening
sudo nano /etc/ssh/sshd_config
# set: PasswordAuthentication no, PermitRootLogin no
sudo systemctl restart ssh

# Start NanoClaw
npm run build
systemctl --user start nanoclaw   # or launchctl on macOS
```

Then from your main WhatsApp group, scan the QR code when prompted.

---

## Testing checklist

- [ ] `todos` table created on `initDatabase()` — verify with `sqlite3 store/messages.db ".schema todos"`
- [ ] IPC todo write works — manually drop a JSON file into `data/ipc/main/todos/test.json`, confirm row appears in DB
- [ ] Notion token valid — run `runFullSync()` in isolation, confirm rows appear in `todos`
- [ ] Cold start handled — delete `notion_last_sync_at` from `router_state`, restart, confirm full sync runs
- [ ] Cursor only advances on success — throw an error mid-sync, confirm `notion_last_sync_at` unchanged
- [ ] Local enrichment preserved — add `estimated_minutes` to a synced row, run incremental sync again, confirm it's not overwritten
- [ ] Timezone correct — check `SELECT date('now')` in sqlite3 matches your local date
- [ ] Pagination — if you have >100 Notion pages, verify all are fetched
- [ ] WhatsApp → create school todo → appears in both Notion and local DB
- [ ] WhatsApp → create personal todo → appears in local DB only, not Notion
- [ ] "What's due this week?" query returns correct results
