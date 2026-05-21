#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Load .env from the project root (one level up from src/), so the token can live
// in a local file instead of being passed via `claude mcp add -e ...` (which leaks
// it into ~/.claude.json and into `ps` argv). Existing process env wins — explicit
// -e on the CLI still works as an override.
const HERE = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(HERE, "..", ".env"), quiet: true });

const SUBDOMAIN = process.env.USERCOM_SUBDOMAIN;
const TOKEN = process.env.USERCOM_TOKEN;

if (!SUBDOMAIN) {
  console.error(
    "USERCOM_SUBDOMAIN not set. Use the prefix of your workspace URL — e.g. for https://acme.user.com set USERCOM_SUBDOMAIN=acme."
  );
  process.exit(1);
}
if (!TOKEN) {
  console.error(
    "USERCOM_TOKEN not set. Generate in panel: Settings → Workspace settings → API & Integrations → Public API."
  );
  process.exit(1);
}

const BASE_URL = `https://${SUBDOMAIN}.user.com/api/public`;

const HEADERS: Record<string, string> = {
  Authorization: `Token ${TOKEN}`,
  Accept: "*/*; version=2",
};

// user.com docs say 10 req/s, but in practice sustained bursts (~30 reqs) trip a
// short auth-rejection window. Throttle to ~6 req/s to stay clearly under the bar.
const THROTTLE_MS = Number(process.env.USERCOM_THROTTLE_MS ?? 150);
let nextSlot = 0;
async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + THROTTLE_MS;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

const DEAL_STATUS = {
  0: "abandoned",
  1: "in_progress",
  2: "won",
  3: "lost",
  4: "archived",
} as const;
type StatusName = (typeof DEAL_STATUS)[keyof typeof DEAL_STATUS];
const STATUS_BY_NAME: Record<StatusName, number> = {
  abandoned: 0,
  in_progress: 1,
  won: 2,
  lost: 3,
  archived: 4,
};

