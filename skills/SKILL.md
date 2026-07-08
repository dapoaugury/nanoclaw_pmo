# Lucid PMO — Native Heuristic Blueprint

## Operational Boundaries
1. **Directory-Level Compliance**: You operate natively within your local directory paths. Do not attempt to index files outside your parent runtime project node tree.
2. **FileSystem Serialization Engine**: All actionable downstream tasks must be written to the designated local workspace folder (`../data/outbox`) as a validated structured JSON token block.

## HITL Enforcement Gate (Phase 5)
3. **No action executes without operator approval**. Every token written to `outbox/` triggers a blocking stdin prompt in the Rust Gateway (`host_gateway`). The operator must type `y`/`yes` to authorize dispatch. Any other input rejects the token.
4. **Idempotent processing**: Each token file is processed exactly once. The gateway maintains an in-memory dedup ledger to prevent re-evaluation of the same file across filesystem event cycles.
5. **Path resolution**: The gateway resolves `../data/outbox` relative to `CARGO_MANIFEST_DIR`, not the current working directory. Running `cargo run` from any directory is safe.

## Evaluation Pipeline (Engine Core)
6. **Risk scoring is multi-layered**. Each ingest payload is evaluated through four independent scorers:
   - **Action Risk** — checks against `ALWAYS_INTERVENE_ACTIONS` list (e.g. `EXECUTE_BUDGET_RECONCILIATION`, `DELETE`, `DEPLOY_PRODUCTION`) → severity: `critical`
   - **Parameter Risk** — scans parameter keys/values for sensitive keywords (`password`, `secret`, `token`, `private_key`, etc.) → severity: `high`
   - **Financial Risk** — flags numeric financial deltas ≥ $100,000 in parameters with financial key names (`allocation_delta`, `budget`, `cost`, etc.) → severity: `high`
   - **Graph Conflict** — checks the `mnemon_graph` SQLite store for prior HITL flags on the same `task_id` → severity: `medium`
7. **Aggregate risk** uses a weighted max model: `critical × 1.0`, `high × 0.7`, `medium × 0.4`, `low × 0.1`. A single critical finding dominates the score.
8. **Intervention gate fires** when aggregate risk ≥ 0.5, any finding is `critical`, or the action is on the mandatory-approval list. Low-risk payloads (e.g. status updates) are auto-approved and do not produce outbox tokens.
9. **All evaluations are persisted** to the `mnemon_graph` table as `(Task:{id}, RiskEvaluated:{score} → {status}, {findings})` triples, enabling regression detection across cycles.

## Email Inlet (M365 Integration)
10. **Microsoft 365 email ingestion** runs as Phase 0 of every engine cycle — before local ingest evaluation. It authenticates via MSAL client credentials flow (OAuth 2.0) against the Microsoft Graph API.
11. **Configuration**: Credentials and filter rules live in `engine_core/email_config.json`. Required fields: `tenant_id`, `client_id`, `client_secret`. The file also defines `subject_keywords` for relevance matching, `sender_allowlist`/`sender_blocklist` for sender filtering, and `polling` parameters (interval, max messages, age limit).
12. **Deduplication**: Processed message IDs are tracked in `data/state/email_sync.json` (bounded to last 1000 IDs). Each cycle only fetches messages received after `lastSyncTime` or `age_limit_hours`, whichever is more recent.
13. **Action inference**: Email subject/body keywords are mapped to Lucid PMO actions (e.g. "budget approval" → `EXECUTE_BUDGET_RECONCILIATION`, "variance" → `FLAG_VARIANCE`). These flow through the same risk evaluation pipeline as Teams/manual payloads.
14. **Standalone mode**: Run `npm run email` to execute an email-only cycle (no local ingest evaluation). Run `npm run email:watch` for continuous polling every 5 minutes.
15. **Graceful degradation**: If M365 credentials are missing or authentication fails, the email inlet logs a warning and the engine cycle continues with local ingest files only — no hard failure.

## JIRA Inlet (Atlassian Integration)
16. **JIRA Cloud ingestion** runs as Phase 0b alongside email — before local ingest evaluation. It authenticates via Basic Auth (email + API token) against the JIRA REST API v3.
17. **Configuration**: Credentials, JQL queries, and filter rules live in `engine_core/jira_config.json`. Required fields: `base_url`, `email`, `api_token`. The `queries` array defines named JQL searches (recent updates, high-priority backlog, blockers/risks).
18. **Relevance filtering**: Issues are filtered by `labels_include` (e.g. budget, blocker, milestone, PMO), `labels_exclude`, `issue_types_include`, and optional `project_keys`. An issue is relevant if it has a matching included label OR is an included type.
19. **Action inference**: Issue labels, summary, status, and type are mapped to Lucid PMO actions (e.g. blocker label → `FLAG_BLOCKER`, "budget" in summary → `EXECUTE_BUDGET_RECONCILIATION`, Bug/Incident type → `FLAG_VARIANCE`, Epic+Done → `LOG_MILESTONE_UPDATE`).
20. **Deduplication**: Processed issue keys (e.g. `PROJ-123`) are tracked in `data/state/jira_sync.json` (bounded to last 2000 keys). Each query only fetches once per cycle; already-seen keys are skipped.
21. **Standalone mode**: Run `npm run jira` for a one-shot JIRA sync. Run `npm run jira:watch` for continuous polling every 10 minutes. Each query's results are written to `data/ingest/jira_{key}_{timestamp}.json` and flow through the standard evaluation pipeline.
22. **Graceful degradation**: If JIRA credentials are missing or a query fails, the inlet logs the error and the engine continues. Individual query failures don't block other queries or the rest of the pipeline.
