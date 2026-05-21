# mcp_usercom

**Unofficial Model Context Protocol (MCP) server** that exposes the [user.com](https://user.com) CRM REST API as read-only analytics tools for [Claude](https://claude.com/claude-code), Claude Desktop, and any other MCP-compatible client.

> Disclaimer: This is a community project. It is **not affiliated with, endorsed by, or supported by user.com Inc.** "user.com" is a trademark of its respective owner.

## What it gives you

15 tools for sales-pipeline analytics on top of the public user.com REST API:

| Category | Tools |
|---|---|
| **Lookups** | `list_agents`, `list_pipelines`, `list_stages`, `list_deals`, `get_deal`, `list_activities`, `list_activity_types`, `get_deal_stage_history` |
| **Aggregations** | `agent_activity_summary`, `pipeline_snapshot`, `win_loss_summary`, `deal_velocity`, `deal_lifecycle_summary` |
| **Audits** | `deal_health_check`, `agent_ownership_audit` |

Once registered with your MCP client, you can ask things like:

- *"Show me sales activity per agent in the last 7 days"*
- *"Snapshot the Sales pipeline"*
- *"Win/loss summary for the last quarter, grouped by agent"*
- *"Health check on deal #1234 — show gaps, overdue actions, risk flags"*
- *"Who actually created the deals in agent X's portfolio — own vs. inherited?"*

## Requirements

- Node.js **18+**
- A user.com workspace with API access enabled
- A Public API token (generate it in: **Panel → Settings → Workspace settings → API & Integrations → Public API**)

## Setup

```bash
git clone https://github.com/twilewski/mcp_usercom.git
cd mcp_usercom
npm install
```

You need two environment variables:

- `USERCOM_SUBDOMAIN` — the prefix of your workspace URL. If you log in at `https://acme.user.com`, this is `acme`.
- `USERCOM_TOKEN` — the 64-character API token from the panel.

Optional:

- `USERCOM_THROTTLE_MS` — minimum gap between API requests (default `150` ms ≈ 6 req/s). user.com's public docs say 10 req/s, but sustained bursts sometimes trip a short auth-rejection window; the default is conservative.

Verify it boots:

```bash
USERCOM_SUBDOMAIN=your-subdomain USERCOM_TOKEN=your-token npm start
# expected on stderr: "usercom-crm MCP ready (subdomain=...)"
# Ctrl+C to stop.
```

## Registering the MCP server

### Claude Code (CLI)

Recommended — use the official command:

```bash
claude mcp add usercom-crm \
  --scope user \
  -e USERCOM_SUBDOMAIN=your-subdomain \
  -e USERCOM_TOKEN=your-token \
  -- /absolute/path/to/mcp_usercom/node_modules/.bin/tsx \
     /absolute/path/to/mcp_usercom/src/index.ts

claude mcp list
# usercom-crm: ...tsx .../src/index.ts - ✓ Connected
```

> Use the **absolute path to the local `tsx` binary** (not `npx tsx`). Claude Code launches MCPs from a non-project working directory, and `npx tsx` triggers a fresh npm fetch on each launch, which usually exceeds the MCP startup timeout.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on your OS:

```json
{
  "mcpServers": {
    "usercom-crm": {
      "command": "/absolute/path/to/mcp_usercom/node_modules/.bin/tsx",
      "args": ["/absolute/path/to/mcp_usercom/src/index.ts"],
      "env": {
        "USERCOM_SUBDOMAIN": "your-subdomain",
        "USERCOM_TOKEN": "your-token"
      }
    }
  }
}
```

Restart Claude Desktop.

### Other MCP clients

Anything that supports the stdio MCP transport will work. Point it at the same `tsx src/index.ts` command with the two required environment variables.

## Tool reference

Every tool's full JSON-schema input description is available via the standard `tools/list` MCP call. A short summary:

### Lookups

- **`list_agents`** — list workspace agents. Each agent has TWO ids: `id` (panel, used in `created_by`) and `assigned_to_id` (= `group_id || id`, used in `assigned_to`). For some agents they differ — important when an agent inherited an existing portfolio.
- **`list_pipelines`** — list sales pipelines.
- **`list_stages`** — list stages, optionally filtered to one pipeline. Each stage carries `pipeline` and `order` (0 = top of funnel).
- **`list_deals`** — filter by pipeline, stage, owner, status, created-date range.
- **`get_deal`** — full deal object by numeric id.
- **`list_activities`** — filter by activity type, assigned/created agent, date, done-status, deal.
- **`list_activity_types`** — workspace-defined activity types (Call, Email, Meeting, ...).
- **`get_deal_stage_history`** — stage-change history for one deal (needs the deal's `custom_id`; many workspaces don't use it).

### Aggregations

- **`agent_activity_summary`** — per-agent activity counts in a date window, broken down by activity type. Filter to one agent or compare across the team.
- **`pipeline_snapshot`** — current state per stage in a pipeline: count + total value (per currency) + status breakdown, ordered top-of-funnel to close.
- **`win_loss_summary`** — won/lost deals in a date window. Per-agent counts and total value (per currency), loss-reason breakdown, win-rate.
- **`deal_velocity`** — average time-in-stage across deals in a pipeline. Requires `custom_id` on deals.
- **`deal_lifecycle_summary`** — time-to-close stats (created_at → won_at / lost_at). Works without `custom_id`. Bucketed per agent or per pipeline; returns avg / median / p90.

### Audits

- **`deal_health_check`** — full health audit of one deal: metadata, all activities chronologically, communication gaps > N days, top-3 longest activities by description, risk flags (`stale`, `archived_without_reason`, `overdue_action`, `no_next_step`, `long_idle`).
- **`agent_ownership_audit`** — for a given agent, separates deals they personally created from deals inherited from someone else (different `created_by` than the current owner). Useful for diagnosing newly-onboarded salespeople and portfolio transfers.

## Known limitations of the underlying user.com REST API

These constrain what's possible — they are not bugs in this server.

- **No OpenAPI / Swagger spec.** All schemas in this MCP were written by hand from the HTML docs.
- **`/activities/` does not support documented query filters** (date, agent, type). This server fetches and filters locally; large workspaces may need a higher `max_activities_scanned`.
- **`/deals/?company=`, `?search=`, `name__icontains=` are silently ignored.** Only `pipeline` and `stage` are honored server-side; everything else is filtered client-side after pagination.
- **`stage-changes` requires `custom_id`** on each deal. Numeric id is not accepted. Many workspaces don't populate `custom_id`, which gates the `deal_velocity` tool.
- **No `loss_reason` enum** is published — reasons come back as numeric ids whose meaning is workspace-specific.
- **`closed_at` does not exist** on the deal model. Use `won_at` / `lost_at` instead.
- **Agents have two ids** (`id` panel + `group_id`). `created_by` uses the panel id, `assigned_to` uses `group_id`. The `list_agents` and `agent_ownership_audit` tools surface both.
- **Cursor pagination has a known edge case**: `next` can be non-null on the last page and 404 on follow. This server handles it gracefully.
- **Rate limit**: docs say 10 req/s, but sustained ~30-request bursts can trip a short 401 window. Throttle defaults to 150 ms gaps (~6 req/s).

## Development

```bash
npm run typecheck   # TypeScript check, no emit
npm start           # run the MCP server on stdio
```

Smoke-test handshake without Claude:

```bash
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 2
} | USERCOM_SUBDOMAIN=your-subdomain USERCOM_TOKEN=your-token npm start
```

Should print the 15 tools registered.

## Security

- **Never commit your `USERCOM_TOKEN`.** The included `.gitignore` excludes `.env`, `.claude/`, and other common secret locations, but always double-check before pushing.
- A user.com Public API token gives **read/write access to your entire workspace**. Treat it like a password.
- All tools in this server are read-only (GET endpoints only), but the token itself can do more — if it leaks, rotate it immediately in the panel.

## Contributing

Bug reports, additional tools, and improvements to existing ones are welcome via pull requests or issues.

## License

MIT — see [LICENSE](LICENSE).
