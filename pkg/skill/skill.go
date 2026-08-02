// Package skill generates the agent-facing "how to drive vh-solara" skill
// (SKILL.md) from the LIVE surface — the MCP tool definitions and the gate{}
// struct — so it is version-synced to the binary and can't drift from a
// hand-authored copy. vh-solara owns this surface doc; a consuming repo installs
// it (provisioned) rather than maintaining a copy.
package skill

import (
	"fmt"
	"reflect"
	"sort"
	"strings"

	"github.com/vhqtvn/vh-solara/pkg/mcp"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// DefaultInstallDir is the suggested location inside a consuming repo.
const DefaultInstallDir = ".opencode/skills/vh-solara"

// gateSemantics is the curated one-line meaning per gate{} field. Field NAMES are
// taken from the struct via reflection (so a new field can't silently go
// undocumented); this only supplies prose.
var gateSemantics = map[string]string{
	"activity":                 "idle | busy | retry | error.",
	"hydrated":                 "message state loaded (live or history). The message-derived fields below are authoritative only when true; on a cold/never-opened session after a restart they read \"not yet known\", NOT \"in-flight\".",
	"last_assistant_completed": "the latest assistant turn has time.completed.",
	"finish_reason":            "raw opencode `finish` (stop|length|tool-calls). The completion REASON, not a content signal — present on every completed turn, so it can't tell empty from non-empty content.",
	"last_assistant_empty":     "the latest assistant turn produced no text AND no tool/file content (envelope only, e.g. an empty stop). A tool-only turn is NON-empty (the agent is working).",
	"subtree_busy":             "any session in this subtree (incl. self) is busy/retry.",
	"pending_question":         "a question awaits a TYPED reply — a plain message will NOT satisfy it.",
	"pending_permission":       "a permission awaits a typed reply (once|always|reject).",
	"permission_blocked":       "OBSERVABLE FACT (not a policy): this session's fail-closed spawn policy auto-rejected a prompt. Sticky past the permission clearing so a caller sees it post-hoc; cleared on session termination. Implies the spawn carried permission_policy=fail_fast.",
	"tokens":                   "raw token-usage object of the latest assistant turn.",
}

// Generate renders the full SKILL.md for the given binary version.
func Generate(version string) string {
	var b strings.Builder
	p := func(format string, a ...any) { fmt.Fprintf(&b, format, a...) }

	p("---\n")
	p("name: vh-solara\n")
	p("description: Drive vh-solara — read session state via the gate{} facts and act via the typed verbs (send/spawn/abort/answer-question/reply-permission), locally or across machines. Generated for vh-solara %s.\n", version)
	p("---\n\n")

	p("# Driving vh-solara (coordination client) — %s\n\n", version)
	p("vh-solara surfaces raw opencode facts and read/write/subscribe verbs; it carries NO\n")
	p("coordination policy. This skill is GENERATED from the running binary's surface and\n")
	p("version-stamped, so it can't drift — re-provision (`vh-solara skill install`) on upgrade.\n")
	p("Drift-check with no binary: `GET /vh/skill/emit` returns these exact bytes from the\n")
	p("running daemon (header `X-VH-Skill-Version`); diff it against your committed copy.\n\n")

	p("**Worker prerequisite:** the API lives on vh-solara's own web server, served only when a\n")
	p("worker runs `--web vh` (`local-server`, or `client-daemon --web vh`).\n\n")

	// --- gate{} facts (field names reflected from state.GateFacts) ---
	p("## gate{} — per-session facts (on every /vh/snapshot and the stream snapshot)\n\n")
	p("Keyed by sessionID. Compose the send/act gate from these — one snapshot, no N+1.\n\n")
	t := reflect.TypeOf(state.GateFacts{})
	for i := 0; i < t.NumField(); i++ {
		tag := t.Field(i).Tag.Get("json")
		name := strings.Split(tag, ",")[0]
		if name == "" || name == "-" {
			continue
		}
		sem := gateSemantics[name]
		if sem == "" {
			sem = "(see vh-solara docs)"
		}
		p("- `%s` — %s\n", name, sem)
	}
	p("\nSendable gate: `activity == idle && !subtree_busy && last_assistant_completed && " +
		"!pending_question && !pending_permission`.\n\n")

	// --- verbs (generated from MCP tool defs) ---
	p("## Verbs (MCP tools — same shapes as the HTTP /vh/* and /api/workers/{id}/* surface)\n\n")
	for _, tool := range mcp.ToolDefs() {
		name, _ := tool["name"].(string)
		desc, _ := tool["description"].(string)
		p("### `%s`\n%s\n", name, desc)
		schema, _ := tool["inputSchema"].(map[string]any)
		props, _ := schema["properties"].(map[string]any)
		req := map[string]bool{}
		if rs, ok := schema["required"].([]string); ok {
			for _, r := range rs {
				req[r] = true
			}
		}
		names := make([]string, 0, len(props))
		for k := range props {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, k := range names {
			pd, _ := props[k].(map[string]any)
			d, _ := pd["description"].(string)
			marker := ""
			if req[k] {
				marker = " (required)"
			}
			p("- `%s`%s — %s\n", k, marker, d)
		}
		p("\n")
	}

	// --- contract (curated, stable) ---
	p("## Acting safely (the contract)\n\n")
	p("- **Send only when sendable** (gate above). Optional `If-Idle-Seq: <snapshot seq>` header on\n")
	p("  send is a compare-and-swap: the send is accepted only if the session is still sendable and\n")
	p("  its activity hasn't changed since that seq, else `409`. Use it to avoid double-driving.\n")
	p("- **Questions/permissions are separate gates** — a plain message does NOT satisfy them; use\n")
	p("  answer_question / reply_permission.\n")
	p("- **Status buckets** (write verbs): `409`/`410` (and upstream `404`) = request already cleared,\n")
	p("  re-read gate; `400` = malformed call, fix it (don't loop); `5xx`/transport = route-around.\n")
	p("- **abort is async** — the resulting idle arrives on the stream later; don't send-after-abort\n")
	p("  synchronously (CAS or wait for the idle transition).\n")
	p("- **Unattended/automated spawning — fail-closed permission policy**: pass\n")
	p("  `permission_policy=fail_fast` (alias `auto_reject`) on spawn so a worker that hits a\n")
	p("  permission prompt while unattended CANNOT hang — vh-solara auto-rejects the prompt\n")
	p("  server-side (NEVER `always`, so the prompt can't widen what the worker can do) and raises\n")
	p("  the `permission_blocked` gate fact for that session. The spawn outcome STAYS `created`\n")
	p("  (the mint happened, the session is counted); `permission_blocked` is a SEPARATE, post-hoc\n")
	p("  observable for the caller's accounting. Any other/unknown `permission_policy` value is\n")
	p("  REFUSED pre-mint (`outcome=refused`, `ok=false`) — a spawner passing garbage can, at worst,\n")
	p("  get a refusal or a more-restrictive session, never a wider grant. The binding is in-memory\n")
	p("  only: a worker restart loses it, so a fail_fast session that prompts after restart is NOT\n")
	p("  auto-rejected (backstop: `pending_permission` + `reply_permission` still let the caller\n")
	p("  reject explicitly). This is a vh-solara spawn param; it never reaches opencode's session\n")
	p("  create payload.\n")
	p("- **Idempotency**: pass `idempotency_key` on writes so a retry can't double-execute (10-min,\n")
	p("  per worker lifetime; resets on epoch change). A replay returns the cached result; a\n")
	p("  success-class outcome (`created`/`prompt_retried_to_existing`) is rewritten to `reused`,\n")
	p("  while `failed`/no-`outcome` bodies are replayed verbatim. The `X-VH-Idempotent-Replay: 1`\n")
	p("  header is always set on a replay.\n\n")

	p("## Result `outcome` (caller accounting)\n\n")
	p("The spawn and send result bodies carry a machine-readable `outcome` field so a caller\n")
	p("parsing the body (not headers) can classify the result for its accounting. ONLY `created`\n")
	p("means a new session was minted (counting); all others are non-counting.\n\n")
	p("- `created` — spawn minted a new session.\n")
	p("- `reused` — an idempotency replay of a prior success; the side effect already happened.\n")
	p("- `prompt_retried_to_existing` — a prompt was delivered into an existing session (send).\n")
	p("- `refused` — deterministic rejection BEFORE any side effect: today, an unknown/illegal `permission_policy` on spawn (no session minted, nothing widened). The caller's accounting treats this as non-counting and safe to surface.\n")
	p("- `failed` — accepted but errored upstream (transient/retryable).\n\n")
	p("Note: `ok:false` + `outcome:\"created\"` means a session was minted but its first turn failed\n")
	p("(outcome is the accounting/mint signal; ok is operational status). A minted session is\n")
	p("counting even if the first turn errored, so that branch is `created`, never `failed`\n")
	p("(which is reserved for the no-mint case).\n\n")
	p("On an idempotency replay, a success-class fresh outcome (`created` / `prompt_retried_to_existing`)\n")
	p("is rewritten to `reused`; a `failed` replay stays `failed`. In the MCP surface the outcome is\n")
	p("also lifted into `_meta.outcome` (alongside `epoch`/`seq`) so a structured client reads it\n")
	p("without parsing the text blob.\n\n")

	p("## Streaming & cursors\n\n")
	p("- `seq` is a single monotonic counter per worker store; cursor = `(worker, epoch, seq)`.\n")
	p("- A named `snapshot` SSE event is the baseline (first connect) OR the gap signal (ring\n")
	p("  overflow / invalid cursor) → reconcile from it, then resume.\n")
	p("- `epoch` (in the snapshot and the `X-VH-Epoch` header) identifies the store lifetime; seq\n")
	p("  resets on daemon restart — on epoch change, re-snapshot. Never compare seqs across epochs.\n\n")

	p("## Multi-project (one worker, many project dirs)\n\n")
	p("- A worker multiplexes one instance per project DIR (own store/epoch/seq). A session is\n")
	p("  owned by the dir it was created under. Pass the SAME `?dir=<dir>` (or `x-opencode-directory`\n")
	p("  header) on EVERY verb (snapshot/stream/send/spawn/abort/answer/reply/archive); omitting it\n")
	p("  targets the default project — mismatched dir silently hits the wrong (often empty) instance.\n")
	p("- `GET /vh/projects` → `[{dir, epoch, seq, roots, running}]` lists the bridged instances; pin your\n")
	p("  watch cursor to one project's (epoch, seq). Cross-machine: `/api/workers/{id}/projects`.\n\n")

	p("## Read inventory verbs (GET — programmatic, HTTP-only; NOT MCP tools)\n\n")
	p("Two shaped GETs for enumerating the session fleet and reading closeout text on demand,\n")
	p("WITHOUT touching opencode's private SQLite. `?dir=<dir>` (or `x-opencode-directory` header) is\n")
	p("required on both (same project pin as every other verb). Empty/absent is NEVER an error — an\n")
	p("unknown dir or empty fleet returns 200 with an empty payload; only a genuine transport failure\n")
	p("(opencode unreachable) is a 5xx (mirrors `/vh/archived`). NOTE: these are HTTP-only reads and\n")
	p("are deliberately NOT part of the MCP tool surface (ToolDefs).\n\n")
	p("- `GET /vh/sessions?dir=<dir>&include_archived=0|1&since=<ms>&roots_only=0|1` →\n")
	p("  `{dir, sessions:[{id, alias, title, dir, active, parentID, time:{updated,created,archived}}]}`\n")
	p("  — flat fleet inventory (active by default; archived sessions included when\n")
	p("  `include_archived=1`). `since=<ms-epoch>` drops sessions whose latest of updated/created is\n")
	p("  older. `roots_only` (default 1) limits to top-level sessions (`parentID` null); `0` includes\n")
	p("  child/sub-sessions. Ordered by `time.updated` DESC (→ created → id). `active` is true iff\n")
	p("  `time.archived` is null/0; `parentID` is null for roots, string for children. `alias` is `\"\"`\n")
	p("  (no slug/share field is exposed by the pinned opencode version). Empty/unknown dir →\n")
	p("  200 + `sessions:[]`.\n")
	p("- `GET /vh/sessions/closeout?dir=<dir>&id=a,b&id=c` →\n")
	p("  `{dir, closeouts:{<sid>:{present, text}}}` — the FULL text of each requested session's LAST\n")
	p("  assistant message (text parts concatenated; NEVER truncated — HR1). `id` accepts repeatable\n")
	p("  values AND comma-lists (forms may be mixed); ids are deduped and EVERY requested id appears\n")
	p("  as a key. `present:true`+`text:\"<...>\"` = readable assistant message with text;\n")
	p("  `present:true`+`text:\"\"` = assistant message exists but has no text parts;\n")
	p("  `present:false`+`text:null` = no readable assistant message / unreadable / unknown id. A\n")
	p("  per-id failure never fails the batch (maps to `present:false`); unknown dir → all\n")
	p("  `present:false`. If a future hard server-side length limit is ever introduced it must surface\n")
	p("  as an explicit `truncated:true` flag + documented max, never a silent cut.\n\n")

	p("## Server-managed state docs (labels, pins, queue — HTTP-only writes/reads; NOT MCP tools)\n\n")
	p("Three durable, server-authoritative surfaces for coordination state that lives OUTSIDE the\n")
	p("session transcript. All are HTTP-only (deliberately NOT MCP tools). State-changing calls require\n")
	p("`X-VH-CSRF: 1` (the outer middleware on every /vh/* route). NONE has a cross-machine mirror on\n")
	p("the controller today — they are worker-local; reach them on the worker's own /vh/* edge (or its\n")
	p("UDS). The controller's `/api/workers/{id}/*` mirrors the verbs/projects/views/sessions/events\n")
	p("surface, not these docs.\n\n")

	p("### Labels (root-session groups + tags) — per-project\n\n")
	p("Browser-tab-group-style grouping of ROOT sessions, scoped to ONE project (`?dir=<dir>` or\n")
	p("`x-opencode-directory`). A project-A mutation never reaches project-B's stream. An\n")
	p("unresolvable/empty project yields an empty doc on GET, NEVER an error.\n\n")
	p("- `GET /vh/labels?dir=<dir>` → `{revision, groups, tags, tagIdsByRootSessionId}`. Empty doc\n")
	p("  (`{revision:0, groups:[], tags:[], tagIdsByRootSessionId:{}}`) if the project is unresolvable.\n")
	p("- `PUT /vh/labels?dir=<dir>` (CSRF) replaces the WHOLE doc. Body:\n")
	p("  `{baseRevision, groups, tags, tagIdsByRootSessionId}` — revision is SERVER-OWNED and absent\n")
	p("  from the request; `baseRevision` (the CAS guard from your last GET/response) is REQUIRED.\n")
	p("  Status: 200 → committed authority `LabelsDoc` (revision = base+1); 409 → authority `LabelsDoc`\n")
	p("  (CAS mismatch — adopt and retry); 400 structured `{error, message, ids?, + embedded LabelsDoc}`\n")
	p("  (adopt the embedded doc = self-heal in one round-trip) on a store-invariant violation — e.g.\n")
	p("  `unknown_root` (a referenced root is not an active root of THIS project),\n")
	p("  `exclusive_group_violation`, `dangling_tag_ref`, `too_many_groups`/`too_many_tags`,\n")
	p("  `bad_*_color`, `duplicate_*_name` — and plain-text 400 for malformed JSON / missing\n")
	p("  `baseRevision`; 500 → persist failure (the doc did not advance; retry with the same\n")
	p("  `baseRevision`).\n")
	p("- SSE: `labels.snapshot` (bootstrap, emitted on EVERY fresh /vh/stream connect from THIS\n")
	p("  stream's project store) + `labels.updated` (transient fan-out after a committed PUT 200 /\n")
	p("  lifecycle cleanup; NOT replayed from the ring — reconnect catches up via the snapshot).\n")
	p("  Per-project: a project-A update reaches only project-A subscribers.\n")
	p("- Model: groups are ORDERED and EXCLUSIVE (a root is in AT MOST one group); tags are\n")
	p("  NON-exclusive and a SEPARATE namespace (a group and a tag may share a name). Caps: ≤50 groups,\n")
	p("  ≤100 tags, name ≤64 chars after trim. Colors are membership tokens\n")
	p("  (red/orange/amber/green/teal/blue/purple/gray), never raw CSS. Referenced roots must be ACTIVE\n")
	p("  ROOTS (`parentID==\"\"`) of this project — fail-closed on unknown/cross-project roots; roots\n")
	p("  already retained in the server doc skip re-validation (archival-race safety). Group/tag\n")
	p("  DEFINITIONS survive cleanup even when their assignments are gone (a future restore is\n")
	p("  possible).\n\n")

	p("### Pins (pinned root-session order) — worker-wide\n\n")
	p("A flat, ordered list of pinned session ids, WORKER-WIDE (one pins.json; NO `?dir=` — a pin\n")
	p("mutation fans out to EVERY project's stream, unlike per-project labels). The public shape\n")
	p("OMITS the internal project-by-session map.\n\n")
	p("- `GET /vh/pins` → `{revision, initialized, orderedSessionIds}`.\n")
	p("- `PUT /vh/pins` (CSRF) replaces the whole ordered list. Body:\n")
	p("  `{baseRevision, orderedSessionIds, initializeOnly?}` — `baseRevision` CAS guard is REQUIRED.\n")
	p("  Status: 200 → committed authority `{revision, initialized, orderedSessionIds}`; 409 →\n")
	p("  authority body (CAS or init-guard mismatch); 400 structured\n")
	p("  `{error:\"unknown_session\", message, unknownIds:[...]}` — newly-ADDED ids not active on this\n")
	p("  worker (anti-resurrection; RETAINED ids skip, so only your NEW ids are vetted) — parse\n")
	p("  `unknownIds`, drop them, retry once (bounded); plain-text 400 for malformed JSON / missing\n")
	p("  `baseRevision` / empty-or-dupe-or-oversized ids / over the ≤50 cap; 500 → persist failure.\n")
	p("- `initializeOnly:true` selects the init-guard form (succeeds only on an uninitialized doc).\n")
	p("- SSE: `pins.snapshot` (bootstrap, on EVERY fresh connect, worker-wide) + `pins.updated`\n")
	p("  (transient, fanned to ALL projects' live subscribers; NOT replayed).\n")
	p("- Caps: ≤50 pinned sessions; id length ≤256.\n\n")

	p("### Queue (per-session work distribution) — per-project, backend-authoritative\n\n")
	p("A per-(project,session) FIFO queue of pending prompts. The backend owns id, monotonic order,\n")
	p("state, and durability; clients are thin dispatchers. `claim` is the atomic cross-CLIENT boundary\n")
	p("(exactly one caller wins the oldest pending item). No auto-retry anywhere — a failed dispatch\n")
	p("stays failed until explicit operator dismissal.\n\n")
	p("- `GET /vh/session/{sessionId}/queue?dir=<dir>` → `{items:[QueueItem]}` (FIFO). List also runs\n")
	p("  stale-dispatch recovery (abandoned `dispatching` → `unknown`) and terminal compaction.\n")
	p("- `POST /vh/session/{sessionId}/queue?dir=<dir>` `{text, attachments?, sendConfig?,\n")
	p("  originClientId?}` → `{item:QueueItem}` (state=`pending`; backend issues id+order).\n")
	p("  `originClientId` is diagnostics-only and never affects ordering/dispatch.\n")
	p("- `POST /vh/session/{sessionId}/queue/claim?dir=<dir>` → `{item:QueueItem}` (won) or\n")
	p("  `{item:null}` (no pending item). Atomically moves the OLDEST `pending` → `dispatching`.\n")
	p("- `POST /vh/session/{sessionId}/queue/{itemId}/resolve?dir=<dir>` `{state, detail?}` →\n")
	p("  `{item:QueueItem}`. `state` must be a TERMINAL `sent`|`failed`|`unknown` (never `pending` —\n")
	p("  cannot repend); a `pending` item must be claimed first (409).\n")
	p("- `DELETE /vh/session/{sessionId}/queue/{itemId}?dir=<dir>` → `{ok:true}`. Dismisses `pending`\n")
	p("  or terminal items; rejects a `dispatching` item (409 — the dispatch may be in flight).\n")
	p("- Status mapping: 404 not found; 409 (`dispatching`-not-removable / resolve-on-`pending`); 400\n")
	p("  (non-terminal resolve `state`); 410 (session queue archived); 500 (malformed queue.json /\n")
	p("  persist).\n")
	p("- Lifecycle: `pending → dispatching → {sent | failed | unknown}`. Stale dispatch (>30s in\n")
	p("  `dispatching`) is recovered to terminal `unknown` (NEVER re-dispatched — resend may duplicate\n")
	p("  work, so it is fail-closed). Compaction TTLs/caps: sent 1h/50, failed 7d/100, unknown 30d/200\n")
	p("  (measured from `resolvedAt`). Project via `?dir=`/`x-opencode-directory` (reqDir→projectRoot);\n")
	p("  the session id is sanitized before any filesystem use.\n\n")

	p("## Transport\n\n")
	p("- Local (agent on the worker machine): hit the worker's `/vh/*` directly, or run\n")
	p("  `vh-solara mcp --local`. Over a Unix socket (container / no host networking): start the\n")
	p("  worker with `--vh-sock /path/vh.sock` and reach it via `mcp --sock /path/vh.sock`, or any\n")
	p("  UDS HTTP client (e.g. httpx with a UDS transport). Set `X-VH-CSRF: 1` on writes.\n")
	p("- Cross-machine: the controller's `/api/workers/{id}/*` (bearer token), proxied to the\n")
	p("  worker — same verbs, path-addressed; responses carry `X-VH-Epoch`/`X-VH-Seq`.\n\n")

	p("## Embedded views (generic reverse-proxy → sandboxed iframe)\n\n")
	p("Surface your OWN read-only web app inside the vh-solara UI (peer to chat), reachable\n")
	p("remotely + on mobile — no local files / ssh tunnels. vh-solara reverse-proxies your\n")
	p("upstream under a PATH PREFIX (inherits its host, auth, TLS) and shows it as a sandboxed\n")
	p("iframe. vh-solara stays domain-agnostic; you own the upstream and all semantics.\n\n")
	p("- **Register**: `POST /vh/views` `{view_id, title, path_prefix, upstream, sandbox?}`\n")
	p("  (set `X-VH-CSRF: 1`). `GET /vh/views` lists; `DELETE /vh/views?view_id=ID` removes.\n")
	p("  Cross-machine discovery mirror: `GET /api/workers/{id}/views`.\n")
	p("- **upstream**: `unix:/path/to.sock` (recommended — matches the /vh UDS pattern),\n")
	p("  `http://127.0.0.1:PORT`, or `tcp:host:port`.\n")
	p("- **path_prefix**: a non-reserved absolute path (not `/`, `/vh`, `/oc`, `/auth`, `/assets`).\n")
	p("- **Prefix-correctness (your side)**: serve asset/link URLs RELATIVE (no leading slash).\n")
	p("  vh-solara strips the prefix before forwarding, injects `<base href=\"<prefix>/\">` into\n")
	p("  HTML, and rewrites redirect `Location` under the prefix. Root-absolute URLs (`/x`) bypass\n")
	p("  the prefix — avoid them (or set your own `<base>`).\n")
	p("- **Auth/transport**: the proxied path is gated by the same session as the rest of the UI;\n")
	p("  the vh-solara session cookie is NOT forwarded to your upstream. Make your content\n")
	p("  responsive — primary access is remote + mobile. Read-only by intent: mutation stays in chat.\n")
	p("- **Theme tokens (render native)**: vh-solara publishes a stable semantic palette as `--vh-*`\n")
	p("  custom properties (`--vh-bg`, `--vh-surface`, `--vh-fg`, `--vh-muted`, `--vh-accent`,\n")
	p("  `--vh-accent-2`, `--vh-border`, `--vh-ok`, `--vh-warn`, `--vh-error`, + `mode` light/dark).\n")
	p("  Theme is PER-CLIENT (each browser keeps its own): `/vh/theme.json` / `/vh/theme.css` is a\n")
	p("  client-agnostic DEFAULT baseline (use as fallback only). The authoritative per-client source is\n")
	p("  the `window` `message` `{source:\"vh-solara\", type:\"theme\", mode, tokens}` (pushed to your iframe\n")
	p("  on load + on every theme/mode change) — apply it to YOUR OWN document, don't assume one global\n")
	p("  theme. Map the tokens to your styles (keep your palette as fallback). You can also\n")
	p("  `postMessage({source:\"vh-solara\", type:\"theme-request\"})` to your parent to pull on your timing.\n")

	return b.String()
}
