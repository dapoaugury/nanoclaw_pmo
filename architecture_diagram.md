# Lucid PMO (NanoClaw) Architecture Diagram

```mermaid
graph TD
    subgraph "External Data Sources"
        M365["Microsoft 365<br/>Email (Graph API)"]
        JIRA["JIRA<br/>REST API"]
        FILES["Local Files<br/>(CSV, JSON, Code)"]
    end

    subgraph "Ingestion Layer"
        EMAIL_INLET["Email Inlet<br/>(OAuth, Keyword Filter,<br/>Action Inference)"]
        JIRA_INLET["JIRA Inlet<br/>(Basic Auth, JQL,<br/>Label Filter)"]
        FILE_WATCH["File Watcher<br/>(Chokidar)"]
    end

    subgraph "Engine Core (TypeScript/Node.js)"
        ORCHESTRATOR["Orchestrator<br/>(Main Entry Point)"]
        
        subgraph "Risk Scorers"
            ACTION_SCORER["Action Risk Scorer<br/>(Delete, Deploy, Transfer)"]
            PARAM_SCORER["Parameter Risk Scorer<br/>(Secrets, Paths, Commands)"]
            FINANCIAL_SCORER["Financial Risk Scorer<br/>(Budget > $100K)"]
            GRAPH_SCORER["Graph Conflict Scorer<br/>(Dependency Analysis)"]
        end
        
        DEDUP["Deduplication Ledger<br/>(SHA-256 Hashing)"]
        PERSISTER["SQLite Persister<br/>(Evaluation History)"]
    end

    subgraph "Human-in-the-Loop Gateway"
        OUTBOX["Outbox Directory<br/>(JSON Token Handoff)"]
        FS_WATCH["FileSystem Watcher"]
        RUST_GATEWAY["Host Gateway<br/>(Rust Binary)<br/>Blocks & Prompts Operator"]
        OPERATOR["Human Operator<br/>(Approve/Reject)"]
    end

    subgraph "Compliance & Analysis"
        COMPLIANCE["Compliance Checker<br/>(Python)<br/>FinTech Standards:<br/>- No floats for money<br/>- Audit logging<br/>- JIRA references"]
    end

    subgraph "Downstream Systems"
        EXECUTION["Approved Actions<br/>(Deploy, Transfer,<br/>Budget Change)"]
        ALERTS["Alerts & Reports"]
    end

    %% Data Flow
    M365 --> EMAIL_INLET
    JIRA --> JIRA_INLET
    FILES --> FILE_WATCH
    
    EMAIL_INLET --> ORCHESTRATOR
    JIRA_INLET --> ORCHESTRATOR
    FILE_WATCH --> ORCHESTRATOR
    
    ORCHESTRATOR --> ACTION_SCORER
    ORCHESTRATOR --> PARAM_SCORER
    ORCHESTRATOR --> FINANCIAL_SCORER
    ORCHESTRATOR --> GRAPH_SCORER
    
    ACTION_SCORER --> DEDUP
    PARAM_SCORER --> DEDUP
    FINANCIAL_SCORER --> DEDUP
    GRAPH_SCORER --> DEDUP
    
    DEDUP --> PERSISTER
    DEDUP --> OUTBOX
    
    OUTBOX --> FS_WATCH
    FS_WATCH --> RUST_GATEWAY
    
    RUST_GATEWAY -->|High Risk | OPERATOR
    OPERATOR -->|Approve | RUST_GATEWAY
    OPERATOR -->|Reject | RUST_GATEWAY
    
    RUST_GATEWAY -->|Approved | EXECUTION
    
    FILES --> COMPLIANCE
    COMPLIANCE --> ALERTS
    
    PERSISTER --> ALERTS

    %% Styling
    style M365 fill:#e1f5fe
    style JIRA fill:#e1f5fe
    style FILES fill:#e1f5fe
    style EMAIL_INLET fill:#fff3e0
    style JIRA_INLET fill:#fff3e0
    style FILE_WATCH fill:#fff3e0
    style ORCHESTRATOR fill:#e8f5e9
    style ACTION_SCORER fill:#fce4ec
    style PARAM_SCORER fill:#fce4ec
    style FINANCIAL_SCORER fill:#fce4ec
    style GRAPH_SCORER fill:#fce4ec
    style DEDUP fill:#f3e5f5
    style PERSISTER fill:#f3e5f5
    style OUTBOX fill:#ffebee
    style FS_WATCH fill:#ffebee
    style RUST_GATEWAY fill:#ffccbc
    style OPERATOR fill:#c8e6c9
    style COMPLIANCE fill:#fff8e1
    style EXECUTION fill:#c8e6c9
    style ALERTS fill:#fff9c4
```

## Architecture Layers Explained

### 1. **External Data Sources** (Top Layer)
- **M365 Email**: OAuth-authenticated Microsoft Graph API integration
- **JIRA**: Basic Auth REST API with JQL query support
- **Local Files**: CSV, JSON, and source code files

### 2. **Ingestion Layer** (Second Layer)
- **Email Inlet**: Filters by keywords, infers actions from email content
- **JIRA Inlet**: Executes JQL queries, filters by labels, supports CSV export
- **File Watcher**: Uses Chokidar for real-time file system monitoring

### 3. **Engine Core** (Third Layer - TypeScript/Node.js)
- **Orchestrator**: Main entry point coordinating all components
- **4 Risk Scorers**:
  - Action Risk: Detects dangerous operations (delete, deploy, transfer)
  - Parameter Risk: Identifies secrets, sensitive paths, commands
  - Financial Risk: Flags budget changes over $100K
  - Graph Conflict: Analyzes dependency conflicts
- **Deduplication Ledger**: SHA-256 hashing to prevent duplicate processing
- **SQLite Persister**: Stores evaluation history for audit trails

### 4. **Human-in-the-Loop Gateway** (Fourth Layer)
- **Outbox Directory**: JSON token handoff between engine and gateway
- **FileSystem Watcher**: Monitors outbox for new items
- **Rust Gateway**: High-performance binary that blocks high-risk actions
- **Human Operator**: Required approval for any high-risk action

### 5. **Compliance & Analysis** (Side Layer)
- **Python Compliance Checker**: Static analysis for FinTech standards
  - Enforces no floating-point for monetary values
  - Requires audit logging
  - Validates JIRA ticket references

### 6. **Downstream Systems** (Bottom Layer)
- **Approved Actions**: Only executed after human approval
- **Alerts & Reports**: Generated from evaluation history

## Key Design Principles

1. **No Autonomous High-Risk Execution**: All dangerous actions require human approval
2. **Polyglot Architecture**: Best tool for each job (TS for logic, Rust for performance, Python for analysis)
3. **Filesystem-Based Communication**: JSON tokens in outbox directory for inter-process communication
4. **Audit Trail**: SQLite persistence ensures all evaluations are recorded
5. **Deduplication**: Prevents processing the same item multiple times
6. **Real-Time Monitoring**: File watchers enable immediate response to new data
