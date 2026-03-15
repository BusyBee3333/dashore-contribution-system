# Contribution System MCP App

Interactive React dashboard for the DaShore Incubator contribution system, built as an MCP App that renders inside Discord/chat via Clawdbot.

## Setup

```bash
cd contribution-system/mcp-app
npm install
npm run build
```

## Tools

| Tool | Description | Params |
|------|-------------|--------|
| `contribution_leaderboard` | Ranked leaderboard with levels, medals, points | `type` (alltime\|season), `limit` (1-50, default 15) |
| `contribution_profile` | Member profile card with breakdown & recent activity | `username` (Discord username) |
| `contribution_stats` | System-wide stats dashboard with charts | *(none)* |
| `github_contributions` | GitHub activity — PRs, reviews, issues | `username` (optional filter) |

## Level System

| Level | Emoji | Name | Min Points |
|-------|-------|------|------------|
| 7 | `(GOD)` | Architect | 5,000 |
| 6 | `(!!!)` | Legend | 2,500 |
| 5 | `(*_* )` | Champion | 1,000 |
| 4 | `( ^_^)` | Regular | 500 |
| 3 | `(o_o )` | Contributor | 200 |
| 2 | `( ._.)` | Participant | 50 |
| 1 | `(._. )` | Newcomer | 0 |

## Development

```bash
# Build both UI and server
npm run build

# Build UI only (React → single HTML file)
npm run build:ui

# Build server only (TypeScript → JS)
npm run build:server

# Run server (stdio MCP transport)
npm run serve

# Test tools/list
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | npx tsx src/server.ts

# Test a tool call
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"contribution_stats","arguments":{}}}' | npx tsx src/server.ts
```

## Architecture

```
src/
  server.ts          ← MCP server (McpServer + registerAppTool + registerAppResource)
  app-ui/
    index.html       ← Vite entry point
    main.tsx         ← React root
    App.tsx          ← All 4 view components (leaderboard, profile, stats, github)
dist/
  ui/
    index.html       ← Single-file bundled React app
  server/
    server.js        ← Compiled server
```

**DB path:** `../data/contributions.db` (opened READONLY)

**UI resource URI:** `ui://contribution-system/dashboard.html`

The UI receives tool results via `app.ontoolresult` (registered before `app.connect()` via the `onAppCreated` callback). It switches views based on `structuredContent.view`.

## Register with Clawdbot

Add to your MCP config:

```json
{
  "mcpServers": {
    "contribution-system": {
      "command": "node",
      "args": ["/path/to/contribution-system/mcp-app/dist/server/server.js"]
    }
  }
}
```

Or use `npx tsx` for development:
```json
{
  "command": "npx",
  "args": ["tsx", "/path/to/contribution-system/mcp-app/src/server.ts"]
}
```
