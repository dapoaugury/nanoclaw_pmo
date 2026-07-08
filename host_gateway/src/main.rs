use notify::{Watcher, RecursiveMode, Result, Event};
use std::collections::HashSet;
use std::io::{self, Write};
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::fs;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct ActionToken {
    timestamp: String,
    agent_id: String,
    status_assessment: String,
    proposed_modifications: Vec<Modification>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Modification {
    target_service: String,
    action: String,
    parameters: serde_json::Value,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Resolve outbox path relative to the Cargo manifest directory, not CWD
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let workspace_root = Path::new(manifest_dir).parent().unwrap_or(Path::new("."));
    let native_outbox_target = workspace_root.join("data/outbox");

    if !native_outbox_target.exists() {
        fs::create_dir_all(&native_outbox_target)
            .expect("CRITICAL: Failed to construct filesystem architecture dirs");
    }

    println!("⚡ NanoClaw Native Watcher Enforcement Gateway Active!");
    println!("Watching local system directory tree: {}", native_outbox_target.display());

    // Shared dedup ledger — prevents re-processing the same file across cycles
    let processed_files: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

    let (tx, mut rx) = tokio::sync::mpsc::channel(100);

    let ledger_clone = Arc::clone(&processed_files);
    let mut filesystem_watcher = notify::recommended_watcher(move |res: Result<Event>| {
        if let Ok(event) = res {
            if event.kind.is_create() || event.kind.is_modify() {
                for path in event.paths {
                    if path.extension().map_or(false, |ext| ext == "json") {
                        // Dedup: skip files already handled
                        if let Some(filename) = path.file_name().map(|n| n.to_string_lossy().into_owned()) {
                            let mut ledger = ledger_clone.lock().unwrap();
                            if ledger.contains(&filename) {
                                return;
                            }
                            ledger.insert(filename);
                        }

                        if let Err(e) = tx.blocking_send(path) {
                            eprintln!("⚠️ Channel send failed — event dropped: {}", e);
                        }
                    }
                }
            }
        }
    })?;

    filesystem_watcher.watch(&native_outbox_target, RecursiveMode::NonRecursive)?;

    while let Some(intercepted_json_path) = rx.recv().await {
        if !intercepted_json_path.exists() {
            continue;
        }

        println!("\n🔍 [INTERCEPTED] New action token detected: {}", intercepted_json_path.display());

        match fs::read_to_string(&intercepted_json_path) {
            Ok(content) => {
                match serde_json::from_str::<ActionToken>(&content) {
                    Ok(parsed_token) => {
                        let verdict = render_native_hitl_terminal(parsed_token);
                        match verdict {
                            HitlVerdict::Approved => {
                                println!("✅ [APPROVED] Token authorized. Relaying to downstream systems.");
                                // TODO: wire to actual SIEM/audit dispatch
                            }
                            HitlVerdict::Rejected => {
                                println!("❌ [REJECTED] Token blocked. No downstream action taken.");
                            }
                        }
                    }
                    Err(err) => {
                        eprintln!("❌ Malformed token JSON: {}", err);
                    }
                }
            }
            Err(err) => {
                eprintln!("❌ Failed to read token file: {}", err);
            }
        }

        // Always purge the token after processing (approved or rejected)
        if let Err(e) = fs::remove_file(&intercepted_json_path) {
            eprintln!("⚠️ Failed to purge processed token: {}", e);
        }
    }

    Ok(())
}

enum HitlVerdict {
    Approved,
    Rejected,
}

fn render_native_hitl_terminal(token: ActionToken) -> HitlVerdict {
    println!("\n================== NATIVE HITL INTERCEPTION VIEWPORT ==================");
    println!("Originating Native Agent ID : {}", token.agent_id);
    println!("Telemetry Summary Assessment: {}", token.status_assessment);
    println!("System Sequence Timestamp   : {}", token.timestamp);
    println!("-----------------------------------------------------------------------");
    println!("Intercepted Local Action Directives:");

    for (idx, modification) in token.proposed_modifications.iter().enumerate() {
        println!("  [{}] Target Domain Layer: {}", idx + 1, modification.target_service);
        println!("      Action Token Schema : {}", modification.action);
        println!("      Configuration Params: {}", serde_json::to_string_pretty(&modification.parameters).unwrap_or_else(|_| modification.parameters.to_string()));
    }

    println!("=======================================================================");
    println!("👉 STATUS: LOCAL PIPELINE MODIFICATION LOCKED & FROZEN.");
    println!("👉 Authorize execution of this action to downstream enterprise systems?");
    print!("👉 Enter y/n (or yes/no) and press Enter: ");
    io::stdout().flush().expect("Failed to flush stdout for HITL prompt");

    let mut input = String::new();
    io::stdin()
        .read_line(&mut input)
        .expect("Failed to read operator input");

    let verdict = input.trim().to_lowercase();

    if verdict == "y" || verdict == "yes" {
        HitlVerdict::Approved
    } else {
        HitlVerdict::Rejected
    }
}
