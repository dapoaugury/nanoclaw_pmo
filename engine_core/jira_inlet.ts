import * as fs from 'fs';
import * as path from 'path';

const INGEST_PATH = path.resolve(__dirname, '../../data/ingest');
const SYNC_STATE_PATH = path.resolve(__dirname, '../../data/state/jira_sync.json');
const CONFIG_PATH = path.resolve(__dirname, './jira_config.json');

// ── JIRA REST API types ──────────────────────────────────────────

interface JiraIssue {
    id: string;
    key: string;
    self: string;
    fields: {
        summary: string;
        description: string | null;
        status: { name: string; statusCategory: { name: string } };
        priority: { name: string; iconUrl: string } | null;
        issuetype: { name: string; iconUrl: string };
        labels: string[];
        updated: string;
        created: string;
        assignee: { displayName: string; emailAddress: string } | null;
        reporter: { displayName: string; emailAddress: string } | null;
        project: { key: string; name: string };
        components: { name: string }[];
        fixVersions: { name: string; released: boolean }[];
        customfield_10016?: string; // story points (varies by instance)
        customfield_10022?: string; // epic link (varies by instance)
    };
}

interface JiraSearchResponse {
    startAt: number;
    maxResults: number;
    total: number;
    issues: JiraIssue[];
}

interface SyncState {
    processedIssueKeys: string[];
    lastSyncTime: string;
    lastRunTimestamp: string;
    queryLastRun: Record<string, string>;  // query name → last ISO timestamp
}

interface JiraConfig {
    jira: {
        base_url: string;
        email: string;
        api_token: string;
    };
    polling: {
        interval_ms: number;
        max_results_per_query: number;
        updated_since_hours: number;
    };
    queries: {
        name: string;
        jql: string;
        description: string;
    }[];
    filters: {
        project_keys: string[];
        labels_include: string[];
        labels_exclude: string[];
        issue_types_include: string[];
        statuses_trigger_gate: string[];
    };
}

// ── Configuration & state ────────────────────────────────────────

function loadConfig(): JiraConfig {
    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error(`JIRA config not found at ${CONFIG_PATH}. Copy jira_config.json and populate credentials.`);
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as JiraConfig;
}

function loadSyncState(): SyncState {
    if (fs.existsSync(SYNC_STATE_PATH)) {
        return JSON.parse(fs.readFileSync(SYNC_STATE_PATH, 'utf8')) as SyncState;
    }
    return {
        processedIssueKeys: [],
        lastSyncTime: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        lastRunTimestamp: new Date().toISOString(),
        queryLastRun: {},
    };
}

function saveSyncState(state: SyncState): void {
    const dir = path.dirname(SYNC_STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    state.processedIssueKeys = state.processedIssueKeys.slice(-2000);
    fs.writeFileSync(SYNC_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// ── JIRA API client ──────────────────────────────────────────────

function buildAuthHeader(config: JiraConfig): string {
    const { email, api_token } = config.jira;
    if (!email || !api_token) {
        throw new Error('JIRA credentials not configured. Set email and api_token in jira_config.json.');
    }
    const credentials = Buffer.from(`${email}:${api_token}`).toString('base64');
    return `Basic ${credentials}`;
}

async function searchIssues(
    config: JiraConfig,
    jql: string,
    maxResults: number,
    startAt: number = 0
): Promise<JiraSearchResponse> {
    const baseUrl = config.jira.base_url.replace(/\/+$/, '');
    const fields = [
        'summary', 'description', 'status', 'priority', 'issuetype',
        'labels', 'updated', 'created', 'assignee', 'reporter',
        'project', 'components', 'fixVersions',
    ].join(',');

    // Use GET on the new /rest/api/3/search/jql endpoint with query params
    const params = new URLSearchParams();
    params.set('jql', jql);
    params.set('maxResults', String(maxResults));
    params.set('startAt', String(startAt));
    params.set('fields', fields);

    const url = `${baseUrl}/rest/api/3/search/jql?${params.toString()}`;

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            Authorization: buildAuthHeader(config),
            Accept: 'application/json',
        },
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`JIRA API request failed (${response.status}): ${errorBody}`);
    }

    return (await response.json()) as JiraSearchResponse;
}

// ── Relevance filtering ──────────────────────────────────────────