async function fetchWithRetry(url: string): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await throttle();
    const resp = await fetch(url, { headers: HEADERS });
    if (resp.status === 429) {
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      continue;
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status} on ${url}: ${body.slice(0, 500)}`);
    }
    return resp.json();
  }
  throw new Error(`Rate-limited after retries: ${url}`);
}

async function get(path: string, params: Record<string, unknown> = {}): Promise<any> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  return fetchWithRetry(url.toString());
}

async function paginate(
  path: string,
  params: Record<string, unknown> = {},
  max = 1000
): Promise<any[]> {
  const out: any[] = [];
  let next: string | null = null;
  let firstParams: Record<string, unknown> | null = params;
  while (out.length < max) {
    let page: any;
    if (next) {
      try {
        page = await fetchWithRetry(next);
      } catch {
        // user.com bug: `next` may point past the last page → 404
        break;
      }
    } else {
      page = await get(path, firstParams ?? {});
      firstParams = null;
    }
    if (!Array.isArray(page?.results)) break;
    out.push(...page.results);
    next = page.next ?? null;
    if (!next) break;
  }
  return out.slice(0, max);
}

function withinRange(iso: string | null | undefined, from?: string, to?: string): boolean {
  if (!iso) return false;
  if (from && iso < from) return false;
  if (to && iso > to) return false;
  return true;
}

// Effective "when did this activity happen" timestamp.
// user.com's public API has no `datetime` field on activities despite older docs claiming otherwise.
// Real fields: due_date (planned), done_date (completed), created_at (record creation).
function activityWhen(a: any): string | null {
  return a?.due_date ?? a?.done_date ?? a?.created_at ?? null;
}

// user.com agents have TWO ids:
//   - `id` shown in the admin panel and in /application/.agents[].id
//   - `group_id` (when set) is the value referenced by deal.assigned_to / activity.assigned_to / activity.created_by
// Many agents have group_id != id (e.g. Alina Długosz: id=58, group_id=78). When group_id is null, id is used directly.
// This helper builds a Map<assigned_to_id, name> from a raw /application/ response.
function buildAgentNameMap(app: any): Map<number, string> {
  const out = new Map<number, string>();
  for (const a of (app?.agents ?? []) as any[]) {
    const key = (a.group_id ?? a.id) as number;
    if (key !== undefined && key !== null && !out.has(key)) out.set(key, a.name);
  }
  return out;
}

function asText(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

// ---------- Server ----------

// 15 tools registered below:
//   Lookups (8):       list_agents, list_pipelines, list_stages, list_deals,
//                      get_deal, list_activities, list_activity_types, get_deal_stage_history
//   Aggregations (5):  agent_activity_summary, pipeline_snapshot, win_loss_summary,
//                      deal_velocity, deal_lifecycle_summary
//   Per-agent audit (1): agent_ownership_audit
//   Per-deal audit (1):  deal_health_check
const server = new McpServer({ name: "usercom-crm", version: "0.1.0" });

server.tool(
  "list_agents",
  "List all sales agents (handlowcy). Each agent has TWO distinct identifiers; both are returned:\n" +
    "  • `id` — the panel/admin id. This is the value that appears in `created_by` on activities AND on deals (i.e. who personally created the record).\n" +
    "  • `assigned_to_id` — equals `group_id` when set, otherwise falls back to `id`. This is the value that appears in `assigned_to` on activities and deals (i.e. who currently owns / is responsible for the record).\n" +
    "For some agents `id == assigned_to_id` (e.g. Mariusz Andreasik id=8, group_id=8). For others they differ (e.g. Emilia Głaz id=74, group_id=102), which matters when the agent inherited an existing portfolio.\n" +
    "When filtering by 'currently assigned salesperson', pass `assigned_to_id`. When filtering by 'who actually created this record', pass the panel `id`. See `agent_ownership_audit` for separating created vs. inherited deals.",
  {},
  async () => {
    const app = await get("/application/");
    const agents = (app?.agents ?? []).map((a: any) => ({
      id: a.id,
      assigned_to_id: a.group_id ?? a.id,
      group_id: a.group_id ?? null,
      name: a.name,
      email: a.email,
      status: a.status,
    }));
    return asText({ owner: app?.owner ?? null, agents });
  }
);

server.tool(
  "list_pipelines",
  "List all sales pipelines. Returns [{id, name}]. Use pipeline id with other tools.",
  {},
  async () => asText(await paginate("/pipelines/", {}, 500))
);

server.tool(
  "list_stages",
  "List deal stages. Each stage carries `pipeline` (id) and `order` (0 = top of funnel). Optionally filter to one pipeline.",
  { pipeline_id: z.number().int().optional() },
  async ({ pipeline_id }) => {
    const all = await paginate("/stages/", {}, 500);
    const filtered =
      pipeline_id !== undefined ? all.filter((s: any) => s.pipeline === pipeline_id) : all;
    filtered.sort(
      (a: any, b: any) =>
        (a.pipeline ?? 0) - (b.pipeline ?? 0) || (a.order ?? 0) - (b.order ?? 0)
    );
    return asText(filtered);
  }
);

server.tool(
  "list_deals",
  "List deals with optional filters. `pipeline_id` and `stage_id` are pushed server-side; `assigned_to`, `status`, and date filters are applied client-side after fetch. Limit defaults to 200.",
  {
    pipeline_id: z.number().int().optional(),
    stage_id: z.number().int().optional(),
    assigned_to: z.number().int().optional().describe("Agent pk (salesperson)"),
    status: z
      .enum(["abandoned", "in_progress", "won", "lost", "archived"])
      .optional(),
    created_from: z.string().optional().describe("ISO date, inclusive lower bound on created_at"),
    created_to: z.string().optional().describe("ISO date, inclusive upper bound on created_at"),
    limit: z.number().int().min(1).max(2000).default(200),
  },
  async (args) => {
    const serverParams: Record<string, unknown> = {};
    if (args.pipeline_id !== undefined) serverParams.pipeline = args.pipeline_id;
    if (args.stage_id !== undefined) serverParams.stage = args.stage_id;
    const raw = await paginate("/deals/", serverParams, Math.max(args.limit * 4, 500));
    const statusNum = args.status ? STATUS_BY_NAME[args.status] : undefined;
    const filtered = raw.filter((d: any) => {
      if (args.assigned_to !== undefined && d.assigned_to !== args.assigned_to) return false;
      if (statusNum !== undefined && d.status !== statusNum) return false;
      if (args.created_from && (!d.created_at || d.created_at < args.created_from)) return false;
      if (args.created_to && (!d.created_at || d.created_at > args.created_to)) return false;
      return true;
    });
    const deals = filtered.slice(0, args.limit).map((d: any) => ({
      id: d.id,
      custom_id: d.custom_id,
      name: d.name,
      value: d.value,
      currency: d.currency,
      pipeline: d.pipeline,
      stage: d.stage,
      assigned_to: d.assigned_to,
      status: DEAL_STATUS[d.status as keyof typeof DEAL_STATUS] ?? d.status,
      created_at: d.created_at,
      updated_at: d.updated_at,
      won_at: d.won_at,
      lost_at: d.lost_at,
      loss_reason: d.loss_reason,
      expected_close_date: d.expected_close_date,
    }));
    return asText({ total_returned: deals.length, total_after_filter: filtered.length, deals });
  }
);

server.tool(
  "get_deal",
  "Fetch a single deal by numeric id.",
  { id: z.number().int() },
  async ({ id }) => asText(await get(`/deals/${id}/`))
);

server.tool(
  "list_activities",
  "List activities (calls, meetings, emails, tasks, notes etc.). Filter params are applied client-side after paging the endpoint. activity_type_id can be obtained from list_activity_types.",
  {
    activity_type_id: z.number().int().optional(),
    assigned_to: z.number().int().optional().describe("Agent pk (handlowiec)"),
    created_by: z.number().int().optional().describe("Agent pk who created the activity"),
    date_from: z.string().optional().describe("ISO datetime, inclusive lower bound on due_date (with fallback to done_date, then created_at)"),
    date_to: z.string().optional().describe("ISO datetime, inclusive upper bound on due_date (with fallback to done_date, then created_at)"),
    done: z.boolean().optional(),
    deal_id: z.number().int().optional(),
    limit: z.number().int().min(1).max(2000).default(300),
  },
  async (args) => {
    const raw = await paginate("/activities/", {}, Math.max(args.limit * 4, 1000));
    const filtered = raw.filter((a: any) => {
      if (args.activity_type_id !== undefined && a.activity_type !== args.activity_type_id)
        return false;
      if (args.assigned_to !== undefined && a.assigned_to !== args.assigned_to) return false;
      if (args.created_by !== undefined && a.created_by !== args.created_by) return false;
      if (args.deal_id !== undefined && a.deal_id !== args.deal_id) return false;
      if (args.done !== undefined && a.done !== args.done) return false;
      if (args.date_from || args.date_to) {
        if (!withinRange(activityWhen(a), args.date_from, args.date_to)) return false;
      }
      return true;
    });
    return asText({
      total_returned: Math.min(filtered.length, args.limit),
      total_after_filter: filtered.length,
      activities: filtered.slice(0, args.limit),
    });
  }
);

server.tool(
  "list_activity_types",
  "List activity types defined in the workspace (Call, Meeting, E-mail, Task, Deadline, Lunch, Custom, ...). Returns [{id, name, icon}].",
  {},
  async () => asText(await paginate("/activity-types/", {}, 200))
);

server.tool(
  "get_deal_stage_history",
  "Stage-change history for one deal — needed for time-in-stage / velocity. Requires the deal's `custom_id` (not numeric id). Returns events with entered_at, left_at, stage, changed_by.",
  {
    custom_id: z.string(),
    date_from: z.string().optional().describe("ISO datetime — count_from"),
    date_to: z.string().optional().describe("ISO datetime — count_to"),
  },
  async ({ custom_id, date_from, date_to }) =>
    asText(
      await get(`/deals-by-id/${encodeURIComponent(custom_id)}/stage-changes/`, {
        count_from: date_from,
        count_to: date_to,
      })
    )
);

// ---------- Aggregated analytics ----------

server.tool(
  "agent_activity_summary",
  "Per-agent activity counts in a date window, broken down by activity type. Use to see who logged how many calls/meetings/emails/etc.\n" +
    "IMPORTANT — choose `mode` carefully when a salesperson inherited a portfolio:\n" +
    "  • `mode: \"assigned\"` (default) — each activity is attributed to its `assigned_to` agent (current owner). Filter via `assigned_to_id` (use list_agents.assigned_to_id == group_id ?? id).\n" +
    "  • `mode: \"created\"` — each activity is attributed to its `created_by` agent (who personally logged it). Filter via `created_by_id` (use list_agents.id, the panel id). This is the right choice when measuring a new salesperson's actual output — `assigned_to` includes activities logged by the previous owner before transfer.\n" +
    "  • `mode: \"either\"` — each activity is attributed to BOTH its assigned_to AND created_by agents (de-duped if equal). Useful for total touch-points.\n" +
    "Both `assigned_to_id` and `created_by_id` can be combined as an AND filter regardless of mode.",
  {
    date_from: z.string().describe("ISO datetime, inclusive lower bound on due_date (fallback: done_date, created_at)"),
    date_to: z.string().describe("ISO datetime, inclusive upper bound on due_date (fallback: done_date, created_at)"),
    assigned_to_id: z.number().int().optional().describe("Filter: activities where assigned_to == this value. Pass list_agents.assigned_to_id (agent's group_id or id fallback)."),
    created_by_id: z.number().int().optional().describe("Filter: activities where created_by == this value. Pass list_agents.id (the panel id — different from assigned_to_id when agent has a group_id)."),
    mode: z
      .enum(["assigned", "created", "either"])
      .default("assigned")
      .describe("Which field attributes the activity to an agent. See tool description."),
    max_activities_scanned: z.number().int().min(100).max(20000).default(5000),
  },
  async ({ date_from, date_to, assigned_to_id, created_by_id, mode, max_activities_scanned }) => {
    const [acts, types, app] = await Promise.all([
      paginate("/activities/", {}, max_activities_scanned),
      paginate("/activity-types/", {}, 200),
      get("/application/"),
    ]);
    const typeName = new Map<number, string>(types.map((t: any) => [t.id, t.name]));
    const assignedNameMap = buildAgentNameMap(app);
    // `created_by` references the panel id, not the group_id, so we need a separate lookup.
    const panelIdNameMap = new Map<number, string>(
      (app?.agents ?? []).map((a: any) => [a.id, a.name])
    );

    const inRange = acts.filter((a: any) => withinRange(activityWhen(a), date_from, date_to));
    const filtered = inRange.filter((a: any) => {
      if (assigned_to_id !== undefined && a.assigned_to !== assigned_to_id) return false;
      if (created_by_id !== undefined && a.created_by !== created_by_id) return false;
      return true;
    });

    type Key = { kind: "assigned" | "created"; id: number | null };
    const keyOf = (k: Key) => `${k.kind}:${k.id ?? "null"}`;
    const buckets = new Map<string, { key: Key; byType: Map<number | null, number> }>();
    const bump = (key: Key, type: number | null) => {
      const k = keyOf(key);
      if (!buckets.has(k)) buckets.set(k, { key, byType: new Map() });
      const inner = buckets.get(k)!.byType;
      inner.set(type, (inner.get(type) ?? 0) + 1);
    };

    for (const a of filtered) {
      const type = (a.activity_type as number | null) ?? null;
      const assigned = (a.assigned_to as number | null) ?? null;
      const created = (a.created_by as number | null) ?? null;
      if (mode === "assigned") {
        bump({ kind: "assigned", id: assigned }, type);
      } else if (mode === "created") {
        bump({ kind: "created", id: created }, type);
      } else {
        // "either": count under both, dedupe when assigned_to and created_by are by the same person
        bump({ kind: "assigned", id: assigned }, type);
        const sameAgent =
          assigned !== null &&
          created !== null &&
          panelIdNameMap.get(created) !== undefined &&
          assignedNameMap.get(assigned) !== undefined &&
          panelIdNameMap.get(created) === assignedNameMap.get(assigned);
        if (!sameAgent) bump({ kind: "created", id: created }, type);
      }
    }

    const result = Array.from(buckets.values()).map(({ key, byType }) => {
      const nameMap = key.kind === "assigned" ? assignedNameMap : panelIdNameMap;
      return {
        attribution: key.kind,
        ...(key.kind === "assigned"
          ? { assigned_to_id: key.id }
          : { created_by_id: key.id }),
        agent_name: key.id !== null ? nameMap.get(key.id) ?? null : null,
        total: Array.from(byType.values()).reduce((s, n) => s + n, 0),
        by_type: Array.from(byType.entries())
          .map(([t, n]) => ({
            activity_type_id: t,
            activity_type_name: t !== null ? typeName.get(t) ?? null : null,
            count: n,
          }))
          .sort((a, b) => b.count - a.count),
      };
    });
    result.sort((a, b) => b.total - a.total);

    return asText({
      window: { from: date_from, to: date_to },
      mode,
      filters: {
        assigned_to_id: assigned_to_id ?? null,
        created_by_id: created_by_id ?? null,
      },
      scanned: acts.length,
      in_window: inRange.length,
      after_filter: filtered.length,
      per_agent: result,
    });
  }
);

