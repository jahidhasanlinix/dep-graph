import { mkdir, readFile, writeFile } from "node:fs/promises";

type ToolkitSlug = "googlesuper" | "github";

type Parameter = {
  type?: string;
  description?: string;
  required?: boolean;
  enum?: string[];
  examples?: unknown[];
};

type Tool = {
  slug: string;
  name?: string;
  description?: string;
  human_description?: string;
  toolkit?: { slug?: string; name?: string };
  input_parameters?: Record<string, Parameter> | { properties?: Record<string, Parameter>; required?: string[] };
  output_parameters?: Record<string, Parameter> | { properties?: Record<string, Parameter>; required?: string[] };
  tags?: string[];
  is_deprecated?: boolean;
};

type NormalizedParam = Parameter & { name: string; required: boolean };

type Edge = {
  from: string;
  to: string;
  input: string;
  kind: "exact_output" | "resource_provider" | "resolver" | "identity";
  confidence: number;
  rationale: string;
};

type Need = {
  tool: string;
  input: string;
  status: "resolvable" | "ask_user" | "literal_or_user";
  providers: string[];
  note: string;
};

const TOOLKITS: ToolkitSlug[] = ["googlesuper", "github"];
const OUT_DIR = "dist";
const RAW_FILE = `${OUT_DIR}/raw-tools.json`;
const GRAPH_FILE = `${OUT_DIR}/dependency-graph.json`;
const DOT_FILE = `${OUT_DIR}/dependency-graph.dot`;
const HTML_FILE = `${OUT_DIR}/dependency-graph.html`;

const RESOURCE_ALIASES: Record<string, string[]> = {
  // Cross-Google identity/contact resolution.
  email: ["email", "contact", "people", "profile", "user"],
  recipient: ["email", "contact", "people", "profile", "user"],
  to: ["email", "contact", "people"],
  cc: ["email", "contact", "people"],
  bcc: ["email", "contact", "people"],
  thread: ["thread", "message", "email"],
  thread_id: ["thread", "message", "email"],
  message: ["message", "email", "thread"],
  message_id: ["message", "email", "thread"],
  attachment: ["attachment", "message", "email"],
  attachment_id: ["attachment", "message", "email"],
  label: ["label", "gmail"],
  label_id: ["label", "gmail"],
  draft: ["draft", "email"],
  draft_id: ["draft", "email"],
  file: ["file", "drive", "folder", "document", "spreadsheet", "sheet", "slides"],
  file_id: ["file", "drive", "folder", "document", "spreadsheet", "sheet", "slides"],
  folder: ["folder", "file", "drive"],
  folder_id: ["folder", "file", "drive"],
  document: ["document", "doc", "file", "drive"],
  document_id: ["document", "doc", "file", "drive"],
  spreadsheet: ["spreadsheet", "sheet", "file", "drive"],
  spreadsheet_id: ["spreadsheet", "sheet", "file", "drive"],
  sheet: ["sheet", "worksheet", "spreadsheet"],
  sheet_id: ["sheet", "worksheet", "spreadsheet"],
  calendar: ["calendar", "event"],
  calendar_id: ["calendar", "event"],
  event: ["event", "calendar"],
  event_id: ["event", "calendar"],
  task: ["task", "tasklist"],
  task_id: ["task", "tasklist"],
  tasklist: ["tasklist", "task list", "task"],
  tasklist_id: ["tasklist", "task list", "task"],
  // GitHub.
  repo: ["repository", "repo"],
  repository: ["repository", "repo"],
  repo_name: ["repository", "repo"],
  owner: ["owner", "user", "organization", "org", "repository"],
  org: ["organization", "org"],
  organization: ["organization", "org"],
  username: ["user", "member", "collaborator", "assignee"],
  assignee: ["user", "member", "collaborator", "assignee"],
  issue: ["issue"],
  issue_number: ["issue"],
  pull: ["pull request", "pull", "pr"],
  pull_number: ["pull request", "pull", "pr"],
  comment: ["comment", "issue", "pull request", "review"],
  comment_id: ["comment", "issue", "pull request", "review"],
  review: ["review", "pull request"],
  review_id: ["review", "pull request"],
  review_comment_id: ["review comment", "pull request", "comment"],
  branch: ["branch", "ref", "repository"],
  sha: ["commit", "sha", "ref", "branch"],
  ref: ["ref", "branch", "tag", "commit"],
  release: ["release", "tag"],
  release_id: ["release", "tag"],
  tag: ["tag", "release", "ref"],
  workflow: ["workflow", "actions"],
  workflow_id: ["workflow", "actions"],
  run_id: ["workflow run", "run", "actions"],
  job_id: ["job", "workflow run", "actions"],
  artifact_id: ["artifact", "workflow run", "actions"],
  gist: ["gist"],
  gist_id: ["gist"],
  team_slug: ["team"],
  project_id: ["project"],
  milestone_number: ["milestone"],
};

