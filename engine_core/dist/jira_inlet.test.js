"use strict";
/**
 * Unit Test Suite for JIRA Inlet
 * Tests CSV parsing, relevance filtering, action inference, and payload transformation
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
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// Test utilities
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
// ── CSV Parsing Implementation (replicated from jira_inlet.ts) ─────────
function parseCsvRows(csvText) {
    const rows = [];
    let pos = 0;
    const len = csvText.length;
    function readField() {
        if (pos >= len)
            return '';
        if (csvText[pos] === '"') {
            // Quoted field
            pos++; // skip opening quote
            let value = '';
            while (pos < len) {
                if (csvText[pos] === '"') {
                    if (pos + 1 < len && csvText[pos + 1] === '"') {
                        value += '"';
                        pos += 2; // escaped quote
                    }
                    else {
                        pos++; // closing quote
                        break;
                    }
                }
                else {
                    value += csvText[pos];
                    pos++;
                }
            }
            // Skip trailing comma if present
            if (pos < len && csvText[pos] === ',')
                pos++;
            return value;
        }
        else {
            // Unquoted field
            let value = '';
            while (pos < len && csvText[pos] !== ',' && csvText[pos] !== '\n' && csvText[pos] !== '\r') {
                value += csvText[pos];
                pos++;
            }
            if (pos < len && csvText[pos] === ',')
                pos++;
            return value;
        }
    }
    function readLine() {
        const fields = [];
        while (pos < len) {
            fields.push(readField());
            if (pos >= len || csvText[pos] === '\n' || csvText[pos] === '\r') {
                break;
            }
        }
        // Skip line ending
        while (pos < len && (csvText[pos] === '\n' || csvText[pos] === '\r'))
            pos++;
        return fields;
    }
    // Read header row
    const headers = readLine();
    if (headers.length === 0)
        return rows;
    // Read data rows
    while (pos < len) {
        const fields = readLine();
        if (fields.length === 0 || (fields.length === 1 && fields[0].trim() === ''))
            continue;
        const row = {};
        for (let i = 0; i < headers.length; i++) {
            row[headers[i]] = fields[i] ?? '';
        }
        rows.push(row);
    }
    return rows;
}
// ── Relevance Filtering (replicated from jira_inlet.ts) ────────────────
function isRelevant(issue, filters) {
    const { labels_include, labels_exclude, issue_types_include, project_keys } = filters;
    const labels = issue.fields.labels ?? [];
    const issueType = issue.fields.issuetype?.name ?? '';
    const projectKey = issue.fields.project?.key ?? '';
    // Exclude by label
    if (labels_exclude.some(ex => labels.some(l => l.toLowerCase() === ex.toLowerCase()))) {
        return false;
    }
    // Include by label match
    const hasIncludedLabel = labels_include.some(inc => labels.some(l => l.toLowerCase() === inc.toLowerCase()));
    // Include by issue type match
    const isIncludedType = issue_types_include.some(t => t.toLowerCase() === issueType.toLowerCase());
    // Filter by project key (if set)
    if (project_keys.length > 0 && !project_keys.includes(projectKey)) {
        return false;
    }
    // Relevant if it has a matching label OR is an included type
    return hasIncludedLabel || isIncludedType;
}
// ── Action Inference (replicated from jira_inlet.ts) ───────────────────
function inferActionFromIssue(issue) {
    const labels = (issue.fields.labels ?? []).map(l => l.toLowerCase());
    const summary = (issue.fields.summary ?? '').toLowerCase();
    const status = (issue.fields.status?.name ?? '').toLowerCase();
    const issueType = (issue.fields.issuetype?.name ?? '').toLowerCase();
    // Blockers and escalations
    if (labels.includes('blocker') || labels.includes('escalate') || labels.includes('critical-path')) {
        return 'FLAG_BLOCKER';
    }
    // Bugs and incidents
    if (issueType.includes('bug') || issueType.includes('incident')) {
        return 'FLAG_VARIANCE';
    }
    // Budget/cost related
    if (summary.includes('budget') || summary.includes('cost') || summary.includes('financial')
        || labels.includes('budget')) {
        return 'EXECUTE_BUDGET_RECONCILIATION';
    }
    // Approval workflows
    if (summary.includes('approval') || summary.includes('sign-off') || status.includes('review')) {
        return 'REQUEST_APPROVAL';
    }
    // Milestones
    if (summary.includes('milestone') || summary.includes('deliverable') || labels.includes('milestone')) {
        return 'LOG_MILESTONE_UPDATE';
    }
    // Dependencies
    if (labels.includes('dependency')) {
        return 'REQUEST_ALLOCATION_CHANGE';
    }
    // Risk items
    if (labels.includes('risk')) {
        return 'FLAG_VARIANCE';
    }
    // Epic completion
    if (issueType.includes('epic') && status.includes('done')) {
        return 'LOG_MILESTONE_UPDATE';
    }
    return 'PROCESS_JIRA_UPDATE';
}
// ── Payload Transformation (replicated from jira_inlet.ts) ─────────────
function issueToIngestPayload(issue, queryName) {
    const action = inferActionFromIssue(issue);
    const description = issue.fields.description ?? '';
    const descriptionPreview = description.length > 500
        ? description.substring(0, 500) + '...'
        : description;
    return {
        task_id: `JIRA-${issue.key}`,
        origin: `JIRA_QUERY:${queryName}`,
        source_system: 'JIRA',
        requested_action: action,
        summary: issue.fields.summary,
        description_preview: descriptionPreview,
        parameters: {
            issue_key: issue.key,
            issue_id: issue.id,
            issue_type: issue.fields.issuetype?.name ?? 'Unknown',
            status: issue.fields.status?.name ?? 'Unknown',
            priority: issue.fields.priority?.name ?? 'Unassigned',
            labels: issue.fields.labels ?? [],
            project: issue.fields.project?.name ?? issue.fields.project?.key ?? 'Unknown',
            assignee: issue.fields.assignee?.displayName ?? 'Unassigned',
            reporter: issue.fields.reporter?.displayName ?? 'Unknown',
            updated: issue.fields.updated,
            components: issue.fields.components?.map(c => c.name) ?? [],
            fix_versions: issue.fields.fixVersions?.map(v => v.name) ?? [],
        },
        timestamp: new Date().toISOString(),
    };
}
// ── Test Suites ────────────────────────────────────────────────────────
console.log('\n========================================');
console.log('JIRA Inlet - Unit Test Suite');
console.log('========================================\n');
// ── Test Suite: CSV Parsing ────────────────────────────────────────────
console.log('📋 Test Suite: CSV Parsing\n');
// Test 1.1: Simple CSV parsing
const simpleCsv = `Issue key,Summary,Status
JIRA-1,First issue,Open
JIRA-2,Second issue,Closed`;
const simpleRows = parseCsvRows(simpleCsv);
assert(simpleRows.length === 2, 'Simple CSV parses to correct row count');
assertEquals(simpleRows[0]['Issue key'], 'JIRA-1', 'First row key correct');
assertEquals(simpleRows[1]['Summary'], 'Second issue', 'Second row summary correct');
// Test 1.2: CSV with quoted fields
const quotedCsv = `Issue key,Summary,Description
JIRA-3,"Summary with, comma","Description with
newline"`;
const quotedRows = parseCsvRows(quotedCsv);
assert(quotedRows.length === 1, 'Quoted CSV parses correctly');
assertEquals(quotedRows[0]['Summary'], 'Summary with, comma', 'Comma in quotes preserved');
assert(quotedRows[0]['Description'].includes('newline'), 'Newline in quotes preserved');
// Test 1.3: CSV with escaped quotes
const escapedCsv = `Issue key,Summary
JIRA-4,"Summary with ""escaped"" quotes"`;
const escapedRows = parseCsvRows(escapedCsv);
assertEquals(escapedRows[0]['Summary'], 'Summary with "escaped" quotes', 'Escaped quotes handled');
// Test 1.4: Empty CSV
const emptyRows = parseCsvRows('');
assert(emptyRows.length === 0, 'Empty CSV returns no rows');
// Test 1.5: Header-only CSV
const headerOnlyRows = parseCsvRows('Issue key,Summary,Status');
assert(headerOnlyRows.length === 0, 'Header-only CSV returns no data rows');
// ── Test Suite: Relevance Filtering ────────────────────────────────────
console.log('\n📋 Test Suite: Relevance Filtering\n');
const defaultFilters = {
    labels_include: ['feature', 'bug'],
    labels_exclude: ['wontfix'],
    issue_types_include: ['Story', 'Bug', 'Task'],
    project_keys: [],
};
// Test 2.1: Matching label
const issueWithLabel = {
    id: '1', key: 'JIRA-1', self: '',
    fields: {
        summary: 'Test', description: null,
        status: { name: 'Open', statusCategory: { name: 'To Do' } },
        priority: { name: 'High', iconUrl: '' },
        issuetype: { name: 'Story', iconUrl: '' },
        labels: ['feature'],
        updated: '2024-01-01', created: '2024-01-01',
        assignee: null, reporter: null,
        project: { key: 'PROJ', name: 'Project' },
        components: [], fixVersions: []
    }
};
assert(isRelevant(issueWithLabel, defaultFilters) === true, 'Issue with matching label is relevant');
// Test 2.2: Matching issue type
const issueWithType = {
    ...issueWithLabel,
    fields: { ...issueWithLabel.fields, labels: [] }
};
assert(isRelevant(issueWithType, defaultFilters) === true, 'Issue with matching type is relevant');
// Test 2.3: Excluded label
const excludedFilters = { ...defaultFilters, labels_exclude: ['feature'] };
assert(isRelevant(issueWithLabel, excludedFilters) === false, 'Issue with excluded label is not relevant');
// Test 2.4: No matches
const irrelevantIssue = {
    ...issueWithLabel,
    fields: { ...issueWithLabel.fields, labels: ['other'], issuetype: { name: 'Epic', iconUrl: '' } }
};
assert(isRelevant(irrelevantIssue, defaultFilters) === false, 'Issue with no matches is not relevant');
// Test 2.5: Project filter
const projectFilters = { ...defaultFilters, project_keys: ['OTHER'] };
assert(isRelevant(issueWithLabel, projectFilters) === false, 'Issue outside project filter is not relevant');
// Test 2.6: Case insensitive label matching
const caseIssue = {
    ...issueWithLabel,
    fields: { ...issueWithLabel.fields, labels: ['FEATURE'] }
};
assert(isRelevant(caseIssue, defaultFilters) === true, 'Label matching is case insensitive');
// ── Test Suite: Action Inference ───────────────────────────────────────
console.log('\n📋 Test Suite: Action Inference\n');
// Test 3.1: Blocker detection
const blockerIssue = {
    ...issueWithLabel,
    fields: { ...issueWithLabel.fields, labels: ['blocker'] }
};
assertEquals(inferActionFromIssue(blockerIssue), 'FLAG_BLOCKER', 'Blocker label triggers FLAG_BLOCKER');
// Test 3.2: Bug type detection
const bugIssue = {
    ...issueWithLabel,
    fields: { ...issueWithLabel.fields, labels: [], issuetype: { name: 'Bug', iconUrl: '' } }
};
assertEquals(inferActionFromIssue(bugIssue), 'FLAG_VARIANCE', 'Bug type triggers FLAG_VARIANCE');
// Test 3.3: Budget detection
const budgetIssue = {
    ...issueWithLabel,
    fields: { ...issueWithLabel.fields, labels: [], summary: 'Update budget allocation' }
};
assertEquals(inferActionFromIssue(budgetIssue), 'EXECUTE_BUDGET_RECONCILIATION', 'Budget keyword triggers budget action');
// Test 3.4: Approval detection
const approvalIssue = {
    ...issueWithLabel,
    fields: { ...issueWithLabel.fields, labels: [], summary: 'Need approval for deployment' }
};
assertEquals(inferActionFromIssue(approvalIssue), 'REQUEST_APPROVAL', 'Approval keyword triggers approval action');
// Test 3.5: Milestone detection
const milestoneIssue = {
    ...issueWithLabel,
    fields: { ...issueWithLabel.fields, labels: ['milestone'], summary: 'Sprint goal' }
};
assertEquals(inferActionFromIssue(milestoneIssue), 'LOG_MILESTONE_UPDATE', 'Milestone label triggers milestone action');
// Test 3.6: Dependency detection
const dependencyIssue = {
    ...issueWithLabel,
    fields: { ...issueWithLabel.fields, labels: ['dependency'], summary: 'Task' }
};
assertEquals(inferActionFromIssue(dependencyIssue), 'REQUEST_ALLOCATION_CHANGE', 'Dependency label triggers allocation change');
// Test 3.7: Risk detection
const riskIssue = {
    ...issueWithLabel,
    fields: { ...issueWithLabel.fields, labels: ['risk'], summary: 'Task' }
};
assertEquals(inferActionFromIssue(riskIssue), 'FLAG_VARIANCE', 'Risk label triggers variance flag');
// Test 3.8: Epic completion
const epicDoneIssue = {
    ...issueWithLabel,
    fields: {
        ...issueWithLabel.fields,
        labels: [],
        issuetype: { name: 'Epic', iconUrl: '' },
        status: { name: 'Done', statusCategory: { name: 'Done' } }
    }
};
assertEquals(inferActionFromIssue(epicDoneIssue), 'LOG_MILESTONE_UPDATE', 'Completed epic triggers milestone update');
// Test 3.9: Default action
const defaultIssue = {
    ...issueWithLabel,
    fields: { ...issueWithLabel.fields, labels: [], summary: 'Regular task', issuetype: { name: 'Task', iconUrl: '' } }
};
assertEquals(inferActionFromIssue(defaultIssue), 'PROCESS_JIRA_UPDATE', 'Regular issue gets default action');
// Test 3.10: Priority order - blocker takes precedence
const blockerBudgetIssue = {
    ...issueWithLabel,
    fields: { ...issueWithLabel.fields, labels: ['blocker'], summary: 'Budget emergency' }
};
assertEquals(inferActionFromIssue(blockerBudgetIssue), 'FLAG_BLOCKER', 'Blocker takes precedence over budget');
// ── Test Suite: Payload Transformation ─────────────────────────────────
console.log('\n📋 Test Suite: Payload Transformation\n');
const testIssue = {
    id: '10001',
    key: 'TEST-123',
    self: 'https://jira.example.com/rest/api/2/issue/10001',
    fields: {
        summary: 'Implement new feature',
        description: 'This is a detailed description of the feature...',
        status: { name: 'In Progress', statusCategory: { name: 'In Progress' } },
        priority: { name: 'High', iconUrl: 'https://jira.example.com/icons/high.png' },
        issuetype: { name: 'Story', iconUrl: 'https://jira.example.com/icons/story.png' },
        labels: ['feature', 'frontend'],
        updated: '2024-01-15T10:30:00.000Z',
        created: '2024-01-10T08:00:00.000Z',
        assignee: { displayName: 'John Doe', emailAddress: 'john@example.com' },
        reporter: { displayName: 'Jane Smith', emailAddress: 'jane@example.com' },
        project: { key: 'TEST', name: 'Test Project' },
        components: [{ name: 'UI' }, { name: 'API' }],
        fixVersions: [{ name: 'v1.0', released: false }]
    }
};
const payload = issueToIngestPayload(testIssue, 'Recent Updates');
// Test 4.1: Task ID format
assert(payload.task_id === 'JIRA-TEST-123', 'Task ID formatted correctly');
// Test 4.2: Origin includes query name
assert(payload.origin === 'JIRA_QUERY:Recent Updates', 'Origin includes query name');
// Test 4.3: Source system
assertEquals(payload.source_system, 'JIRA', 'Source system is JIRA');
// Test 4.4: Action inferred correctly
assertEquals(payload.requested_action, 'PROCESS_JIRA_UPDATE', 'Action inferred from issue');
// Test 4.5: Summary preserved
assertEquals(payload.summary, 'Implement new feature', 'Summary preserved');
// Test 4.6: Description preview (short)
assert(payload.description_preview.startsWith('This is a detailed'), 'Description preview starts correctly');
// Test 4.7: Parameters - issue key
assertEquals(payload.parameters.issue_key, 'TEST-123', 'Issue key in parameters');
// Test 4.8: Parameters - issue ID
assertEquals(payload.parameters.issue_id, '10001', 'Issue ID in parameters');
// Test 4.9: Parameters - labels
assertEquals(payload.parameters.labels, ['feature', 'frontend'], 'Labels array preserved');
// Test 4.10: Parameters - components
assertEquals(payload.parameters.components, ['UI', 'API'], 'Components extracted');
// Test 4.11: Parameters - fix versions
assertEquals(payload.parameters.fix_versions, ['v1.0'], 'Fix versions extracted');
// Test 4.12: Timestamp generated
assert(payload.timestamp.length > 0, 'Timestamp generated');
assert(new Date(payload.timestamp).getTime() > 0, 'Timestamp is valid date');
// Test 4.13: Long description truncation
const longDescIssue = {
    ...testIssue,
    fields: { ...testIssue.fields, description: 'A'.repeat(600) }
};
const longPayload = issueToIngestPayload(longDescIssue, 'Test');
assert(longPayload.description_preview.length <= 503, 'Long description truncated with ellipsis');
assert(longPayload.description_preview.endsWith('...'), 'Truncated description ends with ellipsis');
// ── Test Suite: Integration with Real CSV Data ─────────────────────────
console.log('\n📋 Test Suite: Integration with CSV Data\n');
// Check if sample CSV exists
const csvPath = path.join(__dirname, '../../data/Jira.csv');
if (fs.existsSync(csvPath)) {
    const csvContent = fs.readFileSync(csvPath, 'utf8');
    const rows = parseCsvRows(csvContent);
    assert(rows.length > 0, 'Sample CSV has data rows');
    // Process first row if available
    if (rows.length > 0) {
        const firstRow = rows[0];
        // Verify required columns exist
        assert(firstRow['Issue key'] !== undefined, 'CSV has Issue key column');
        assert(firstRow['Summary'] !== undefined, 'CSV has Summary column');
        assert(firstRow['Status'] !== undefined, 'CSV has Status column');
        console.log(`  ℹ️  Sample row: ${firstRow['Issue key']} - ${firstRow['Summary']?.substring(0, 50)}`);
    }
}
else {
    console.log('  ℹ️  Skipping CSV integration tests - no sample CSV found');
}
// Summary
console.log('\n========================================');
console.log(`Test Results: ${passedTests} passed, ${failedTests} failed`);
console.log('========================================\n');
process.exit(failedTests > 0 ? 1 : 0);
