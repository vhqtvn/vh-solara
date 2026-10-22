# notify_v4 — frozen v4 golden wire shapes (S0 contract freeze, 2026-10-21)

These are the **frozen golden shapes** of the v4 `/vh/notify/*` contract
(`docs/architecture/notify-fcm.md` — v4, 2026-10-21). The implementation
slices S3–S5 MUST produce output **byte-shape-identical** to these fixtures
(field names and types; JSON key order is insensitive).

Machine-checked from day one by the S0 schema-shape validator
`pkg/server/notify_v4_fixture_test.go` (field presence + TYPES — especially
`ts` as a **decimal string** of epoch millis on public history shapes; a
JSON number there fails the test).

| Fixture | Surface |
|---|---|
| `history_response_v4.json` | `GET /vh/notify/history` — complete coverage; includes waiting+question, session_started, finished, and a daemon-level worker_down event; all v4 additive fields present |
| `history_response_gaps.json` | `GET /vh/notify/history` — `coverage.gaps` with source/epoch/seq-range (source gaps, never fabricated central-id holes); the third entry is the `{from_seq:1, to_seq:0}` **empty-range sentinel** (S5-sanctioned additive): the worker standalone surface (`pkg/web/notify_feature.go`) emits it for an epoch whose unknown-extent prefix is entirely gone (spool rotation with discontinuity). It is the ONE legal `from_seq > to_seq` shape — the validator accepts exactly `{1,0}`, nothing else |
| `registration_request_v4.json` | `POST /vh/notify/tokens` request body (v3 shape, served centrally) |
| `probe_response_v4.json` | `GET /vh/notify/tokens` probe response (v3 field shape, central-`enabled` semantics) |
| `fcm_message_v4.json` | FCM HTTP v1 data-only message (existing five `vh_*` keys + five additive v4 keys; waiting/HIGH) |

All tokens, hosts, sessions, and ids are **synthetic examples** — no real
secrets. Timestamps are illustrative epoch-millis strings.