server.tool(
  "pipeline_snapshot",
  "Current state of deals per stage in a pipeline: count and summed value (per currency), broken down by status. Snapshot of the live pipeline.",
  {
    pipeline_id: z.number().int(),
    max_deals_scanned: z.number().int().min(100).max(20000).default(3000),
  },
  async ({ pipeline_id, max_deals_scanned }) => {
    const [deals, stages] = await Promise.all([
      paginate("/deals/", { pipeline: pipeline_id }, max_deals_scanned),
      paginate("/stages/", {}, 500),
    ]);
    const stagesInPipeline = stages.filter((s: any) => s.pipeline === pipeline_id);
    const stageMeta = new Map<number, { name: string; order: number }>(
      stagesInPipeline.map((s: any) => [s.id, { name: s.name, order: s.order ?? 0 }])
    );

    type Row = {
      stage_id: number;
      stage_name: string | null;
      order: number;
      count: number;
      value_by_currency: Record<string, number>;
      status_counts: Record<string, number>;
    };
    const grouped = new Map<number, Row>();
    // seed every stage so empty stages show as 0
    for (const s of stagesInPipeline) {
      grouped.set(s.id, {
        stage_id: s.id,
        stage_name: s.name,
        order: s.order ?? 0,
        count: 0,
        value_by_currency: {},
        status_counts: {},
      });
    }
    for (const d of deals) {
      const sid = d.stage as number;
      if (!grouped.has(sid)) {
        grouped.set(sid, {
          stage_id: sid,
          stage_name: stageMeta.get(sid)?.name ?? null,
          order: stageMeta.get(sid)?.order ?? 999,
          count: 0,
          value_by_currency: {},
          status_counts: {},
        });
      }
      const g = grouped.get(sid)!;
      g.count += 1;
      const cur = d.currency ?? "?";
      g.value_by_currency[cur] = (g.value_by_currency[cur] ?? 0) + Number(d.value ?? 0);
      const status = DEAL_STATUS[d.status as keyof typeof DEAL_STATUS] ?? String(d.status);
      g.status_counts[status] = (g.status_counts[status] ?? 0) + 1;
    }

    return asText({
      pipeline_id,
      deals_scanned: deals.length,
      stages: Array.from(grouped.values()).sort((a, b) => a.order - b.order),
    });
  }
);