const LITERAL_INPUT_HINTS = new Set([
  "body",
  "title",
  "subject",
  "message",
  "content",
  "text",
  "query",
  "q",
  "page",
  "per_page",
  "limit",
  "max_results",
  "start_time",
  "end_time",
  "time_min",
  "time_max",
  "description",
]);

const DISCOVERY_VERBS = ["LIST", "GET", "FIND", "SEARCH", "FETCH"];
const CREATION_VERBS = ["CREATE", "INSERT", "GENERATE"];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const tools = await loadTools();
  const graph = buildGraph(tools);
  await writeFile(RAW_FILE, JSON.stringify(tools, null, 2));
  await writeFile(GRAPH_FILE, JSON.stringify(graph, null, 2));
  await writeFile(DOT_FILE, toDot(graph));
  await writeFile(HTML_FILE, toHtml(graph));
  console.log(`Generated ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.needs.length} input decisions.`);
  console.log(`Open ${HTML_FILE} to inspect the visual graph.`);
}

async function loadTools(): Promise<Tool[]> {
  const env = await readEnv();
  if (env.COMPOSIO_API_KEY) {
    try {
      const fetched: Tool[] = [];
      for (const toolkit of TOOLKITS) fetched.push(...(await fetchToolkitTools(toolkit, env.COMPOSIO_API_KEY)));
      if (fetched.length > 0) return dedupeTools(fetched);
    } catch (error) {
      console.warn(`Composio fetch failed; using curated seed schemas. Reason: ${String(error)}`);
    }
  } else {
    console.warn("COMPOSIO_API_KEY not found; using curated seed schemas.");
  }
  return seedTools;
}

async function readEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  try {
    const content = await readFile(".env", "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      env[key] ||= value;
    }
  } catch {}
  return env;
}

async function fetchToolkitTools(toolkit: ToolkitSlug, apiKey: string): Promise<Tool[]> {
  const result: Tool[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ toolkit_slug: toolkit, limit: "1000", toolkit_versions: "latest" });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`https://backend.composio.dev/api/v3.1/tools?${params}`, {
      headers: { "x-api-key": apiKey },
    });
    if (!response.ok) throw new Error(`${toolkit} fetch returned ${response.status}: ${await response.text()}`);
    const payload = (await response.json()) as { items?: Tool[]; next_cursor?: string | null } | Tool[];
    if (Array.isArray(payload)) {
      result.push(...payload);
      cursor = undefined;
    } else {
      result.push(...(payload.items ?? []));
      cursor = payload.next_cursor ?? undefined;
    }
  } while (cursor);
  return result;
}

