# Lucid PMO (NanoClaw)

A **Human-in-the-Loop (HITL) Risk Evaluation Engine** for FinTech operations. NanoClaw provides intelligent risk scoring, deduplication, and operator approval gates for high-stakes actions like budget changes, deployments, and data transfers.

## Architecture Overview

```
External Sources → Ingestion Layer → Engine Core → HITL Gateway → Execution
     ↓                                      ↓
  M365, JIRA, Files                    Compliance Checker
```

See [architecture_diagram.md](./architecture_diagram.md) for a detailed Mermaid diagram.

## Key Features

- **Multi-Layer Risk Scoring**: Action, Parameter, Financial, and Graph Conflict analysis
- **Human-in-the-Loop Enforcement**: No high-risk action executes without operator approval
- **Deduplication**: SHA-256 hashing prevents duplicate processing
- **Audit Trail**: SQLite persistence for all evaluations
- **Polyglot Architecture**: TypeScript (logic), Rust (gateway), Python (compliance)
- **Real-Time Monitoring**: File watchers enable immediate response to new data
- **Email & JIRA Integration**: OAuth M365 and Basic Auth JIRA ingestion

## Project Structure

```
/workspace
├── architecture_diagram.md    # Detailed system architecture
├── compliance_checker.py      # Python FinTech compliance checker
├── engine_core/               # TypeScript/Node.js evaluation engine
│   ├── index.ts              # Main orchestrator
│   ├── email_inlet.ts        # M365 email ingestion
│   ├── jira_inlet.ts         # JIRA ticket ingestion
│   └── package.json
├── host_gateway/              # Rust HITL gateway binary
│   ├── Cargo.toml
│   └── src/
├── skills/SKILL.md            # Operational blueprint
└── data/
    ├── ingest/                # Input files (CSV, JSON)
    ├── outbox/                # Token handoff directory
    └── state/                 # Sync state (dedup ledgers)
```

## Quick Start

### Prerequisites

- **Node.js** (v20+) for Engine Core
- **Rust** (cargo) for Host Gateway
- **Python 3** for Compliance Checker

### Engine Core (TypeScript)

```bash
cd engine_core

# Install dependencies
npm install

# Build
npm run build

# Run main orchestrator
npm start

# Run tests
npm test
```

#### Email Ingestion (M365)

```bash
# One-shot email sync
npm run email

# Continuous polling (every 5 minutes)
npm run email:watch
```

Configure in `engine_core/email_config.json`:
```json
{
  "tenant_id": "your-tenant-id",
  "client_id": "your-client-id",
  "client_secret": "your-client-secret",
  "subject_keywords": ["budget", "approval", "variance"],
  "polling": {
    "interval_minutes": 5,
    "max_messages": 50,
    "age_limit_hours": 24
  }
}
```

#### JIRA Ingestion

```bash
# One-shot JIRA sync
npm run jira

# Export to CSV
npm run jira:csv

# Continuous polling (every 10 minutes)
npm run jira:watch
```

Configure in `engine_core/jira_config.json`:
```json
{
  "base_url": "https://your-domain.atlassian.net",
  "email": "your-email@company.com",
  "api_token": "your-api-token",
  "queries": [
    {
      "key": "recent_updates",
      "jql": "updated >= -1d ORDER BY updated DESC"
    }
  ],
  "labels_include": ["budget", "blocker", "milestone", "PMO"]
}
```

### Host Gateway (Rust)

```bash
cd host_gateway

# Build
cargo build --release

# Run (monitors outbox directory)
cargo run --release
```

The gateway blocks on high-risk actions and prompts the operator for approval via stdin.

### Compliance Checker (Python)

```bash
# Check a source file for FinTech compliance
python compliance_checker.py path/to/file.py
```

**Compliance Rules:**
1. ❌ No `float`/`double` for financial variables (use `Decimal` or cents)
2. ⚠️ State-changing functions must include `AUDIT` log entries
3. ⚠️ Code must reference JIRA tickets (e.g., `# JIRA: PROJ-123`)

## Risk Scoring System

Each payload is evaluated through four independent scorers:

| Scorer | Triggers | Severity |
|--------|----------|----------|
| **Action Risk** | `DELETE`, `DEPLOY_PRODUCTION`, `EXECUTE_BUDGET_RECONCILIATION` | Critical |
| **Parameter Risk** | `password`, `secret`, `token`, `private_key` | High |
| **Financial Risk** | Budget deltas ≥ $100,000 | High |
| **Graph Conflict** | Prior HITL flags on same task_id | Medium |

**Aggregate Risk Formula:**
```
aggregate = max(critical × 1.0, high × 0.7, medium × 0.4, low × 0.1)
```

**Intervention Gate fires when:**
- Aggregate risk ≥ 0.5, OR
- Any finding is `critical`, OR
- Action is on mandatory-approval list

Low-risk payloads (e.g., status updates) are auto-approved.

## Data Flow

1. **Ingestion**: Email, JIRA, or file events trigger evaluation cycles
2. **Scoring**: Four risk scorers analyze the payload
3. **Deduplication**: SHA-256 hash checks against ledger
4. **Persistence**: Evaluation stored in SQLite (`mnemon_graph` table)
5. **Outbox**: High-risk items written as JSON tokens to `data/outbox/`
6. **Gateway**: Rust binary detects token, blocks, prompts operator
7. **Execution**: Approved actions proceed; rejected actions are logged

## Configuration Files

| File | Purpose |
|------|---------|
| `engine_core/email_config.json` | M365 OAuth credentials, keywords, polling |
| `engine_core/jira_config.json` | JIRA auth, JQL queries, label filters |
| `engine_core/package.json` | Node.js dependencies, scripts |
| `host_gateway/Cargo.toml` | Rust dependencies |
| `data/state/email_sync.json` | Processed email IDs (dedup) |
| `data/state/jira_sync.json` | Processed JIRA keys (dedup) |

## Testing

```bash
# Engine Core tests
cd engine_core
npm test

# Compliance checker
python compliance_checker.test.py
```

## Design Principles

1. **No Autonomous High-Risk Execution**: All dangerous actions require human approval
2. **Polyglot Architecture**: Best tool for each job
3. **Filesystem-Based Communication**: JSON tokens in outbox for IPC
4. **Audit Trail**: SQLite persistence ensures all evaluations are recorded
5. **Deduplication**: Prevents processing the same item multiple times
6. **Real-Time Monitoring**: File watchers enable immediate response
7. **Graceful Degradation**: Missing credentials don't crash the pipeline

## License

Proprietary — Lucid PMO

## Support

For questions or issues, refer to the [SKILL.md](./skills/SKILL.md) operational blueprint or contact the engineering team.