server.tool(
  "win_loss_summary",
  "Won/lost deal aggregation in a date window. Counts and total value per agent (per currency, grouped by `assigned_to`), plus loss-reason breakdown. Uses won_at / lost_at for date filtering (closed_at does not exist on user.com).\n" +
    "Filters are AND-combined:\n" +
    "  • `assigned_to_id` — restrict to deals currently owned by an agent (list_agents.assigned_to_id == group_id ?? id).\n" +
    "  • `created_by_id` — restrict to deals personally CREATED by an agent (list_agents.id, the panel id). When set together with assigned_to_id, this isolates deals an agent both created and still owns (excluding inherited ones). When set alone, this finds all deals that agent created — even if they have since been re-assigned.",
  {
    date_from: z.string().describe("ISO datetime, inclusive lower bound on won_at/lost_at"),
    date_to: z.string().describe("ISO datetime, inclusive upper bound on won_at/lost_at"),
    pipeline_id: z.number().int().optional(),
    assigned_to_id: z.number().int().optional().describe("Restrict to one agent (value from list_agents.assigned_to_id, i.e. group_id or id fallback)"),
    created_by_id: z.number().int().optional().describe("Restrict to deals created by one agent (value from list_agents.id, the panel id)"),
    max_deals_scanned: z.number().int().min(100).max(30000).default(5000),
  },
  async ({ date_from, date_to, pipeline_id, assigned_to_id, created_by_id, max_deals_scanned }) => {
    const params: Record<string, unknown> = {};
    if (pipeline_id !== undefined) params.pipeline = pipeline_id;
    const [deals, app] = await Promise.all([
      paginate("/deals/", params, max_deals_scanned),
      get("/application/"),
    ]);
    const agentName = buildAgentNameMap(app);

    const closed = deals.filter((d: any) => {
      if (assigned_to_id !== undefined && d.assigned_to !== assigned_to_id) return false;
      if (created_by_id !== undefined && d.created_by !== created_by_id) return false;
      if (d.status === STATUS_BY_NAME.won) return withinRange(d.won_at, date_from, date_to);
      if (d.status === STATUS_BY_NAME.lost) return withinRange(d.lost_at, date_from, date_to);
      return false;
    });

    type Bucket = {
      assigned_to_id: number | null;
      agent_name: string | null;
      won_count: number;
      lost_count: number;
      won_value_by_currency: Record<string, number>;
      lost_value_by_currency: Record<string, number>;
      loss_reasons: Record<string, number>;
    };
    const buckets = new Map<number | null, Bucket>();
    for (const d of closed) {
      const agent = (d.assigned_to as number | null) ?? null;
      if (!buckets.has(agent)) {
        buckets.set(agent, {
          assigned_to_id: agent,
          agent_name: agent !== null ? agentName.get(agent) ?? null : null,
          won_count: 0,
          lost_count: 0,
          won_value_by_currency: {},
          lost_value_by_currency: {},
          loss_reasons: {},
        });
      }
      const b = buckets.get(agent)!;
      const cur = d.currency ?? "?";
      const value = Number(d.value ?? 0);
      if (d.status === STATUS_BY_NAME.won) {
        b.won_count += 1;
        b.won_value_by_currency[cur] = (b.won_value_by_currency[cur] ?? 0) + value;
      } else {
        b.lost_count += 1;
        b.lost_value_by_currency[cur] = (b.lost_value_by_currency[cur] ?? 0) + value;
        const reason = d.loss_reason ? String(d.loss_reason) : "unspecified";
        b.loss_reasons[reason] = (b.loss_reasons[reason] ?? 0) + 1;
      }
    }

    const per_agent = Array.from(buckets.values()).map((b) => ({
      ...b,
      win_rate:
        b.won_count + b.lost_count > 0
          ? b.won_count / (b.won_count + b.lost_count)
          : null,
    }));
    per_agent.sort((a, b) => b.won_count + b.lost_count - (a.won_count + a.lost_count));

    return asText({
      window: { from: date_from, to: date_to },
      pipeline_id: pipeline_id ?? null,
      filters: {
        assigned_to_id: assigned_to_id ?? null,
        created_by_id: created_by_id ?? null,
      },
      deals_scanned: deals.length,
      closed_in_window: closed.length,
      per_agent,
    });
  }
);

