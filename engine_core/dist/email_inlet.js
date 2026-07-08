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
Object.defineProperty(exports, "__esModule", { value: true });
exports.runEmailIngestion = runEmailIngestion;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const INGEST_PATH = path.resolve(__dirname, '../../data/ingest');
const SYNC_STATE_PATH = path.resolve(__dirname, '../../data/state/email_sync.json');
const CONFIG_PATH = path.resolve(__dirname, './email_config.json');
// ── Configuration loader ─────────────────────────────────────────
function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error(`Email config not found at ${CONFIG_PATH}. Copy email_config.json and populate credentials.`);
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
function loadSyncState() {
    if (fs.existsSync(SYNC_STATE_PATH)) {
        return JSON.parse(fs.readFileSync(SYNC_STATE_PATH, 'utf8'));
    }
    return {
        lastSyncTime: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        processedMessageIds: [],
        lastRunTimestamp: new Date().toISOString(),
    };
}
function saveSyncState(state) {
    const dir = path.dirname(SYNC_STATE_PATH);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    // Keep only last 1000 processed IDs to prevent unbounded growth
    state.processedMessageIds = state.processedMessageIds.slice(-1000);
    fs.writeFileSync(SYNC_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}
// ── MSAL OAuth2 client credentials flow ──────────────────────────
const MSAL_TOKEN_ENDPOINT = 'https://login.microsoftonline.com';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
async function acquireAccessToken(config) {
    const { tenant_id, client_id, client_secret } = config.m365;
    if (!tenant_id || !client_id || !client_secret) {
        throw new Error('M365 credentials not configured. Set tenant_id, client_id, and client_secret in email_config.json.');
    }
    const tokenUrl = `${MSAL_TOKEN_ENDPOINT}/${tenant_id}/oauth2/v2.0/token`;
    const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id,
        client_secret,
        scope: GRAPH_SCOPE,
    });
    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
    });
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`M365 token request failed (${response.status}): ${errorBody}`);
    }
    const tokenData = (await response.json());
    return tokenData.access_token;
}
// ── M365 Graph API client ────────────────────────────────────────
async function fetchMessages(accessToken, config, syncState) {
    const { max_messages_per_cycle, age_limit_hours } = config.polling;
    const receivedAfter = new Date(Date.now() - age_limit_hours * 60 * 60 * 1000).toISOString();
    const lastSync = syncState.lastSyncTime;
    const filterDate = lastSync > receivedAfter ? lastSync : receivedAfter;
    const url = new URL('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages');
    url.searchParams.set('$filter', `receivedDateTime ge ${filterDate}`);
    url.searchParams.set('$orderby', 'receivedDateTime desc');
    url.searchParams.set('$top', String(max_messages_per_cycle));
    url.searchParams.set('$select', 'id,subject,from,receivedDateTime,bodyPreview,body,internetMessageId,importance');
    const response = await fetch(url.toString(), {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
    });
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`M365 Graph API request failed (${response.status}): ${errorBody}`);
    }
    const data = await response.json();
    return (data.value ?? []);
}
// ── Relevance filtering ──────────────────────────────────────────
function isRelevant(message, config) {
    const { subject_keywords, sender_allowlist, sender_blocklist } = config.filters;
    const senderEmail = message.from?.emailAddress?.address ?? '';
    const subject = (message.subject ?? '').toLowerCase();
    const bodyPreview = (message.bodyPreview ?? '').toLowerCase();
    // Blocklist check
    if (sender_blocklist.some(pattern => senderEmail.toLowerCase().includes(pattern.toLowerCase()))) {
        return false;
    }
    // Allowlist (if set, only these senders pass)
    if (sender_allowlist.length > 0) {
        const allowed = sender_allowlist.some(allowed => senderEmail.toLowerCase().includes(allowed.toLowerCase()));
        if (!allowed)
            return false;
    }
    // Keyword match against subject and body preview
    const hasKeyword = subject_keywords.some(kw => subject.includes(kw.toLowerCase()) || bodyPreview.includes(kw.toLowerCase()));
    return hasKeyword;
}
function messageToIngestPayload(message) {
    const action = inferActionFromEmail(message);
    return {
        task_id: `EMAIL-${message.id.substring(0, 12)}`,
        origin: 'M365_EMAIL_INLET',
        sender: message.from?.emailAddress?.address ?? 'unknown',
        sender_name: message.from?.emailAddress?.name ?? 'unknown',
        requested_action: action,
        subject: message.subject,
        body_preview: message.bodyPreview,
        parameters: {
            received_at: message.receivedDateTime,
            importance: message.importance,
            message_id: message.id,
            internet_message_id: message.internetMessageId,
        },
        timestamp: new Date().toISOString(),
    };
}
/** Infer a requested action from email subject/body keywords. */
function inferActionFromEmail(message) {
    const text = `${message.subject} ${message.bodyPreview}`.toUpperCase();
    if (text.includes('BUDGET') && (text.includes('APPROVE') || text.includes('RECONCILIATION'))) {
        return 'EXECUTE_BUDGET_RECONCILIATION';
    }
    if (text.includes('APPROVE') || text.includes('APPROVAL')) {
        return 'REQUEST_APPROVAL';
    }
    if (text.includes('ALLOCATION') || text.includes('REALLOCATE')) {
        return 'REQUEST_ALLOCATION_CHANGE';
    }
    if (text.includes('FORECAST') || text.includes('PROJECTION')) {
        return 'UPDATE_FORECAST';
    }
    if (text.includes('MILESTONE') || text.includes('DELIVERABLE')) {
        return 'LOG_MILESTONE_UPDATE';
    }
    if (text.includes('VARIANCE') || text.includes('DISCREPANCY')) {
        return 'FLAG_VARIANCE';
    }
    return 'PROCESS_PROJECT_EMAIL';
}
// ── Write to ingest directory ────────────────────────────────────
function writeToIngest(payload, messageId) {
    if (!fs.existsSync(INGEST_PATH))
        fs.mkdirSync(INGEST_PATH, { recursive: true });
    const filename = `email_${messageId.substring(0, 16)}_${Date.now()}.json`;
    const filePath = path.join(INGEST_PATH, filename);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return filename;
}
// ── Main email ingestion cycle ───────────────────────────────────
async function runEmailIngestion() {
    const config = loadConfig();
    const syncState = loadSyncState();
    console.log('\n📧 [EMAIL INLET] Starting M365 email ingestion cycle...');
    console.log(`   Last sync: ${syncState.lastSyncTime}`);
    console.log(`   Processed IDs in ledger: ${syncState.processedMessageIds.length}`);
    // Step 1: Acquire access token
    let accessToken;
    try {
        accessToken = await acquireAccessToken(config);
    }
    catch (err) {
        console.error(`❌ [EMAIL INLET] Authentication failed: ${err.message}`);
        return { fetched: 0, relevant: 0, ingested: 0, skipped: 0 };
    }
    // Step 2: Fetch messages from inbox
    let messages;
    try {
        messages = await fetchMessages(accessToken, config, syncState);
    }
    catch (err) {
        console.error(`❌ [EMAIL INLET] Failed to fetch messages: ${err.message}`);
        return { fetched: 0, relevant: 0, ingested: 0, skipped: 0 };
    }
    console.log(`   Fetched ${messages.length} message(s) from M365 inbox`);
    // Step 3: Filter and ingest
    let relevantCount = 0;
    let ingestedCount = 0;
    let skippedCount = 0;
    const newProcessedIds = new Set(syncState.processedMessageIds);
    for (const msg of messages) {
        // Dedup by message ID
        if (newProcessedIds.has(msg.id)) {
            skippedCount++;
            continue;
        }
        // Relevance filter
        if (!isRelevant(msg, config)) {
            skippedCount++;
            newProcessedIds.add(msg.id);
            continue;
        }
        relevantCount++;
        const payload = messageToIngestPayload(msg);
        const filename = writeToIngest(payload, msg.id);
        newProcessedIds.add(msg.id);
        ingestedCount++;
        console.log(`   ✅ Ingested: "${msg.subject}" → ${filename}`);
    }
    // Step 4: Update sync state
    syncState.lastSyncTime = new Date().toISOString();
    syncState.processedMessageIds = Array.from(newProcessedIds);
    syncState.lastRunTimestamp = new Date().toISOString();
    saveSyncState(syncState);
    console.log(`   Summary: ${relevantCount} relevant, ${ingestedCount} ingested, ${skippedCount} skipped`);
    return {
        fetched: messages.length,
        relevant: relevantCount,
        ingested: ingestedCount,
        skipped: skippedCount,
    };
}
// ── Standalone execution ─────────────────────────────────────────
if (require.main === module) {
    runEmailIngestion()
        .then(result => {
        console.log('\n📧 [EMAIL INLET] Cycle complete:', result);
    })
        .catch(err => {
        console.error('\n❌ [EMAIL INLET] Unhandled error:', err);
        process.exit(1);
    });
}
