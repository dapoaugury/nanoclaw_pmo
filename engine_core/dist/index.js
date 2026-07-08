"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const email_inlet_1 = require("./email_inlet");
const jira_inlet_1 = require("./jira_inlet");
const WORKSPACE_DATA_DIR = path.resolve(__dirname, '../../data');
const INGEST_PATH = path.join(WORKSPACE_DATA_DIR, 'ingest');
const OUTBOX_PATH = path.join(WORKSPACE_DATA_DIR, 'outbox');
const DATABASE_PATH = path.join(WORKSPACE_DATA_DIR, 'state', 'mnemon.db');
const SKILL_PATH = path.resolve(__dirname, '../skills/SKILL.md');
// ── Policy rule definitions ────────────────────────────────────────
/** Actions that always require human approval regardless of risk score. */
const ALWAYS_INTERVENE_ACTIONS = new Set([
    'EXECUTE_BUDGET_RECONCILIATION',
    'DELETE',
    'DROP',
    'TRUNCATE',
    'GRANT_ADMIN',
    'ROTATE_KEYS',
    'DEPLOY_PRODUCTION',
]);
/** Keywords that elevate risk when found in payload parameters. */
const HIGH_RISK_KEYWORDS = [
    'password', 'secret', 'token', 'private_key', 'credential',
    'delete', 'drop', 'truncate', 'overwrite', 'bypass',
];
/** Numeric thresholds for financial operations. */
const FINANCIAL_RISK_THRESHOLD = 100_000; // USD
// ── Core engine ────────────────────────────────────────────────────
class NanoClawNativeCore {
    db;
    constructor() {
        console.log('Initializing Native NanoClaw Core Engine...');
        if (!fs.existsSync(INGEST_PATH))
            fs.mkdirSync(INGEST_PATH, { recursive: true });
        if (!fs.existsSync(OUTBOX_PATH))
            fs.mkdirSync(OUTBOX_PATH, { recursive: true });
        if (!fs.existsSync(path.dirname(DATABASE_PATH)))
            fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
        this.db = new better_sqlite3_1.default(DATABASE_PATH);
        this.db.pragma('journal_mode = WAL');
        this.initializeMnemonSchema();
    }
    initializeMnemonSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS mnemon_graph (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity TEXT NOT NULL,
                relationship TEXT NOT NULL,
                target TEXT NOT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
    }
    async runCycle() {
        try {
            console.log('Firing Native Agent Analytical Step...');
            // Phase 0: Pull external data into ingest directory
            try {
                const emailResult = await (0, email_inlet_1.runEmailIngestion)();
                if (emailResult.ingested > 0) {
                    console.log(`   📧 Email inlet delivered ${emailResult.ingested} item(s) for evaluation`);
                }
            }
            catch (emailErr) {
                console.log(`   ⚠️ Email inlet skipped: ${emailErr.message}`);
            }
            try {
                const jiraResult = await (0, jira_inlet_1.runJiraIngestion)();
                if (jiraResult.ingested > 0) {
                    console.log(`   📋 JIRA inlet delivered ${jiraResult.ingested} item(s) for evaluation`);
                }
            }
            catch (jiraErr) {
                console.log(`   ⚠️ JIRA inlet skipped: ${jiraErr.message}`);
            }
            const fileDumps = fs.readdirSync(INGEST_PATH);
            const rawContexts = [];
            for (const file of fileDumps) {
                const fullPath = path.join(INGEST_PATH, file);
                if (fs.statSync(fullPath).isFile()) {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    let payload = null;
                    try {
                        payload = JSON.parse(content);
                    }
                    catch { /* non-JSON ingest is ok */ }
                    rawContexts.push({ filename: file, content, payload });
                }
            }
            const skillsContext = fs.existsSync(SKILL_PATH)
                ? fs.readFileSync(SKILL_PATH, 'utf8')
                : '# Simplified Local Agent Instructions Matrix.';
            const localGraphState = this.queryAllFacts();
            for (const ctx of rawContexts) {
                const evaluationOutput = this.evaluateLocalHeuristics(ctx, skillsContext, localGraphState);
                this.persistFindingsToGraph(ctx, evaluationOutput);
                if (evaluationOutput.requiresInterventionGate) {
                    const tokenFilename = `token_${Date.now()}_mod.json`;
                    const serializedToken = JSON.stringify(evaluationOutput.actionPayload, null, 2);
                    fs.writeFileSync(path.join(OUTBOX_PATH, tokenFilename), serializedToken, 'utf8');
                    console.log(`Action footprint committed to native outbox directory: ${tokenFilename}`);
                }
                else {
                    console.log(`Low-risk execution — no intervention required for: ${ctx.filename}`);
                }
                // Purge processed ingest file
                try {
                    fs.unlinkSync(path.join(INGEST_PATH, ctx.filename));
                }
                catch { /* ok */ }
            }
        }
        catch (error) {
            console.error('Native Runtime Exception Encountered:', error);
        }
    }
    queryAllFacts() {
        const stmt = this.db.prepare('SELECT * FROM mnemon_graph ORDER BY timestamp DESC');
        return stmt.all();
    }
    recordNewEntityLink(entity, relationship, target) {
        const stmt = this.db.prepare('INSERT INTO mnemon_graph (entity, relationship, target) VALUES (?, ?, ?)');
        stmt.run(entity, relationship, target);
    }
    persistFindingsToGraph(ctx, result) {
        const taskId = ctx.payload?.task_id ?? ctx.filename;
        const statusLabel = result.requiresInterventionGate ? 'RequiresHITL' : 'AutoApproved';
        this.recordNewEntityLink(`Task:${taskId}`, `RiskEvaluated:${result.riskScore.toFixed(2)} → ${statusLabel}`, result.findings.map(f => `${f.category}(${f.severity})`).join(', ') || 'clean');
    }
    // ── Evaluation pipeline ────────────────────────────────────────
    evaluateLocalHeuristics(ctx, _rules, graph) {
        const findings = [];
        // 1. Payload-level risk analysis
        if (ctx.payload) {
            findings.push(...this.scoreActionRisk(ctx.payload));
            findings.push(...this.scoreParameterRisk(ctx.payload));
            findings.push(...this.scoreFinancialRisk(ctx.payload));
        }
        // 2. Graph-level conflict detection
        if (ctx.payload) {
            findings.push(...this.scoreGraphConflicts(ctx.payload, graph));
        }
        // 3. Aggregate risk score (max of individual findings, with severity weighting)
        const riskScore = this.aggregateRisk(findings);
        // 4. Intervention gate: trigger on high risk OR explicit policy requirement
        const requiresInterventionGate = riskScore >= 0.5 ||
            findings.some(f => f.severity === 'critical') ||
            this.actionRequiresApproval(ctx.payload);
        const statusAssessment = requiresInterventionGate
            ? `Pipeline validation flagged ${findings.length} finding(s) — aggregate risk ${riskScore.toFixed(2)}`
            : 'Pipeline validation completed cleanly — no findings requiring intervention.';
        const proposed_modifications = [];
        if (ctx.payload?.requested_action) {
            proposed_modifications.push({
                target_service: ctx.payload.origin ?? 'UnknownOrigin',
                action: ctx.payload.requested_action,
                parameters: ctx.payload.parameters ?? {},
            });
        }
        else if (ctx.payload) {
            proposed_modifications.push({
                target_service: 'GenericIngestHandler',
                action: 'ProcessIngestPayload',
                parameters: ctx.payload,
            });
        }
        return {
            requiresInterventionGate,
            riskScore,
            findings,
            actionPayload: {
                timestamp: new Date().toISOString(),
                agent_id: 'native_portfolio_agent_mvp',
                status_assessment: statusAssessment,
                proposed_modifications,
            },
        };
    }
    /** Score the action itself — certain actions are inherently risky. */
    scoreActionRisk(payload) {
        const findings = [];
        const action = (payload.requested_action ?? '').toUpperCase();
        if (ALWAYS_INTERVENE_ACTIONS.has(action)) {
            findings.push({
                category: 'PolicyAction',
                severity: 'critical',
                score: 1.0,
                detail: `Action "${payload.requested_action}" is on the mandatory-approval list.`,
            });
        }
        if (action.includes('DELETE') || action.includes('DROP') || action.includes('DESTROY')) {
            findings.push({
                category: 'DestructiveAction',
                severity: 'high',
                score: 0.8,
                detail: `Destructive operation detected: ${payload.requested_action}`,
            });
        }
        return findings;
    }
    /** Scan parameter keys/values for high-risk keywords. */
    scoreParameterRisk(payload) {
        const findings = [];
        const params = JSON.stringify(payload.parameters ?? '').toLowerCase();
        for (const keyword of HIGH_RISK_KEYWORDS) {
            if (params.includes(keyword)) {
                findings.push({
                    category: 'SensitiveParameter',
                    severity: 'high',
                    score: 0.7,
                    detail: `High-risk keyword "${keyword}" found in payload parameters.`,
                });
            }
        }
        return findings;
    }
    /** Detect large financial deltas. */
    scoreFinancialRisk(payload) {
        const findings = [];
        const params = payload.parameters ?? {};
        for (const key of Object.keys(params)) {
            const val = params[key];
            if (typeof val === 'number' && Math.abs(val) >= FINANCIAL_RISK_THRESHOLD) {
                // Check if the key suggests a financial context
                const financialKeys = ['amount', 'delta', 'allocation', 'budget', 'cost', 'value', 'sum'];
                if (financialKeys.some(fk => key.toLowerCase().includes(fk))) {
                    findings.push({
                        category: 'FinancialThreshold',
                        severity: 'high',
                        score: 0.75,
                        detail: `Financial parameter "${key}" = ${val} exceeds threshold of ${FINANCIAL_RISK_THRESHOLD}.`,
                    });
                }
            }
        }
        return findings;
    }
    /** Check whether the same entity already has a conflicting graph entry. */
    scoreGraphConflicts(payload, graph) {
        const findings = [];
        const taskId = payload.task_id;
        if (!taskId)
            return findings;
        const existing = graph.filter(n => n.entity.includes(taskId) || n.target.includes(taskId));
        if (existing.length > 0) {
            // Check if a prior evaluation had a different outcome
            const hadPriorIntervention = existing.some(n => n.relationship.includes('RequiresHITL'));
            if (hadPriorIntervention) {
                findings.push({
                    category: 'GraphConflict',
                    severity: 'medium',
                    score: 0.5,
                    detail: `Task ${taskId} was previously flagged for HITL — re-evaluation may indicate regression.`,
                });
            }
        }
        return findings;
    }
    /** Weighted aggregate: critical=1.0×, high=0.7×, medium=0.4×, low=0.1×. */
    aggregateRisk(findings) {
        if (findings.length === 0)
            return 0.0;
        const severityWeight = {
            critical: 1.0,
            high: 0.7,
            medium: 0.4,
            low: 0.1,
        };
        const weightedScores = findings.map(f => f.score * (severityWeight[f.severity] ?? 0.5));
        // Use the maximum weighted score — a single critical finding dominates
        return Math.max(...weightedScores, 0.0);
    }
    /** Check whether the payload's action is on the mandatory-approval list. */
    actionRequiresApproval(payload) {
        if (!payload?.requested_action)
            return false;
        return ALWAYS_INTERVENE_ACTIONS.has(payload.requested_action.toUpperCase());
    }
}
const engineInstance = new NanoClawNativeCore();
engineInstance.runCycle().catch(err => {
    console.error('Engine cycle failed:', err);
    process.exit(1);
});