server.tool(
  "deal_velocity",
  "Average time-in-stage across deals in a pipeline. Requires deals to have a populated `custom_id` (user.com's stage-changes endpoint is /deals-by-id/:custom_id/stage-changes/). Many workspaces do NOT use custom_id; in that case this returns a warning and you should use deal_lifecycle_summary instead.",
  {
    pipeline_id: z.number().int(),
    sample_size: z.number().int().min(1).max(200).default(50),
    only_closed: z
      .boolean()
      .default(false)
      .describe("Restrict sample to deals already won or lost (full lifecycle)"),
  },
  async ({ pipeline_id, sample_size, only_closed }) => {
    const allDeals = await paginate("/deals/", { pipeline: pipeline_id }, 2000);
    const eligible = allDeals.filter(
      (d: any) =>
        !!d.custom_id &&
        (!only_closed ||
          d.status === STATUS_BY_NAME.won ||
          d.status === STATUS_BY_NAME.lost)
    );

    if (eligible.length === 0) {
      return asText({
        pipeline_id,
        deals_in_pipeline: allDeals.length,
        eligible_with_custom_id: 0,
        warning:
          "No deals with custom_id found. user.com's /deals-by-id/:custom_id/stage-changes/ endpoint requires a client-supplied custom_id. Without it, time-in-stage cannot be measured via the public API.",
      });
    }

    const sample = eligible.slice(0, sample_size);
    const stages = await paginate("/stages/", {}, 500);
    const stageName = new Map<number, string>(stages.map((s: any) => [s.id, s.name]));

    type Acc = { stage_id: number; stage_name: string | null; total_ms: number; samples: number };
    const acc = new Map<number, Acc>();
    let scanned = 0;
    let failed = 0;

    for (const d of sample) {
      try {
        const changes = await get(
          `/deals-by-id/${encodeURIComponent(d.custom_id)}/stage-changes/`
        );
        const events = Array.isArray(changes) ? changes : changes?.results ?? [];
        for (const ev of events) {
          const sid = ev.stage as number;
          const entered = ev.entered_at ? Date.parse(ev.entered_at) : null;
          const left = ev.left_at ? Date.parse(ev.left_at) : null;
          if (entered === null || left === null) continue;
          if (!acc.has(sid)) {
            acc.set(sid, {
              stage_id: sid,
              stage_name: stageName.get(sid) ?? ev.stage_name ?? null,
              total_ms: 0,
              samples: 0,
            });
          }
          const a = acc.get(sid)!;
          a.total_ms += Math.max(0, left - entered);
          a.samples += 1;
        }
        scanned += 1;
      } catch {
        failed += 1;
      }
    }

    const stageOrder = new Map<number, number>(
      stages.filter((s: any) => s.pipeline === pipeline_id).map((s: any) => [s.id, s.order ?? 0])
    );
    const per_stage = Array.from(acc.values())
      .map((a) => ({
        stage_id: a.stage_id,
        stage_name: a.stage_name,
        order: stageOrder.get(a.stage_id) ?? 999,
        samples: a.samples,
        avg_hours: a.samples ? a.total_ms / a.samples / 3_600_000 : null,
        avg_days: a.samples ? a.total_ms / a.samples / 86_400_000 : null,
      }))
      .sort((a, b) => a.order - b.order);

    return asText({
      pipeline_id,
      deals_in_pipeline: allDeals.length,
      eligible_with_custom_id: eligible.length,
      sampled: scanned,
      failed,
      per_stage,
    });
  }
);