function dedupeTools(tools: Tool[]): Tool[] {
  const seen = new Map<string, Tool>();
  for (const tool of tools) if (!tool.is_deprecated) seen.set(tool.slug, tool);
  return [...seen.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

function buildGraph(tools: Tool[]) {
  const nodes = tools.map((tool) => ({
    id: tool.slug,
    label: tool.slug.replace(/^(GOOGLESUPER|GITHUB)_/, ""),
    toolkit: toolkitOf(tool),
    name: tool.name ?? tool.human_description ?? tool.description ?? tool.slug,
    inputs: normalizeParams(tool.input_parameters),
    outputs: normalizeParams(tool.output_parameters),
  }));

  const edges: Edge[] = [];
  const needs: Need[] = [];
  for (const target of tools) {
    for (const input of normalizeParams(target.input_parameters).filter((param) => param.required)) {
      const inputResource = resourceForInput(input.name, input.description);
      if (isLiteralInput(input.name, input.description)) {
        needs.push({ tool: target.slug, input: input.name, status: "literal_or_user", providers: [], note: "Task-specific content/value; usually ask the user or derive from the user instruction." });
        continue;
      }

      const candidates = scoreProviders(input, inputResource, target, tools)
        .filter((candidate) => candidate.score >= 45)
        .slice(0, 7);
      for (const candidate of candidates) {
        edges.push({
          from: candidate.tool.slug,
          to: target.slug,
          input: input.name,
          kind: candidate.kind,
          confidence: candidate.score,
          rationale: candidate.rationale,
        });
      }
      needs.push({
        tool: target.slug,
        input: input.name,
        status: candidates.length > 0 ? "resolvable" : "ask_user",
        providers: candidates.map((candidate) => candidate.tool.slug),
        note: candidates.length > 0 ? `Resolve ${input.name} with discovery/provider tools before calling ${target.slug}.` : `No strong provider found; ask user for ${input.name}.`,
      });
    }
  }

  return {
    generated_at: new Date().toISOString(),
    methodology: [
      "Required inputs become needs.",
      "Provider edges point from a tool that can discover/create/get a resource to a tool requiring that resource.",
      "Exact output-parameter matches are highest confidence; resource/action-name matches and hand-authored aliases fill gaps for IDs, contacts, GitHub repositories, issues, PRs, runs, and Google Workspace resources.",
      "Literal content inputs are marked as user/task inputs rather than tool dependencies.",
    ],
    nodes,
    edges: dedupeEdges(edges).sort((a, b) => b.confidence - a.confidence || a.from.localeCompare(b.from)),
    needs,
  };
}

function scoreProviders(input: NormalizedParam, inputResource: string, target: Tool, tools: Tool[]) {
  const targetToolkit = toolkitOf(target);
  const targetText = textFor(target);
  const scored: Array<{ tool: Tool; score: number; kind: Edge["kind"]; rationale: string }> = [];
  for (const source of tools) {
    if (source.slug === target.slug || toolkitOf(source) !== targetToolkit) continue;
    const sourceText = textFor(source);
    const outputs = normalizeParams(source.output_parameters);
    const sourceVerb = source.slug.split("_")[1] ?? "";
    let score = 0;
    let kind: Edge["kind"] = "resource_provider";
    const reasons: string[] = [];

    if (outputs.some((output) => equivalentParam(output.name, input.name))) {
      score += 65;
      kind = "exact_output";
      reasons.push(`outputs ${input.name}`);
    }
    if (outputs.some((output) => resourceForInput(output.name, output.description) === inputResource)) {
      score += 35;
      reasons.push(`outputs ${inputResource}`);
    }
    for (const alias of aliasesFor(inputResource)) {
      if (sourceText.includes(alias)) {
        score += 18;
        reasons.push(`mentions ${alias}`);
        break;
      }
    }
    if (DISCOVERY_VERBS.includes(sourceVerb) || source.slug.includes("_LIST_") || source.slug.includes("_GET_") || source.slug.includes("_FIND_") || source.slug.includes("_SEARCH_") || source.slug.includes("_FETCH_")) {
      score += 22;
      reasons.push("discovery/get/list action");
    }
    if (CREATION_VERBS.includes(sourceVerb) && targetText.includes(inputResource.replace(/_/g, " "))) {
      score += 12;
      reasons.push("can create the needed resource");
    }
    if (isResolverPair(inputResource, source.slug)) {
      score += 35;
      kind = "resolver";
      reasons.push("known resolver pattern");
    }
    if (source.slug.includes("AUTHENTICATED_USER") && ["owner", "username", "email"].includes(inputResource)) {
      score += 15;
      kind = "identity";
      reasons.push("authenticated identity source");
    }
    if (source.slug.includes("DELETE") || source.slug.includes("REMOVE") || source.slug.includes("UPDATE") || source.slug.includes("PATCH")) score -= 30;
    if (target.slug.includes("DELETE") && source.slug.includes("CREATE")) score -= 10;

    if (score > 0) scored.push({ tool: source, score: Math.min(100, score), kind, rationale: reasons.join("; ") });
  }
  return scored.sort((a, b) => b.score - a.score || a.tool.slug.localeCompare(b.tool.slug));
}

function normalizeParams(parameters: Tool["input_parameters"]): NormalizedParam[] {
  if (!parameters) return [];
  const properties = "properties" in parameters ? (parameters.properties ?? {}) : parameters;
  const required = new Set("required" in parameters && Array.isArray(parameters.required) ? parameters.required : []);
  return Object.entries(properties).map(([name, parameter]) => ({ ...parameter, name, required: Boolean(parameter.required || required.has(name)) }));
}

function textFor(tool: Tool): string {
  return `${tool.slug} ${tool.name ?? ""} ${tool.description ?? ""} ${tool.human_description ?? ""} ${(tool.tags ?? []).join(" ")}`.toLowerCase().replace(/_/g, " ");
}

function toolkitOf(tool: Tool): ToolkitSlug {
  return (tool.toolkit?.slug?.toLowerCase() as ToolkitSlug) ?? (tool.slug.startsWith("GITHUB_") ? "github" : "googlesuper");
}

function resourceForInput(name: string, description = ""): string {
  const key = name.toLowerCase();
  if (RESOURCE_ALIASES[key]) return key;
  const normalized = `${name} ${description}`.toLowerCase().replace(/[_-]/g, " ");
  for (const candidate of Object.keys(RESOURCE_ALIASES).sort((a, b) => b.length - a.length)) {
    const words = candidate.replace(/_/g, " ");
    if (normalized.includes(words)) return candidate;
  }
  if (key.endsWith("_id")) return key;
  return key.replace(/_ids?$/, "");
}

function aliasesFor(resource: string): string[] {
  return RESOURCE_ALIASES[resource] ?? [resource.replace(/_/g, " ")];
}

function equivalentParam(a: string, b: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/^(id|the)_/, "").replace(/_ids$/, "_id");
  return normalize(a) === normalize(b) || resourceForInput(a) === resourceForInput(b);
}

function isLiteralInput(name: string, description = ""): boolean {
  const key = name.toLowerCase();
  if (LITERAL_INPUT_HINTS.has(key)) return true;
  if (key.endsWith("_id") || key.endsWith("_number") || ["owner", "repo", "repo_name", "email", "to", "cc", "bcc", "username", "org"].includes(key)) return false;
  return /content|body|title|subject|description|query|prompt|text|markdown|message body/.test(`${key} ${description}`.toLowerCase());
}

function isResolverPair(resource: string, slug: string): boolean {
  const pairs: Record<string, string[]> = {
    email: ["GET_CONTACTS", "GET_PEOPLE", "GET_PROFILE"],
    recipient: ["GET_CONTACTS", "GET_PEOPLE"],
    to: ["GET_CONTACTS", "GET_PEOPLE", "GET_PROFILE"],
    cc: ["GET_CONTACTS", "GET_PEOPLE", "GET_PROFILE"],
    bcc: ["GET_CONTACTS", "GET_PEOPLE", "GET_PROFILE"],
    thread_id: ["FETCH_EMAILS", "FETCH_MESSAGE_BY_THREAD_ID", "FETCH_MESSAGE_BY_MESSAGE_ID"],
    message_id: ["FETCH_EMAILS", "FETCH_MESSAGE_BY_THREAD_ID"],
    repo_name: ["FIND_REPOSITORIES", "GET_A_REPOSITORY", "LIST_REPOSITORIES"],
    issue_number: ["GET_AN_ISSUE", "LIST_REPOSITORY_ISSUES", "CREATE_AN_ISSUE"],
    pull_number: ["FIND_PULL_REQUESTS", "GET_A_PULL_REQUEST", "LIST_PULL_REQUESTS"],
    run_id: ["LIST_WORKFLOW_RUNS", "GET_A_WORKFLOW_RUN"],
    workflow_id: ["GET_A_WORKFLOW", "LIST_REPOSITORY_WORKFLOWS"],
  };
  return (pairs[resource] ?? []).some((fragment) => slug.includes(fragment));
}

function dedupeEdges(edges: Edge[]): Edge[] {
  const seen = new Map<string, Edge>();
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}:${edge.input}`;
    const current = seen.get(key);
    if (!current || edge.confidence > current.confidence) seen.set(key, edge);
  }
  return [...seen.values()];
}

function toDot(graph: ReturnType<typeof buildGraph>): string {
  const edgeLines = graph.edges
    .filter((edge) => edge.confidence >= 55)
    .slice(0, 400)
    .map((edge) => `  "${edge.from}" -> "${edge.to}" [label="${edge.input} (${edge.confidence})"];`);
  const nodeLines = graph.nodes.map((node) => `  "${node.id}" [label="${node.label}", group="${node.toolkit}"];`);
  return `digraph ToolDependencyGraph {\n  rankdir=LR;\n  graph [overlap=false, splines=true];\n  node [shape=box, style="rounded,filled", fillcolor="#f8fafc", fontname="Arial"];\n  edge [fontname="Arial", color="#64748b"];\n${nodeLines.join("\n")}\n${edgeLines.join("\n")}\n}\n`;
}

function toHtml(graph: ReturnType<typeof buildGraph>): string {
  const visibleEdges = graph.edges.filter((edge) => edge.confidence >= 55).slice(0, 250);
  const visibleNodeIds = new Set(visibleEdges.flatMap((edge) => [edge.from, edge.to]));
  const visibleNodes = graph.nodes.filter((node) => visibleNodeIds.has(node.id));
  const cols = 4;
  const cellW = 270;
  const cellH = 92;
  const positions = new Map<string, { x: number; y: number }>();
  visibleNodes.forEach((node, index) => positions.set(node.id, { x: 40 + (index % cols) * cellW, y: 80 + Math.floor(index / cols) * cellH }));
  const height = Math.max(600, 140 + Math.ceil(visibleNodes.length / cols) * cellH);
  const nodeSvg = visibleNodes.map((node) => {
    const pos = positions.get(node.id)!;
    const fill = node.toolkit === "github" ? "#eff6ff" : "#f0fdf4";
    const stroke = node.toolkit === "github" ? "#2563eb" : "#16a34a";
    return `<g><rect x="${pos.x}" y="${pos.y}" width="230" height="54" rx="10" fill="${fill}" stroke="${stroke}"/><text x="${pos.x + 10}" y="${pos.y + 22}" font-size="12" font-weight="700">${escapeHtml(node.label).slice(0, 30)}</text><text x="${pos.x + 10}" y="${pos.y + 40}" font-size="10" fill="#475569">${node.toolkit}</text></g>`;
  }).join("\n");
  const edgeSvg = visibleEdges.map((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return "";
    const x1 = from.x + 230;
    const y1 = from.y + 27;
    const x2 = to.x;
    const y2 = to.y + 27;
    const midX = (x1 + x2) / 2;
    const labelY = (y1 + y2) / 2 - 4;
    return `<path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" stroke="#64748b" fill="none" marker-end="url(#arrow)" opacity="0.55"/><text x="${midX}" y="${labelY}" font-size="9" fill="#334155">${escapeHtml(edge.input)}</text>`;
  }).join("\n");
  const tableRows = graph.needs.slice(0, 300).map((need) => `<tr><td>${need.status}</td><td>${need.tool}</td><td>${need.input}</td><td>${need.providers.slice(0, 5).join("<br>") || "ask user"}</td></tr>`).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Composio Tool Dependency Graph</title><style>body{font-family:Inter,Arial,sans-serif;margin:24px;color:#0f172a}svg{border:1px solid #e2e8f0;border-radius:12px;background:#fff;width:100%;height:${height}px}table{border-collapse:collapse;width:100%;font-size:12px}td,th{border:1px solid #e2e8f0;padding:6px;text-align:left;vertical-align:top}th{background:#f8fafc}.pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#e2e8f0}</style></head><body><h1>Composio Tool Dependency Graph</h1><p>Generated from ${graph.nodes.length} tools. Showing the top ${visibleEdges.length} high-confidence precursor edges. Edge label = input fulfilled by the source tool.</p><p><span class="pill">Blue: GitHub</span> <span class="pill">Green: Google Super</span></p><svg viewBox="0 0 ${cols * cellW + 80} ${height}" role="img"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#64748b"/></marker></defs>${edgeSvg}${nodeSvg}</svg><h2>Input resolution table</h2><table><thead><tr><th>Status</th><th>Tool</th><th>Required input</th><th>Suggested precursor providers</th></tr></thead><tbody>${tableRows}</tbody></table></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
}