function isRelevant(issue: JiraIssue, config: JiraConfig): boolean {
    const { labels_include, labels_exclude, issue_types_include, project_keys } = config.filters;

    const labels = issue.fields.labels ?? [];
    const issueType = issue.fields.issuetype?.name ?? '';
    const projectKey = issue.fields.project?.key ?? '';

    // Exclude by label
    if (labels_exclude.some(ex => labels.some(l => l.toLowerCase() === ex.toLowerCase()))) {
        return false;
    }

    // Include by label match
    const hasIncludedLabel = labels_include.some(inc =>
        labels.some(l => l.toLowerCase() === inc.toLowerCase())
    );

    // Include by issue type match
    const isIncludedType = issue_types_include.some(t =>
        t.toLowerCase() === issueType.toLowerCase()
    );

    // Filter by project key (if set)
    if (project_keys.length > 0 && !project_keys.includes(projectKey)) {
        return false;
    }

    // Relevant if it has a matching label OR is an included type
    return hasIncludedLabel || isIncludedType;
}

// ── Action inference ─────────────────────────────────────────────

interface JiraIngestPayload {
    task_id: string;
    origin: string;
    source_system: string;
    requested_action: string;
    summary: string;
    description_preview: string;
    parameters: {
        issue_key: string;
        issue_id: string;
        issue_type: string;
        status: string;
        priority: string;
        labels: string[];
        project: string;
        assignee: string;
        reporter: string;
        updated: string;
        components: string[];
        fix_versions: string[];
    };
    timestamp: string;
}

// ── CSV-specific types ───────────────────────────────────────────

interface CsvRow {
    [columnName: string]: string;
}

interface CsvIngestResult {
    sourceFile: string;
    totalRows: number;
    relevant: number;
    ingested: number;
    skipped: number;
}