server.tool(
  "deal_lifecycle_summary",
  "Time-to-close statistics for closed deals (won + lost), measured from created_at to won_at/lost_at. Works without custom_id. Bucketed per agent (or per pipeline). Returns count, avg_days, median_days, p90_days. Filter by date window on the closure date.\n" +
    "Optional agent filters (AND-combined):\n" +
    "  • `assigned_to_id` — only deals currently owned by an agent (list_agents.assigned_to_id == group_id ?? id).\n" +
    "  • `created_by_id` — only deals personally CREATED by an agent (list_agents.id, the panel id). Use this to exclude inherited deals from a new salesperson's lifecycle stats.",
  {
    date_from: z.string().describe("ISO datetime, inclusive lower bound on won_at/lost_at"),
    date_to: z.string().describe("ISO datetime, inclusive upper bound on won_at/lost_at"),
    pipeline_id: z.number().int().optional(),
    assigned_to_id: z.number().int().optional().describe("Restrict to deals currently owned by this agent (list_agents.assigned_to_id)"),
    created_by_id: z.number().int().optional().describe("Restrict to deals personally created by this agent (list_agents.id, the panel id)"),
    group_by: z.enum(["agent", "pipeline"]).default("agent"),
    max_deals_scanned: z.number().int().min(100).max(30000).default(5000),
  },
  async ({ date_from, date_to, pipeline_id, assigned_to_id, created_by_id, group_by, max_deals_scanned }) => {
    const params: Record<string, unknown> = {};
    if (pipeline_id !== undefined) params.pipeline = pipeline_id;
    const [deals, app, pipelines] = await Promise.all([
      paginate("/deals/", params, max_deals_scanned),
      get("/application/"),
      paginate("/pipelines/", {}, 500),
    ]);
    const agentName = buildAgentNameMap(app);
    const pipelineName = new Map<number, string>(pipelines.map((p: any) => [p.id, p.name]));

    type Closed = {
      key: number | null;
      keyName: string | null;
      outcome: "won" | "lost";
      days: number;
      value: number;
      currency: string;
    };
    const rows: Closed[] = [];
    for (const d of deals) {
      if (assigned_to_id !== undefined && d.assigned_to !== assigned_to_id) continue;
      if (created_by_id !== undefined && d.created_by !== created_by_id) continue;
      const isWon = d.status === STATUS_BY_NAME.won;
      const isLost = d.status === STATUS_BY_NAME.lost;
      if (!isWon && !isLost) continue;
      const closedAt = isWon ? d.won_at : d.lost_at;
      if (!withinRange(closedAt, date_from, date_to)) continue;
      if (!d.created_at || !closedAt) continue;
      const days = (Date.parse(closedAt) - Date.parse(d.created_at)) / 86_400_000;
      if (!Number.isFinite(days) || days < 0) continue;
      const key =
        group_by === "agent"
          ? (d.assigned_to as number | null) ?? null
          : (d.pipeline as number | null) ?? null;
      const keyName =
        group_by === "agent"
          ? key !== null
            ? agentName.get(key) ?? null
            : null
          : key !== null
          ? pipelineName.get(key) ?? null
          : null;
      rows.push({
        key,
        keyName,
        outcome: isWon ? "won" : "lost",
        days,
        value: Number(d.value ?? 0),
        currency: d.currency ?? "?",
      });
    }

    function pct(sorted: number[], p: number): number | null {
      if (sorted.length === 0) return null;
      const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
      return sorted[idx];
    }
    function summarize(group: Closed[]) {
      const wonDays = group.filter((r) => r.outcome === "won").map((r) => r.days).sort((a, b) => a - b);
      const lostDays = group.filter((r) => r.outcome === "lost").map((r) => r.days).sort((a, b) => a - b);
      const all = group.map((r) => r.days).sort((a, b) => a - b);
      const avg = (xs: number[]) => (xs.length ? xs.reduce((s, n) => s + n, 0) / xs.length : null);
      return {
        count: group.length,
        won_count: wonDays.length,
        lost_count: lostDays.length,
        avg_days: avg(all),
        median_days: pct(all, 50),
        p90_days: pct(all, 90),
        avg_days_won: avg(wonDays),
        avg_days_lost: avg(lostDays),
      };
    }

    const byKey = new Map<number | null, { name: string | null; rows: Closed[] }>();
    for (const r of rows) {
      if (!byKey.has(r.key)) byKey.set(r.key, { name: r.keyName, rows: [] });
      byKey.get(r.key)!.rows.push(r);
    }
    const groups = Array.from(byKey.entries()).map(([key, v]) => ({
      [group_by === "agent" ? "assigned_to_id" : "pipeline_id"]: key,
      [group_by === "agent" ? "agent_name" : "pipeline_name"]: v.name,
      ...summarize(v.rows),
    }));
    groups.sort((a: any, b: any) => b.count - a.count);

    return asText({
      window: { from: date_from, to: date_to },
      pipeline_id: pipeline_id ?? null,
      filters: {
        assigned_to_id: assigned_to_id ?? null,
        created_by_id: created_by_id ?? null,
      },
      group_by,
      deals_scanned: deals.length,
      closed_in_window: rows.length,
      overall: summarize(rows),
      groups,
    });
  }
);

