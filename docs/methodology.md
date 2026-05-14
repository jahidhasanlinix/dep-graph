# Tool dependency graph methodology

This submission builds a precursor-action graph for the Composio `googlesuper` and `github` toolkits.

## What the graph means

- **Node**: a Composio tool/action.
- **Directed edge**: `source -> target` means the source tool can obtain or create a required input for the target tool.
- **Edge label**: the target input being satisfied, plus a confidence score in the DOT output.
- **Need record**: every required target input is classified as:
  - `resolvable`: at least one precursor tool was found.
  - `ask_user`: no strong provider was found; ask the user for that value.
  - `literal_or_user`: content-like values such as message bodies, titles, descriptions, and search queries that normally come from the user's task rather than another tool.

## Extraction algorithm

1. Fetch raw Composio tools from `GET /api/v3.1/tools` for `googlesuper` and `github` using `COMPOSIO_API_KEY` from `.env` or the environment.
2. Normalize both object-style and JSON-Schema-style `input_parameters` / `output_parameters`.
3. Treat each required input as a dependency need.
4. Score candidate precursor tools from the same toolkit with a weighted blend of:
   - exact output parameter matches, such as `thread_id -> thread_id`;
   - resource alias matches, such as `to` / `cc` / `bcc` being resolvable by contacts/people tools;
   - discovery action verbs (`LIST`, `GET`, `FIND`, `SEARCH`, `FETCH`);
   - creation action verbs when the target needs an object that can be created first;
   - curated high-value resolver rules for Gmail threads/messages, Google contacts, Drive files, Sheets, Calendar events, GitHub repos, issues, PRs, workflows, runs, releases, branches, commits, and users.
5. Emit high-confidence edges to JSON, DOT, and an HTML/SVG visual report.

## Why a curated seed exists

The script falls back to representative seed schemas when the Composio API is unreachable. This keeps the assignment reviewable offline and still demonstrates the expected graph shape. With a valid API key and network access, the same code fetches the full live `googlesuper` and `github` tool lists and regenerates the graph from the raw schemas.

## Outputs

- `dist/raw-tools.json`: raw or seed tool schemas used for this run.
- `dist/dependency-graph.json`: complete graph plus per-input resolution decisions.
- `dist/dependency-graph.dot`: Graphviz DOT for external visualization.
- `dist/dependency-graph.html`: self-contained visual graph and input resolution table.

## How to run and verify

1. Put `COMPOSIO_API_KEY=...` in `.env`, or run the fixed scaffold with `COMPOSIO_API_KEY=... sh scaffold.sh` to create `.env` with both Composio and OpenRouter keys. The scaffold now sends the required `x-composio-api-key` header and can also reuse an existing `.env`.
2. Run `bun run build:graph` to generate the latest graph artifacts.
3. Run `bun run check` to verify the TypeScript entry point bundles successfully.
4. Open `dist/dependency-graph.html` in a browser to inspect the visual graph, or inspect `dist/dependency-graph.json` for the complete dependency and input-resolution data.
5. Submit with `sh upload.sh <your_email>`; if you intentionally do not want session traces, use `sh upload.sh <your_email> --skip-session`.
