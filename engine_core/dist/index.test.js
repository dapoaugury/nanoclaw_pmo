"use strict";
/**
 * Unit Test Suite for NanoClaw Engine Core
 * Tests the main risk evaluation engine, scoring algorithms, and intervention gate logic
 */
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
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// Constants from index.ts
const ALWAYS_INTERVENE_ACTIONS = new Set([
    'EXECUTE_BUDGET_RECONCILIATION',
    'DELETE',
    'DROP',
    'TRUNCATE',
    'GRANT_ADMIN',
    'ROTATE_KEYS',
    'DEPLOY_PRODUCTION',
]);
const HIGH_RISK_KEYWORDS = [
    'password', 'secret', 'token', 'private_key', 'credential',
    'delete', 'drop', 'truncate', 'overwrite', 'bypass',
];
const FINANCIAL_RISK_THRESHOLD = 100_000;
// Test utilities
class TestEngine {
    db;
    tempDbPath;
    constructor() {
        this.tempDbPath = path.join(__dirname, '../../data/state/test_mnemon.db');
        const dbDir = path.dirname(this.tempDbPath);
        if (!fs.existsSync(dbDir))
            fs.mkdirSync(dbDir, { recursive: true });
        // Clean up any existing test DB
        if (fs.existsSync(this.tempDbPath))
            fs.unlinkSync(this.tempDbPath);
        if (fs.existsSync(this.tempDbPath + '-wal'))
            fs.unlinkSync(this.tempDbPath + '-wal');
        if (fs.existsSync(this.tempDbPath + '-shm'))
            fs.unlinkSync(this.tempDbPath + '-shm');
        this.db = new better_sqlite3_1.default(this.tempDbPath);
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
    cleanup() {
        this.db.close();
        try {
            if (fs.existsSync(this.tempDbPath))
                fs.unlinkSync(this.tempDbPath);
            if (fs.existsSync(this.tempDbPath + '-wal'))
                fs.unlinkSync(this.tempDbPath + '-wal');
            if (fs.existsSync(this.tempDbPath + '-shm'))
                fs.unlinkSync(this.tempDbPath + '-shm');
        }
        catch { /* ignore cleanup errors */ }
    }
    // Replicate scoring methods from index.ts for testing
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
    scoreFinancialRisk(payload) {
        const findings = [];
        const params = payload.parameters ?? {};
        for (const key of Object.keys(params)) {
            const val = params[key];
            if (typeof val === 'number' && Math.abs(val) >= FINANCIAL_RISK_THRESHOLD) {
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
    scoreGraphConflicts(payload, graph) {
        const findings = [];
        const taskId = payload.task_id;
        if (!taskId)
            return findings;
        const existing = graph.filter(n => n.entity.includes(taskId) || n.target.includes(taskId));
        if (existing.length > 0) {
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
        return Math.max(...weightedScores, 0.0);
    }
    actionRequiresApproval(payload) {
        if (!payload?.requested_action)
            return false;
        return ALWAYS_INTERVENE_ACTIONS.has(payload.requested_action.toUpperCase());
    }
    evaluateInterventionGate(riskScore, findings, payload) {
        return (riskScore >= 0.5 ||
            findings.some(f => f.severity === 'critical') ||
            this.actionRequiresApproval(payload));
    }
}
// Test runner
let passedTests = 0;
let failedTests = 0;
function assert(condition, testName, details) {
    if (condition) {
        console.log(`  ✅ ${testName}`);
        passedTests++;
    }
    else {
        console.log(`  ❌ ${testName}${details ? ` - ${details}` : ''}`);
        failedTests++;
    }
}
function assertEquals(actual, expected, testName) {
    const condition = JSON.stringify(actual) === JSON.stringify(expected);
    if (!condition) {
        console.log(`  ❌ ${testName} - Expected: ${JSON.stringify(expected)}, Got: ${JSON.stringify(actual)}`);
        failedTests++;
    }
    else {
        console.log(`  ✅ ${testName}`);
        passedTests++;
    }
}
// Test suites
console.log('\n========================================');
console.log('NanoClaw Engine Core - Unit Test Suite');
console.log('========================================\n');
const engine = new TestEngine();
try {
    // ── Test Suite: Action Risk Scoring ────────────────────────────────
    console.log('📋 Test Suite: Action Risk Scoring\n');
    // Test 1.1: Critical actions on mandatory-approval list
    let findings = engine.scoreActionRisk({ requested_action: 'EXECUTE_BUDGET_RECONCILIATION' });
    assert(findings.length === 1, 'Critical action triggers PolicyAction finding');
    assert(findings[0]?.severity === 'critical', 'Critical action has critical severity');
    assert(findings[0]?.score === 1.0, 'Critical action has max score');
    // Test 1.2: Destructive actions
    findings = engine.scoreActionRisk({ requested_action: 'DELETE_RECORD' });
    assert(findings.length === 1, 'DELETE action triggers DestructiveAction finding');
    assert(findings[0]?.category === 'DestructiveAction', 'Category is DestructiveAction');
    assert(findings[0]?.severity === 'high', 'Destructive action has high severity');
    // Test 1.3: Safe actions
    findings = engine.scoreActionRisk({ requested_action: 'UPDATE_STATUS' });
    assert(findings.length === 0, 'Safe action produces no findings');
    // Test 1.4: Multiple destructive keywords
    findings = engine.scoreActionRisk({ requested_action: 'DROP_TABLE' });
    assert(findings.length === 1, 'DROP action triggers finding');
    // ── Test Suite: Parameter Risk Scoring ─────────────────────────────
    console.log('\n📋 Test Suite: Parameter Risk Scoring\n');
    // Test 2.1: Sensitive keyword detection
    findings = engine.scoreParameterRisk({
        parameters: { username: 'admin', password: 'secret123' }
    });
    // Note: JSON.stringify of object includes both key and value, so "password" is found
    assert(findings.length >= 1, 'Password parameter triggers finding');
    assert(findings[0]?.category === 'SensitiveParameter', 'Category is SensitiveParameter');
    // Test 2.2: Multiple sensitive keywords
    findings = engine.scoreParameterRisk({
        parameters: { api_token: 'xyz', secret_key: 'abc' }
    });
    assert(findings.length >= 1, 'Multiple sensitive keywords trigger findings');
    // Test 2.3: Safe parameters
    findings = engine.scoreParameterRisk({
        parameters: { name: 'John', age: 30 }
    });
    assert(findings.length === 0, 'Safe parameters produce no findings');
    // Test 2.4: Keyword in nested structure
    findings = engine.scoreParameterRisk({
        parameters: { config: { credential: 'value' } }
    });
    assert(findings.length === 1, 'Nested credential keyword detected');
    // ── Test Suite: Financial Risk Scoring ─────────────────────────────
    console.log('\n📋 Test Suite: Financial Risk Scoring\n');
    // Test 3.1: Large financial amount
    findings = engine.scoreFinancialRisk({
        parameters: { amount: 150000 }
    });
    assert(findings.length === 1, 'Amount over threshold triggers finding');
    assert(findings[0]?.category === 'FinancialThreshold', 'Category is FinancialThreshold');
    // Test 3.2: Budget parameter
    findings = engine.scoreFinancialRisk({
        parameters: { budget_allocation: 200000 }
    });
    assert(findings.length === 1, 'Budget parameter over threshold triggers finding');
    // Test 3.3: Safe financial value
    findings = engine.scoreFinancialRisk({
        parameters: { amount: 5000 }
    });
    assert(findings.length === 0, 'Amount under threshold produces no finding');
    // Test 3.4: Non-financial large number
    findings = engine.scoreFinancialRisk({
        parameters: { count: 500000 }
    });
    assert(findings.length === 0, 'Large non-financial parameter ignored');
    // Test 3.5: Negative delta
    findings = engine.scoreFinancialRisk({
        parameters: { delta: -150000 }
    });
    assert(findings.length === 1, 'Negative delta over threshold triggers finding');
    // ── Test Suite: Graph Conflict Detection ───────────────────────────
    console.log('\n📋 Test Suite: Graph Conflict Detection\n');
    // Test 4.1: Prior HITL flag detected
    const graphWithHITL = [
        { entity: 'Task:JIRA-123', relationship: 'RiskEvaluated:0.8 → RequiresHITL', target: 'PolicyAction(critical)' }
    ];
    findings = engine.scoreGraphConflicts({ task_id: 'JIRA-123' }, graphWithHITL);
    assert(findings.length === 1, 'Prior HITL flag triggers GraphConflict finding');
    // Test 4.2: No prior conflicts
    const cleanGraph = [
        { entity: 'Task:JIRA-456', relationship: 'RiskEvaluated:0.1 → AutoApproved', target: 'clean' }
    ];
    findings = engine.scoreGraphConflicts({ task_id: 'JIRA-456' }, cleanGraph);
    assert(findings.length === 0, 'No prior HITL produces no finding');
    // Test 4.3: No task ID
    findings = engine.scoreGraphConflicts({}, []);
    assert(findings.length === 0, 'Missing task ID produces no finding');
    // ── Test Suite: Risk Aggregation ───────────────────────────────────
    console.log('\n📋 Test Suite: Risk Aggregation\n');
    // Test 5.1: Empty findings
    let score = engine.aggregateRisk([]);
    assertEquals(score, 0.0, 'Empty findings return 0.0');
    // Test 5.2: Single critical finding
    score = engine.aggregateRisk([{ category: 'Test', severity: 'critical', score: 1.0, detail: 'test' }]);
    assertEquals(score, 1.0, 'Critical finding returns 1.0');
    // Test 5.3: Single high finding
    score = engine.aggregateRisk([{ category: 'Test', severity: 'high', score: 0.7, detail: 'test' }]);
    assertEquals(score.toFixed(2), '0.49', 'High finding weighted correctly (0.7 * 0.7)');
    // Test 5.4: Multiple findings - max wins
    score = engine.aggregateRisk([
        { category: 'Test1', severity: 'low', score: 0.3, detail: 'test' },
        { category: 'Test2', severity: 'critical', score: 1.0, detail: 'test' },
        { category: 'Test3', severity: 'medium', score: 0.5, detail: 'test' }
    ]);
    assertEquals(score, 1.0, 'Maximum weighted score dominates');
    // Test 5.5: Medium severity weighting
    score = engine.aggregateRisk([{ category: 'Test', severity: 'medium', score: 0.5, detail: 'test' }]);
    assertEquals(score.toFixed(2), '0.20', 'Medium finding weighted correctly (0.5 * 0.4)');
    // ── Test Suite: Intervention Gate Logic ────────────────────────────
    console.log('\n📋 Test Suite: Intervention Gate Logic\n');
    // Test 6.1: High risk score triggers gate
    let requiresGate = engine.evaluateInterventionGate(0.6, [], null);
    assert(requiresGate === true, 'Risk score >= 0.5 triggers intervention');
    // Test 6.2: Low risk score passes
    requiresGate = engine.evaluateInterventionGate(0.3, [], null);
    assert(requiresGate === false, 'Low risk score passes without intervention');
    // Test 6.3: Critical finding triggers gate regardless of score
    requiresGate = engine.evaluateInterventionGate(0.2, [
        { category: 'Test', severity: 'critical', score: 0.3, detail: 'test' }
    ], null);
    assert(requiresGate === true, 'Critical severity triggers intervention');
    // Test 6.4: Mandatory approval action triggers gate
    requiresGate = engine.evaluateInterventionGate(0.0, [], { requested_action: 'DELETE' });
    assert(requiresGate === true, 'Mandatory approval action triggers intervention');
    // Test 6.5: Boundary case at 0.5
    requiresGate = engine.evaluateInterventionGate(0.5, [], null);
    assert(requiresGate === true, 'Risk score exactly 0.5 triggers intervention');
    // ── Test Suite: Action Approval Check ──────────────────────────────
    console.log('\n📋 Test Suite: Action Approval Check\n');
    // Test 7.1: Known approval actions
    assert(engine.actionRequiresApproval({ requested_action: 'EXECUTE_BUDGET_RECONCILIATION' }) === true, 'EXECUTE_BUDGET_RECONCILIATION requires approval');
    assert(engine.actionRequiresApproval({ requested_action: 'deploy_production' }) === true, 'DEPLOY_PRODUCTION (case insensitive) requires approval');
    // Test 7.2: Non-approval actions
    assert(engine.actionRequiresApproval({ requested_action: 'UPDATE_TASK' }) === false, 'Regular action does not require approval');
    // Test 7.3: Null/undefined payload
    assert(engine.actionRequiresApproval(null) === false, 'Null payload does not require approval');
    assert(engine.actionRequiresApproval({}) === false, 'Empty payload does not require approval');
    // ── Test Suite: Integration Scenarios ──────────────────────────────
    console.log('\n📋 Test Suite: Integration Scenarios\n');
    // Scenario 1: Budget reconciliation with large amount
    const budgetPayload = {
        task_id: 'JIRA-789',
        requested_action: 'EXECUTE_BUDGET_RECONCILIATION',
        parameters: { amount: 250000, department: 'Engineering' }
    };
    let actionFindings = engine.scoreActionRisk(budgetPayload);
    let financialFindings = engine.scoreFinancialRisk(budgetPayload);
    let allFindings = [...actionFindings, ...financialFindings];
    let aggregatedScore = engine.aggregateRisk(allFindings);
    requiresGate = engine.evaluateInterventionGate(aggregatedScore, allFindings, budgetPayload);
    assert(actionFindings.length === 1, 'Budget reconciliation triggers policy action');
    assert(financialFindings.length === 1, 'Large amount triggers financial threshold');
    assert(aggregatedScore === 1.0, 'Aggregated score is maximum');
    assert(requiresGate === true, 'Budget reconciliation always requires intervention');
    // Scenario 2: Safe status update
    const safePayload = {
        task_id: 'JIRA-100',
        requested_action: 'UPDATE_STATUS',
        parameters: { status: 'In Progress' }
    };
    allFindings = [
        ...engine.scoreActionRisk(safePayload),
        ...engine.scoreParameterRisk(safePayload),
        ...engine.scoreFinancialRisk(safePayload)
    ];
    aggregatedScore = engine.aggregateRisk(allFindings);
    requiresGate = engine.evaluateInterventionGate(aggregatedScore, allFindings, safePayload);
    assert(allFindings.length === 0, 'Safe payload produces no findings');
    assertEquals(aggregatedScore, 0.0, 'Safe payload has zero risk');
    assert(requiresGate === false, 'Safe payload does not require intervention');
    // Scenario 3: Destructive action with sensitive parameters
    const dangerousPayload = {
        task_id: 'JIRA-999',
        requested_action: 'DELETE_USER',
        parameters: { user_id: 123, password: 'admin123' }
    };
    actionFindings = engine.scoreActionRisk(dangerousPayload);
    const paramFindings = engine.scoreParameterRisk(dangerousPayload);
    allFindings = [...actionFindings, ...paramFindings];
    aggregatedScore = engine.aggregateRisk(allFindings);
    requiresGate = engine.evaluateInterventionGate(aggregatedScore, allFindings, dangerousPayload);
    assert(actionFindings.length >= 1, 'Destructive action detected');
    assert(paramFindings.length >= 1, 'Sensitive parameter detected');
    assert(requiresGate === true, 'Dangerous payload requires intervention');
}
finally {
    engine.cleanup();
}
// Summary
console.log('\n========================================');
console.log(`Test Results: ${passedTests} passed, ${failedTests} failed`);
console.log('========================================\n');
process.exit(failedTests > 0 ? 1 : 0);