server.tool(
  "deal_health_check",
  "Full health audit of a single deal: deal metadata, all activities (chronologically), communication gaps >14 days, top-3 longest activities by description, and risk flags (stale, archived_without_reason, overdue_action, no_next_step, long_idle). Activities are paginated from /activities/ and filtered locally by deal_id (user.com ignores query filters on that endpoint).",
  {
    deal_id: z.number().int(),
    max_activities_scanned: z
      .number()
      .int()
      .min(100)
      .max(20000)
      .default(10000)
      .describe(
        "Upper bound on activities scanned to find ones belonging to this deal. Older deals may have activities buried deep in the global /activities/ feed (newest-first), so a deep audit needs a generous bound."
      ),
    gap_days: z.number().int().min(1).default(14).describe("Threshold (days) for communication gap detection"),
    idle_days: z.number().int().min(1).default(90).describe("Threshold (days) for the long_idle flag"),
    far_future_days: z
      .number()
      .int()
      .min(1)
      .default(90)
      .describe("A scheduled next-step further than this in the future does not count as a real next step"),
  },
  async ({ deal_id, max_activities_scanned, gap_days, idle_days, far_future_days }) => {
    const [deal, activitiesRaw, types] = await Promise.all([
      get(`/deals/${deal_id}/`),
      paginate("/activities/", {}, max_activities_scanned),
      paginate("/activity-types/", {}, 200),
    ]);
    const typeName = new Map<number, string>(types.map((t: any) => [t.id, t.name]));

    const dealActivities = activitiesRaw
      .filter((a: any) => a.deal_id === deal_id)
      .map((a: any) => ({
        id: a.id,
        activity_type: a.activity_type,
        activity_type_name: a.activity_type !== null ? typeName.get(a.activity_type) ?? null : null,
        assigned_to: a.assigned_to,
        created_by: a.created_by,
        created_at: a.created_at,
        due_date: a.due_date,
        done_date: a.done_date,
        done: a.done,
        when: activityWhen(a),
        title: a.title ?? a.name ?? null,
        description: a.description ?? "",
        description_length: (a.description ?? "").length,
      }));

    dealActivities.sort((a, b) => {
      const aw = a.when ?? "";
      const bw = b.when ?? "";
      return aw < bw ? -1 : aw > bw ? 1 : 0;
    });

    const DAY_MS = 86_400_000;
    const gapThresholdMs = gap_days * DAY_MS;

    type Gap = {
      from: string;
      to: string;
      days: number;
      before: { id: number; when: string | null; title: string | null; description_excerpt: string };
      after: { id: number; when: string | null; title: string | null; description_excerpt: string };
    };
    const gaps: Gap[] = [];
    for (let i = 1; i < dealActivities.length; i++) {
      const prev = dealActivities[i - 1];
      const curr = dealActivities[i];
      if (!prev.when || !curr.when) continue;
      const deltaMs = Date.parse(curr.when) - Date.parse(prev.when);
      if (!Number.isFinite(deltaMs) || deltaMs <= gapThresholdMs) continue;
      const excerpt = (s: string) => (s.length > 240 ? s.slice(0, 240) + "…" : s);
      gaps.push({
        from: prev.when,
        to: curr.when,
        days: deltaMs / DAY_MS,
        before: {
          id: prev.id,
          when: prev.when,
          title: prev.title,
          description_excerpt: excerpt(prev.description),
        },
        after: {
          id: curr.id,
          when: curr.when,
          title: curr.title,
          description_excerpt: excerpt(curr.description),
        },
      });
    }

    const longest = [...dealActivities]
      .sort((a, b) => b.description_length - a.description_length)
      .slice(0, 3)
      .map((a) => ({
        id: a.id,
        when: a.when,
        activity_type_name: a.activity_type_name,
        title: a.title,
        description_length: a.description_length,
        description: a.description,
      }));

    const now = Date.now();
    // "Last activity" means the latest activity that actually happened.
    // Future-scheduled (not-yet-done) entries don't count — otherwise a deal with a
    // distant "reactivate later" task would never look stale.
    const pastActivities = dealActivities.filter(
      (a) => a.when && Date.parse(a.when) <= now
    );
    const lastActivity = pastActivities.length
      ? pastActivities[pastActivities.length - 1]
      : null;
    const lastActivityMs = lastActivity?.when ? Date.parse(lastActivity.when) : null;
    const daysSinceLast =
      lastActivityMs !== null && Number.isFinite(lastActivityMs)
        ? (now - lastActivityMs) / DAY_MS
        : null;

    const futureScheduled = dealActivities.filter(
      (a) => a.due_date && Date.parse(a.due_date) > now && a.done === false
    );
    const nextStep =
      futureScheduled.length > 0
        ? futureScheduled.reduce((earliest, a) =>
            Date.parse(a.due_date!) < Date.parse(earliest.due_date!) ? a : earliest
          )
        : null;
    const nextStepDaysAhead =
      nextStep && nextStep.due_date ? (Date.parse(nextStep.due_date) - now) / DAY_MS : null;

    const overdue = dealActivities.filter(
      (a) => a.due_date && Date.parse(a.due_date) < now && a.done === false
    );

    const statusName = DEAL_STATUS[deal?.status as keyof typeof DEAL_STATUS] ?? null;

    const flags: Record<string, boolean> = {
      stale:
        statusName === "in_progress" &&
        daysSinceLast !== null &&
        daysSinceLast > gap_days,
      archived_without_reason:
        (statusName === "archived" || statusName === "lost") && !deal?.loss_reason,
      overdue_action: overdue.length > 0,
      no_next_step:
        nextStep === null ||
        (nextStepDaysAhead !== null && nextStepDaysAhead > far_future_days),
      long_idle: daysSinceLast !== null && daysSinceLast > idle_days,
    };

    return asText({
      deal: {
        id: deal?.id ?? deal_id,
        custom_id: deal?.custom_id ?? null,
        name: deal?.name ?? null,
        value: deal?.value ?? null,
        currency: deal?.currency ?? null,
        status: statusName,
        status_raw: deal?.status ?? null,
        stage: deal?.stage ?? null,
        pipeline: deal?.pipeline ?? null,
        assigned_to: deal?.assigned_to ?? null,
        created_at: deal?.created_at ?? null,
        updated_at: deal?.updated_at ?? null,
        won_at: deal?.won_at ?? null,
        lost_at: deal?.lost_at ?? null,
        loss_reason: deal?.loss_reason ?? null,
        expected_close_date: deal?.expected_close_date ?? null,
      },
      activity_summary: {
        total_activities: dealActivities.length,
        first_activity_at: dealActivities[0]?.when ?? null,
        last_activity_at: lastActivity?.when ?? null,
        days_since_last_activity: daysSinceLast,
        next_scheduled_at: nextStep?.due_date ?? null,
        next_scheduled_days_ahead: nextStepDaysAhead,
        overdue_count: overdue.length,
        scanned_activities: activitiesRaw.length,
      },
      flags,
      gaps,
      top3_longest_activities: longest,
      overdue_activities: overdue.map((a) => ({
        id: a.id,
        due_date: a.due_date,
        days_overdue: a.due_date ? (now - Date.parse(a.due_date)) / DAY_MS : null,
        activity_type_name: a.activity_type_name,
        title: a.title,
        description_excerpt: a.description.length > 240 ? a.description.slice(0, 240) + "…" : a.description,
      })),
      activities: dealActivities,
    });
  }
);