function inferActionFromIssue(issue: JiraIssue): string {
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

function issueToIngestPayload(issue: JiraIssue, queryName: string): JiraIngestPayload {
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

// ── Write to ingest directory ────────────────────────────────────

function writeToIngest(payload: JiraIngestPayload, issueKey: string): string {
    if (!fs.existsSync(INGEST_PATH)) fs.mkdirSync(INGEST_PATH, { recursive: true });

    const safeKey = issueKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `jira_${safeKey}_${Date.now()}.json`;
    const filePath = path.join(INGEST_PATH, filename);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return filename;
}

// ── Main JIRA ingestion cycle ────────────────────────────────────

export async function runJiraIngestion(): Promise<{
    queriesRun: number;
    totalFetched: number;
    relevant: number;
    ingested: number;
    skipped: number;
}> {
    const config = loadConfig();
    const syncState = loadSyncState();

    console.log('\n📋 [JIRA INLET] Starting JIRA ingestion cycle...');
    console.log(`   Last sync: ${syncState.lastSyncTime}`);
    console.log(`   Processed keys in ledger: ${syncState.processedIssueKeys.length}`);
    console.log(`   Configured queries: ${config.queries.length}`);

    const { max_results_per_query } = config.polling;
    const processedKeys = new Set(syncState.processedIssueKeys);

    let totalFetched = 0;
    let relevantCount = 0;
    let ingestedCount = 0;
    let skippedCount = 0;
    let queriesRun = 0;

    for (const query of config.queries) {
        queriesRun++;
        console.log(`\n   🔍 Query [${query.name}]: ${query.description}`);

        let searchResponse: JiraSearchResponse;
        try {
            searchResponse = await searchIssues(config, query.jql, max_results_per_query);
        } catch (err) {
            console.error(`   ❌ Query failed: ${(err as Error).message}`);
            continue;
        }

        totalFetched += searchResponse.issues.length;
        console.log(`      Fetched ${searchResponse.issues.length} issue(s) (total in JIRA: ${searchResponse.total})`);

        for (const issue of searchResponse.issues) {
            const issueKey = issue.key;

            // Dedup: skip already-processed issues
            if (processedKeys.has(issueKey)) {
                skippedCount++;
                continue;
            }

            // Relevance filter
            if (!isRelevant(issue, config)) {
                skippedCount++;
                processedKeys.add(issueKey);
                continue;
            }

            relevantCount++;
            const payload = issueToIngestPayload(issue, query.name);
            const filename = writeToIngest(payload, issueKey);
            processedKeys.add(issueKey);
            ingestedCount++;

            console.log(`      ✅ Ingested: ${issueKey} "${issue.fields.summary}" → ${filename}`);
        }
    }

    // Update sync state
    syncState.processedIssueKeys = Array.from(processedKeys);
    syncState.lastSyncTime = new Date().toISOString();
    syncState.lastRunTimestamp = new Date().toISOString();
    saveSyncState(syncState);

    console.log(`\n   Summary: ${queriesRun} queries, ${totalFetched} fetched, ${relevantCount} relevant, ${ingestedCount} ingested, ${skippedCount} skipped`);

    return {
        queriesRun,
        totalFetched,
        relevant: relevantCount,
        ingested: ingestedCount,
        skipped: skippedCount,
    };
}

// ── CSV parsing ──────────────────────────────────────────────────

/**
 * Parse a CSV string into rows, handling quoted fields and escaped quotes.
 * JIRA CSV exports use double-quotes for fields containing commas/newlines,
 * and escape internal quotes by doubling them ("").
 */
function parseCsvRows(csvText: string): CsvRow[] {
    const rows: CsvRow[] = [];
    let pos = 0;
    const len = csvText.length;

    function readField(): string {
        if (pos >= len) return '';

        if (csvText[pos] === '"') {
            // Quoted field
            pos++; // skip opening quote
            let value = '';
            while (pos < len) {
                if (csvText[pos] === '"') {
                    if (pos + 1 < len && csvText[pos + 1] === '"') {
                        value += '"';
                        pos += 2; // escaped quote
                    } else {
                        pos++; // closing quote
                        break;
                    }
                } else {
                    value += csvText[pos];
                    pos++;
                }
            }
            // Skip trailing comma if present
            if (pos < len && csvText[pos] === ',') pos++;
            return value;
        } else {
            // Unquoted field
            let value = '';
            while (pos < len && csvText[pos] !== ',' && csvText[pos] !== '\n' && csvText[pos] !== '\r') {
                value += csvText[pos];
                pos++;
            }
            if (pos < len && csvText[pos] === ',') pos++;
            return value;
        }
    }

    function readLine(): string[] {
        const fields: string[] = [];
        while (pos < len) {
            fields.push(readField());
            if (pos >= len || csvText[pos] === '\n' || csvText[pos] === '\r') {
                break;
            }
        }
        // Skip line ending
        while (pos < len && (csvText[pos] === '\n' || csvText[pos] === '\r')) pos++;
        return fields;
    }

    // Read header row
    const headers = readLine();
    if (headers.length === 0) return rows;

    // Read data rows
    while (pos < len) {
        const fields = readLine();
        if (fields.length === 0 || (fields.length === 1 && fields[0].trim() === '')) continue;

        const row: CsvRow = {};
        for (let i = 0; i < headers.length; i++) {
            row[headers[i]] = fields[i] ?? '';
        }
        rows.push(row);
    }

    return rows;
}

/**
 * Map a CSV row to a JiraIngestPayload using the JIRA CSV export column names.
 */
function csvRowToPayload(row: CsvRow, sourceFile: string): JiraIngestPayload | null {
    const issueKey = row['Issue key'] ?? '';
    const issueId = row['Issue id'] ?? '';
    const issueType = row['Issue Type'] ?? '';
    const status = row['Status'] ?? '';
    const projectKey = row['Project key'] ?? '';
    const projectName = row['Project name'] ?? '';
    const summary = row['Summary'] ?? '';
    const description = row['Description'] ?? '';
    const priority = row['Priority'] ?? '';
    const resolution = row['Resolution'] ?? '';
    const assignee = row['Assignee'] ?? '';
    const reporter = row['Reporter'] ?? '';
    const created = row['Created'] ?? '';
    const updated = row['Updated'] ?? '';
    const labelsRaw = row['Labels'] ?? '';

    if (!issueKey) return null;

    // Parse labels (space-separated or comma-separated in JIRA CSV)
    const labels = labelsRaw.trim() 
      ? labelsRaw.trim().split(/[\s,]+/).filter(l => l.length > 0)
      : [];

    // Build a synthetic JiraIssue for the existing inference/filtering pipeline
    const syntheticIssue: JiraIssue = {
        id: issueId,
        key: issueKey,
        self: '',
        fields: {
            summary,
            description: description || null,
            status: { name: status, statusCategory: { name: '' } },
            priority: { name: priority, iconUrl: '' },
            issuetype: { name: issueType, iconUrl: '' },
            labels,
            updated: updated || created,
            created: created,
            assignee: assignee ? { displayName: assignee, emailAddress: '' } : null,
            reporter: reporter ? { displayName: reporter, emailAddress: '' } : null,
            project: { key: projectKey, name: projectName },
            components: [],
            fixVersions: [],
        },
    };

    const descriptionPreview = description.length > 500
        ? description.substring(0, 500) + '...'
        : description;

    const action = inferActionFromIssue(syntheticIssue);

    return {
        task_id: `JIRA-${issueKey}`,
        origin: `JIRA_CSV:${sourceFile}`,
        source_system: 'JIRA',
        requested_action: action,
        summary,
        description_preview: descriptionPreview,
        parameters: {
            issue_key: issueKey,
            issue_id: issueId,
            issue_type: issueType,
            status,
            priority,
            labels,
            project: projectName || projectKey || 'Unknown',
            assignee: assignee || 'Unassigned',
            reporter: reporter || 'Unknown',
            updated: updated || created,
            components: [],
            fix_versions: [],
        },
        timestamp: new Date().toISOString(),
    };
}

// ── CSV ingestion ────────────────────────────────────────────────

const CSV_INGEST_PATH = path.resolve(__dirname, '../../data');

export async function runJiraCsvIngestion(csvFilePath?: string): Promise<CsvIngestResult> {
    const filePath = csvFilePath ?? path.join(CSV_INGEST_PATH, 'Jira.csv');

    if (!fs.existsSync(filePath)) {
        throw new Error(`CSV file not found at ${filePath}. Pass a path or place Jira.csv in data/`);
    }

    const config = loadConfig();
    const syncState = loadSyncState();
    const processedKeys = new Set(syncState.processedIssueKeys);

    const csvText = fs.readFileSync(filePath, 'utf8');
    const rows = parseCsvRows(csvText);

    console.log(`\n📊 [JIRA CSV INLET] Processing ${rows.length} rows from ${filePath}`);

    let relevantCount = 0;
    let ingestedCount = 0;
    let skippedCount = 0;

    for (const row of rows) {
        const issueKey = row['Issue key'] ?? '';
        if (!issueKey) {
            skippedCount++;
            continue;
        }

        // Dedup: skip already-processed issues
        if (processedKeys.has(issueKey)) {
            console.log(`   ⏭️  Skipped (already processed): ${issueKey}`);
            skippedCount++;
            continue;
        }

        const payload = csvRowToPayload(row, path.basename(filePath));
        if (!payload) {
            skippedCount++;
            continue;
        }

        // Build synthetic issue for relevance filtering
        const syntheticIssue: JiraIssue = {
            id: row['Issue id'] ?? '',
            key: issueKey,
            self: '',
            fields: {
                summary: row['Summary'] ?? '',
                description: row['Description'] || null,
                status: { name: row['Status'] ?? '', statusCategory: { name: '' } },
                priority: { name: row['Priority'] ?? '', iconUrl: '' },
                issuetype: { name: row['Issue Type'] ?? '', iconUrl: '' },
                labels: (row['Labels'] ?? '').trim() 
                  ? (row['Labels'] ?? '').trim().split(/[\s,]+/).filter(l => l.length > 0)
                  : [],
                updated: row['Updated'] ?? row['Created'] ?? '',
                created: row['Created'] ?? '',
                assignee: row['Assignee'] ? { displayName: row['Assignee'], emailAddress: '' } : null,
                reporter: row['Reporter'] ? { displayName: row['Reporter'], emailAddress: '' } : null,
                project: { key: row['Project key'] ?? '', name: row['Project name'] ?? '' },
                components: [],
                fixVersions: [],
            },
        };

        // Relevance filter
        if (!isRelevant(syntheticIssue, config)) {
            console.log(`   ❌ Skipped (not relevant): ${issueKey} - Labels: [${(row['Labels'] ?? '').trim()}], Type: ${row['Issue Type'] ?? ''}`);
            skippedCount++;
            // Don't add to processedKeys - allow re-evaluation if filters change
            continue;
        }

        relevantCount++;
        const filename = writeToIngest(payload, issueKey);
        processedKeys.add(issueKey);
        ingestedCount++;

        console.log(`      ✅ Ingested: ${issueKey} "${payload.summary}" → ${filename}`);
    }

    // Update sync state
    syncState.processedIssueKeys = Array.from(processedKeys);
    syncState.lastSyncTime = new Date().toISOString();
    syncState.lastRunTimestamp = new Date().toISOString();
    saveSyncState(syncState);

    console.log(`\n   Summary: ${rows.length} rows, ${relevantCount} relevant, ${ingestedCount} ingested, ${skippedCount} skipped`);

    return {
        sourceFile: filePath,
        totalRows: rows.length,
        relevant: relevantCount,
        ingested: ingestedCount,
        skipped: skippedCount,
    };
}

// ── Standalone execution ─────────────────────────────────────────

if (require.main === module) {
    // Check for --csv flag to run CSV ingestion instead of API
    const args = process.argv.slice(2);
    const csvMode = args.includes('--csv');
    const csvPathIdx = args.findIndex(a => a === '--csv-path');
    const csvPath = csvPathIdx >= 0 ? args[csvPathIdx + 1] : undefined;

    if (csvMode) {
        runJiraCsvIngestion(csvPath)
            .then(result => {
                console.log('\n📊 [JIRA CSV INLET] Cycle complete:', result);
            })
            .catch(err => {
                console.error('\n❌ [JIRA CSV INLET] Unhandled error:', err);
                process.exit(1);
            });
    } else {
        runJiraIngestion()
            .then(result => {
                console.log('\n📋 [JIRA INLET] Cycle complete:', result);
            })
            .catch(err => {
                console.error('\n❌ [JIRA INLET] Unhandled error:', err);
                process.exit(1);
            });
    }
}