const seedTools: Tool[] = [
  t("GOOGLESUPER_FETCH_EMAILS", "googlesuper", {}, { message_id: "string", thread_id: "string", from_email: "string", subject: "string" }, "Fetch emails from Gmail; list messages and threads."),
  t("GOOGLESUPER_FETCH_MESSAGE_BY_MESSAGE_ID", "googlesuper", { message_id: "string" }, { message_id: "string", thread_id: "string", attachment_id: "string" }, "Fetch a Gmail message by ID."),
  t("GOOGLESUPER_FETCH_MESSAGE_BY_THREAD_ID", "googlesuper", { thread_id: "string" }, { message_id: "string", thread_id: "string" }, "Fetch Gmail messages in a thread."),
  t("GOOGLESUPER_CREATE_REPLY", "googlesuper", { thread_id: "string", body: "string" }, { message_id: "string", thread_id: "string" }, "Reply to an existing Gmail thread."),
  t("GOOGLESUPER_FORWARD_MESSAGE", "googlesuper", { message_id: "string", to: "string", body: "string" }, { message_id: "string" }, "Forward an email message."),
  t("GOOGLESUPER_CREATE_EMAIL_DRAFT", "googlesuper", { to: "string", subject: "string", body: "string" }, { draft_id: "string", message_id: "string" }, "Create a Gmail draft."),
  t("GOOGLESUPER_SEND_EMAIL", "googlesuper", { to: "string", subject: "string", body: "string" }, { message_id: "string", thread_id: "string" }, "Send email to recipients."),
  t("GOOGLESUPER_GET_CONTACTS", "googlesuper", {}, { email: "string", name: "string" }, "Get Google contacts for resolving people to email addresses."),
  t("GOOGLESUPER_GET_PEOPLE", "googlesuper", {}, { email: "string", name: "string" }, "Search Google People profile/contact data."),
  t("GOOGLESUPER_FIND_FILE", "googlesuper", { query: "string" }, { file_id: "string", name: "string" }, "Find a Google Drive file."),
  t("GOOGLESUPER_FIND_FOLDER", "googlesuper", { query: "string" }, { folder_id: "string", file_id: "string" }, "Find a Google Drive folder."),
  t("GOOGLESUPER_CREATE_FILE", "googlesuper", { name: "string", folder_id: "string" }, { file_id: "string" }, "Create a Drive file or folder."),
  t("GOOGLESUPER_GET_FILE_METADATA", "googlesuper", { file_id: "string" }, { file_id: "string", name: "string" }, "Get Drive file metadata."),
  t("GOOGLESUPER_DOWNLOAD_FILE", "googlesuper", { file_id: "string" }, { content: "string" }, "Download a file from Drive."),
  t("GOOGLESUPER_GET_DOCUMENT_BY_ID", "googlesuper", { document_id: "string" }, { document_id: "string" }, "Get a Google Doc by ID."),
  t("GOOGLESUPER_CREATE_DOCUMENT", "googlesuper", { title: "string" }, { document_id: "string", file_id: "string" }, "Create a Google document."),
  t("GOOGLESUPER_INSERT_TEXT_ACTION", "googlesuper", { document_id: "string", text: "string" }, { document_id: "string" }, "Insert text into a Google Doc."),
  t("GOOGLESUPER_CREATE_GOOGLE_SHEET1", "googlesuper", { title: "string" }, { spreadsheet_id: "string", file_id: "string" }, "Create a Google Sheet."),
  t("GOOGLESUPER_GET_SPREADSHEET_INFO", "googlesuper", { spreadsheet_id: "string" }, { spreadsheet_id: "string", sheet_id: "string", sheet_name: "string" }, "Get spreadsheet info."),
  t("GOOGLESUPER_GET_SHEET_NAMES", "googlesuper", { spreadsheet_id: "string" }, { sheet_id: "string", sheet_name: "string" }, "List sheet names in a spreadsheet."),
  t("GOOGLESUPER_ADD_SHEET", "googlesuper", { spreadsheet_id: "string", title: "string" }, { sheet_id: "string" }, "Add sheet to an existing spreadsheet."),
  t("GOOGLESUPER_CREATE_SPREADSHEET_ROW", "googlesuper", { spreadsheet_id: "string", sheet_id: "string", values: "array" }, { row_id: "string" }, "Create spreadsheet row."),
  t("GOOGLESUPER_LIST_CALENDARS", "googlesuper", {}, { calendar_id: "string", summary: "string" }, "List Google calendars."),
  t("GOOGLESUPER_EVENTS_LIST", "googlesuper", { calendar_id: "string" }, { event_id: "string", calendar_id: "string" }, "List calendar events."),
  t("GOOGLESUPER_FIND_EVENT", "googlesuper", { calendar_id: "string", query: "string" }, { event_id: "string", calendar_id: "string" }, "Find calendar event."),
  t("GOOGLESUPER_CREATE_EVENT", "googlesuper", { calendar_id: "string", summary: "string", start_time: "string", end_time: "string" }, { event_id: "string", calendar_id: "string" }, "Create calendar event."),
  t("GOOGLESUPER_DELETE_EVENT", "googlesuper", { calendar_id: "string", event_id: "string" }, {}, "Delete calendar event."),
  t("GOOGLESUPER_LIST_ALL_TASKS", "googlesuper", {}, { task_id: "string", tasklist_id: "string" }, "List Google Tasks."),
  t("GOOGLESUPER_CREATE_TASK_LIST", "googlesuper", { title: "string" }, { tasklist_id: "string" }, "Create task list."),
  t("GOOGLESUPER_INSERT_TASK", "googlesuper", { tasklist_id: "string", title: "string" }, { task_id: "string", tasklist_id: "string" }, "Insert task."),
  t("GITHUB_FIND_REPOSITORIES", "github", { query: "string" }, { repo_name: "string", owner: "string", repo: "string" }, "Find GitHub repositories."),
  t("GITHUB_GET_A_REPOSITORY", "github", { owner: "string", repo: "string" }, { repo_name: "string", owner: "string", repo: "string", default_branch: "string" }, "Get a repository."),
  t("GITHUB_CREATE_AN_ISSUE", "github", { owner: "string", repo: "string", title: "string", body: "string" }, { issue_number: "number" }, "Create an issue."),
  t("GITHUB_GET_AN_ISSUE", "github", { owner: "string", repo: "string", issue_number: "number" }, { issue_number: "number", assignee: "string" }, "Get an issue."),
  t("GITHUB_ADD_ASSIGNEES_TO_AN_ISSUE", "github", { owner: "string", repo: "string", issue_number: "number", assignees: "array" }, {}, "Add assignees to issue."),
  t("GITHUB_CREATE_AN_ISSUE_COMMENT", "github", { owner: "string", repo: "string", issue_number: "number", body: "string" }, { comment_id: "number" }, "Comment on issue."),
  t("GITHUB_FIND_PULL_REQUESTS", "github", { query: "string" }, { pull_number: "number", owner: "string", repo: "string" }, "Find pull requests."),
  t("GITHUB_CREATE_A_PULL_REQUEST", "github", { owner: "string", repo: "string", title: "string", head: "string", base: "string", body: "string" }, { pull_number: "number" }, "Create PR."),
  t("GITHUB_GET_A_PULL_REQUEST", "github", { owner: "string", repo: "string", pull_number: "number" }, { pull_number: "number", head: "string", base: "string" }, "Get PR."),
  t("GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST", "github", { owner: "string", repo: "string", pull_number: "number", body: "string" }, { review_id: "number" }, "Review PR."),
  t("GITHUB_GET_A_BRANCH", "github", { owner: "string", repo: "string", branch: "string" }, { branch: "string", sha: "string" }, "Get branch."),
  t("GITHUB_GET_A_COMMIT", "github", { owner: "string", repo: "string", ref: "string" }, { sha: "string" }, "Get commit."),
  t("GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS", "github", { owner: "string", repo: "string", path: "string", content: "string", branch: "string" }, { sha: "string" }, "Create or update file."),
  t("GITHUB_LIST_REPOSITORY_WORKFLOWS", "github", { owner: "string", repo: "string" }, { workflow_id: "number" }, "List repository workflows."),
  t("GITHUB_CREATE_A_WORKFLOW_DISPATCH_EVENT", "github", { owner: "string", repo: "string", workflow_id: "string", ref: "string" }, { run_id: "number" }, "Trigger workflow."),
  t("GITHUB_GET_A_WORKFLOW_RUN", "github", { owner: "string", repo: "string", run_id: "number" }, { run_id: "number", status: "string" }, "Get workflow run."),
  t("GITHUB_DOWNLOAD_WORKFLOW_RUN_LOGS", "github", { owner: "string", repo: "string", run_id: "number" }, { url: "string" }, "Download run logs."),
  t("GITHUB_CREATE_A_RELEASE", "github", { owner: "string", repo: "string", tag_name: "string", name: "string" }, { release_id: "number", tag_name: "string" }, "Create release."),
  t("GITHUB_GET_A_RELEASE", "github", { owner: "string", repo: "string", release_id: "number" }, { release_id: "number", tag_name: "string" }, "Get release."),
  t("GITHUB_GET_A_USER", "github", { username: "string" }, { username: "string", email: "string" }, "Get a user."),
];

function t(slug: string, toolkit: ToolkitSlug, inputs: Record<string, string>, outputs: Record<string, string>, description: string): Tool {
  const make = (entries: Record<string, string>) => Object.fromEntries(Object.entries(entries).map(([name, type]) => [name, { type, required: true, description: `${name} parameter` }]));
  return { slug, toolkit: { slug: toolkit }, description, input_parameters: make(inputs), output_parameters: make(outputs) };
}

await main();
