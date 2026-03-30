# Pi Setup Guide

This guide picks up after the Pi is on the network with Tailscale and UFW configured.

---

## 1. Clone the repo

```bash
git clone <your-fork-url> ~/nanoclaw
cd ~/nanoclaw
```

If you haven't forked yet, fork `qwibitai/nanoclaw` on GitHub first, then clone your fork.
This lets you push your customizations (courses, CLAUDE.md, etc.) and pull upstream updates later.

---

## 2. Install dependencies and build

```bash
npm install
npm run build
./container/build.sh   # builds the agent Docker image — takes a few minutes first time
```

---

## 3. Create `.env`

```bash
cp .env.example .env
nano .env
```

Minimum required:

```
ANTHROPIC_API_KEY=sk-ant-...
ASSISTANT_NAME=Andy
TZ=America/New_York
```

Full reference:

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |
| `ASSISTANT_NAME` | Yes | Trigger name — messages must start with `@Andy` |
| `TZ` | Yes | Timezone for scheduled tasks and date queries |
| `CLAUDE_CODE_OAUTH_TOKEN` | Alternative to API key | OAuth token if you use Claude Code auth instead |
| `CONTAINER_TIMEOUT` | No | Max container lifetime in ms (default: 1800000 = 30 min) |
| `IDLE_TIMEOUT` | No | How long to keep container alive after last output (default: 30 min) |
| `LANGFUSE_PUBLIC_KEY` | No | Langfuse public key for observability |
| `LANGFUSE_SECRET_KEY` | No | Langfuse secret key — tracing is disabled if absent |
| `LANGFUSE_BASEURL` | No | Langfuse server URL (default: `http://localhost:4000`) |

> **Note:** `ANTHROPIC_API_KEY` is never passed into containers. It's loaded only by the credential proxy, which injects it into API calls. Containers only see a local proxy URL.

---

## 4. Set system timezone

This must match the `TZ` value in `.env`:

```bash
sudo timedatectl set-timezone America/New_York
timedatectl   # verify
```

SQLite's `date('now')` uses the process timezone. Without this, "due today" queries will be wrong.

---

## 5. Create Notion config

```bash
mkdir -p ~/.config/nanoclaw
nano ~/.config/nanoclaw/notion.json
```

Paste:

```json
{
  "token": "secret_...",
  "databaseId": "22a5aa6e92ba8006b846ed49fc2e2234"
}
```

Lock it down:

```bash
chmod 600 ~/.config/nanoclaw/notion.json
```

Your Notion integration token comes from [notion.so/my-integrations](https://www.notion.so/my-integrations). Make sure the integration has been granted access to your Assignments database (open the database in Notion → ··· menu → Add connections → select your integration).

---

## 6. Update courses (each semester)

Open `groups/global/CLAUDE.md` and update the courses line near the top of the Todo Management section:

```
Courses (update each semester): CS 2050, CS 1332, MATH 2550, PHYS 2211, ENGL 1102
```

---

## 7. Start NanoClaw

For a first run, start in the foreground so you can scan the WhatsApp QR code:

```bash
npm run dev
```

A QR code will appear in the terminal. Open WhatsApp on your phone → Linked Devices → Link a Device → scan it. Auth is saved to `store/` — subsequent starts reconnect automatically.

Once it's working, stop it (`Ctrl+C`) and run it in the background:

```bash
cd ~/nanoclaw
nohup node dist/index.js >> logs/nanoclaw.log 2>&1 &
```

Check it's running:

```bash
pgrep -a node
tail -f logs/nanoclaw.log
```

---

## Pulling updates

After `git pull`:

```bash
npm install          # pick up any new dependencies
npm run build        # compile TypeScript
./container/build.sh # rebuild the agent container if agent-runner changed
pkill -f "node dist/index.js" && nohup node dist/index.js >> logs/nanoclaw.log 2>&1 &
```

---

## Running NanoClaw

### Foreground (logs visible directly)

```bash
cd ~/nanoclaw
node dist/index.js
```

### Background (persistent across SSH sessions)

```bash
cd ~/nanoclaw
nohup node dist/index.js >> logs/nanoclaw.log 2>&1 &
echo $!   # prints the PID — save it if you want to stop it later
```

### Stop

```bash
pkill -f "node dist/index.js"
```

### Check if running

```bash
pgrep -a node
```

### Viewing logs

```bash
tail -f logs/nanoclaw.log          # if started with nohup above
```

Container logs (one file per agent run):

```bash
ls groups/main/logs/
cat groups/main/logs/container-<timestamp>.log
```

---

## Accessing the Pi from your Mac (SSH tunnel)

To reach any web UI running on the Pi (e.g. Langfuse), forward the port over SSH from your Mac:

```bash
ssh -L 4000:localhost:4000 -fN username@pi-hostname
```

Then open `http://localhost:4000` in your Mac's browser. `-f` runs the tunnel in the background — drop it if you want it in the foreground (it will appear to hang, which is normal).

To make tunnels automatic on every connection, add to `~/.ssh/config` on your Mac:

```
Host pi
  HostName pi-hostname
  LocalForward 4000 localhost:4000
```

---

## Langfuse observability (optional)

Langfuse provides a UI for token usage, cost, latency, and per-group traces.

### 1. Start the stack

```bash
cd langfuse
cp .env.example .env
# Fill in two random secrets:
openssl rand -base64 32   # → LANGFUSE_NEXTAUTH_SECRET
openssl rand -base64 32   # → LANGFUSE_SALT
nano .env
docker compose up -d
```

### 2. Create an account and get API keys

Open the SSH tunnel from your Mac (`ssh -L 4000:localhost:4000 -fN username@pi-hostname`), then go to `http://localhost:4000`. Create an account, create a project, copy the public and secret keys.

### 3. Add keys to `.env`

```
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASEURL=http://localhost:4000
```

Then restart NanoClaw. Traces appear immediately after the next message is processed.

---

## Verification checklist

- [ ] `npm run build` exits cleanly
- [ ] `./container/build.sh` completes without errors
- [ ] WhatsApp QR scanned, connection confirmed in logs
- [ ] Send `@Andy hello` in your main group — get a response
- [ ] Logs show `"Notion startup sync"` on first start (or a warning if token isn't set yet)
- [ ] `sqlite3 store/messages.db ".schema todos"` shows the todos table
- [ ] `systemctl --user status nanoclaw` shows `active (running)` after reboot

---

## Updating courses each semester

Edit one line in `groups/global/CLAUDE.md`:

```
Courses (update each semester): CS XXXX, CS XXXX, ...
```

Then restart:

```bash
systemctl --user restart nanoclaw
```

No rebuild needed — `CLAUDE.md` is read at runtime by each container.