server.tool(
  "agent_ownership_audit",
  "Distinguish deals an agent personally CREATED from deals they INHERITED (took over from another agent), and find the agent's real CRM start date.\n" +
    "Critical for analyzing new salespeople who took over an existing portfolio — without this, summaries that filter on `assigned_to` conflate inherited deals with personal ones, and inflate tenure (since inherited deals' created_at predates the agent's start).\n" +
    "Returns: counts of created vs. inherited deals, per-deal breakdown of inherited deals with their original creator, inherited-volume breakdown by original creator, and the timestamp of the agent's earliest self-created activity (= real start in CRM).",
  {
    assigned_to_id: z
      .number()
      .int()
      .describe(
        "Agent's `group_id ?? id` — the value that appears in `deal.assigned_to`. Get from list_agents.assigned_to_id. The matching panel `id` (used for `created_by`) is auto-resolved from /application/."
      ),
    since_date: z
      .string()
      .optional()
      .describe(
        "ISO date — optional lower bound on `deal.created_at` to scope the analysis. The first-activity date is always computed across the full activity scan, ignoring this bound."
      ),
    max_deals_scanned: z.number().int().min(100).max(30000).default(10000),
    max_activities_scanned: z.number().int().min(100).max(50000).default(20000),
  },
  async ({ assigned_to_id, since_date, max_deals_scanned, max_activities_scanned }) => {
    const app = await get("/application/");
    const agent = (app?.agents ?? []).find(
      (a: any) => (a.group_id ?? a.id) === assigned_to_id
    );
    if (!agent) {
      return asText({
        error: `No agent found with assigned_to_id=${assigned_to_id}`,
        hint: "Use list_agents to find the correct assigned_to_id (= group_id ?? id).",
      });
    }
    const panelId = agent.id as number;
    const panelIdNameMap = new Map<number, string>(
      (app?.agents ?? []).map((a: any) => [a.id, a.name])
    );

    const [deals, activities] = await Promise.all([
      paginate("/deals/", {}, max_deals_scanned),
      paginate("/activities/", {}, max_activities_scanned),
    ]);

    const owned = deals.filter((d: any) => {
      if (d.assigned_to !== assigned_to_id) return false;
      if (since_date && (!d.created_at || d.created_at < since_date)) return false;
      return true;
    });

    const created = owned.filter((d: any) => d.created_by === panelId);
    const inherited = owned.filter((d: any) => d.created_by !== panelId);

    const formatDeal = (d: any) => ({
      id: d.id,
      custom_id: d.custom_id,
      name: d.name,
      value: d.value,
      currency: d.currency,
      pipeline: d.pipeline,
      stage: d.stage,
      status: DEAL_STATUS[d.status as keyof typeof DEAL_STATUS] ?? d.status,
      created_at: d.created_at,
      won_at: d.won_at,
      lost_at: d.lost_at,
      original_creator_id: d.created_by ?? null,
      original_creator_name:
        d.created_by !== null && d.created_by !== undefined
          ? panelIdNameMap.get(d.created_by) ?? null
          : null,
    });

    const inheritedDeals = inherited.map(formatDeal).sort((a: any, b: any) => {
      const aw = a.created_at ?? "";
      const bw = b.created_at ?? "";
      return aw < bw ? 1 : aw > bw ? -1 : 0;
    });

    // Inherited volume bucketed by who originally created the deal.
    type CreatorBucket = {
      original_creator_id: number | null;
      original_creator_name: string | null;
      count: number;
      value_by_currency: Record<string, number>;
      status_counts: Record<string, number>;
    };
    const byCreator = new Map<number | null, CreatorBucket>();
    for (const d of inherited) {
      const cb = (d.created_by as number | null) ?? null;
      if (!byCreator.has(cb)) {
        byCreator.set(cb, {
          original_creator_id: cb,
          original_creator_name: cb !== null ? panelIdNameMap.get(cb) ?? null : null,
          count: 0,
          value_by_currency: {},
          status_counts: {},
        });
      }
      const b = byCreator.get(cb)!;
      b.count += 1;
      const cur = d.currency ?? "?";
      b.value_by_currency[cur] = (b.value_by_currency[cur] ?? 0) + Number(d.value ?? 0);
      const status = DEAL_STATUS[d.status as keyof typeof DEAL_STATUS] ?? String(d.status);
      b.status_counts[status] = (b.status_counts[status] ?? 0) + 1;
    }
    const inheritedByCreator = Array.from(byCreator.values()).sort(
      (a, b) => b.count - a.count
    );

    // Earliest activity created by this agent — proxy for their real CRM start date.
    const ownActivities = activities.filter((a: any) => a.created_by === panelId);
    const ownTimestamps = ownActivities
      .map((a: any) => activityWhen(a))
      .filter((w: string | null): w is string => !!w)
      .sort();
    const firstOwnActivityAt = ownTimestamps.length ? ownTimestamps[0] : null;

    // Won/lost summary on created vs. inherited, to expose the most common analytical trap.
    const summarizeOutcomes = (deals: any[]) => {
      let won = 0,
        lost = 0,
        in_progress = 0,
        other = 0;
      for (const d of deals) {
        if (d.status === STATUS_BY_NAME.won) won += 1;
        else if (d.status === STATUS_BY_NAME.lost) lost += 1;
        else if (d.status === STATUS_BY_NAME.in_progress) in_progress += 1;
        else other += 1;
      }
      return { won, lost, in_progress, other };
    };

    return asText({
      agent: {
        panel_id: panelId,
        assigned_to_id,
        group_id: agent.group_id ?? null,
        name: agent.name,
        email: agent.email,
      },
      window: { since_date: since_date ?? null },
      deals_scanned: deals.length,
      activities_scanned: activities.length,
      total_owned: owned.length,
      created_count: created.length,
      inherited_count: inherited.length,
      outcomes: {
        created: summarizeOutcomes(created),
        inherited: summarizeOutcomes(inherited),
      },
      first_own_activity_at: firstOwnActivityAt,
      own_activities_count: ownActivities.length,
      inherited_by_original_creator: inheritedByCreator,
      inherited_deals: inheritedDeals,
    });
  }
);

// ---------- Boot ----------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`usercom-crm MCP ready (subdomain=${SUBDOMAIN})`);
