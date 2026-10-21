// @Author Christian Relf
// @Date 2026-10-21

//! Kern Platform: the back end.
//!
//! It is deliberately small. There is no database and no cache: the server is
//! the source of truth and the interface asks it for what it needs. All this
//! does is hold the list of servers, keep their management tokens out of the
//! webview, and make the requests.
//!
//! Commands, in the order the interface meets them:
//!
//! | Command | For |
//! |---------|-----|
//! | `servers_list`, `server_select`, `server_rename`, `server_remove` | the sidebar's server picker |
//! | `server_probe` | checking an address before saving it |
//! | `server_add`, `server_pair` | adding one, by hand or from `kernctl pair` |
//! | `server_set_token`, `server_has_token` | the token, after a rotation |
//! | `admin_get`, `admin_send` | everything else: one call per management endpoint |

mod admin;
mod error;
mod servers;

use error::{AppError, AppResult};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Where servers.json lives. Per-user, created on demand.
fn config_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_config_dir()
        .map_err(|e| AppError::Io(format!("Couldn't find somewhere to keep the server list: {e}")))
}

// ------------------------------------------------------------------- servers

#[tauri::command]
fn servers_list(app: AppHandle) -> AppResult<Vec<servers::ServerView>> {
    servers::list(&config_dir(&app)?)
}

/// Looks at an address without saving anything, so the "add a server" dialog
/// can say what is there before asking for a token.
#[tauri::command]
async fn server_probe(url: String) -> AppResult<Value> {
    tauri::async_runtime::spawn_blocking(move || admin::probe_instance(&url))
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
}

#[tauri::command]
async fn server_add(app: AppHandle, name: String, url: String, token: Option<String>) -> AppResult<servers::Server> {
    let dir = config_dir(&app)?;
    let server = servers::add(&dir, &name, &url, token.as_deref())?;
    // If we were given a token, make sure it actually works, and take the
    // instance's own name while we're there.
    if token.is_some() {
        let id = server.id.clone();
        let url = server.url.clone();
        let tok = servers::token_of(&id).unwrap_or_default();
        let ping = tauri::async_runtime::spawn_blocking(move || admin::request_with(&url, &tok, "GET", "/ping", None))
            .await
            .map_err(|e| AppError::Io(e.to_string()))?;
        match ping.map(admin::check) {
            Ok(Ok(body)) => {
                let instance = body.get("instance").and_then(|v| v.as_str()).map(String::from);
                let version = body.get("version").and_then(|v| v.as_str()).map(String::from);
                servers::note_connection(&dir, &server.id, instance, version)?;
            }
            Ok(Err(e)) | Err(e) => {
                // Keep the profile - the address was fine and the person can
                // fix the token - but say what happened.
                return Err(e);
            }
        }
    }
    Ok(server)
}

/// Adds a server from the one line `kernctl pair` prints.
#[tauri::command]
async fn server_pair(app: AppHandle, line: String) -> AppResult<servers::Server> {
    let pairing = servers::decode_pairing(&line)?;
    let name = pairing.name.clone().unwrap_or_default();
    server_add(app, name, pairing.url, Some(pairing.token)).await
}

#[tauri::command]
fn server_select(app: AppHandle, id: String) -> AppResult<servers::Server> {
    servers::select(&config_dir(&app)?, &id)
}

#[tauri::command]
fn server_rename(app: AppHandle, id: String, name: String) -> AppResult<servers::Server> {
    servers::rename(&config_dir(&app)?, &id, &name)
}

#[tauri::command]
fn server_remove(app: AppHandle, id: String) -> AppResult<()> {
    servers::remove(&config_dir(&app)?, &id)
}

#[tauri::command]
fn server_set_token(app: AppHandle, id: String, token: String) -> AppResult<()> {
    // Prove the profile exists before writing to the credential store.
    let dir = config_dir(&app)?;
    servers::list(&dir)?
        .iter()
        .find(|s| s.server.id == id)
        .ok_or_else(|| AppError::NotFound("That server".into()))?;
    servers::set_token(&id, &token)
}

#[tauri::command]
fn server_has_token(id: String) -> bool {
    servers::token_of(&id).is_some()
}

// ---------------------------------------------------------------- management

/// A read. `path` is relative to the selected server's `/admin`.
#[tauri::command]
async fn admin_get(app: AppHandle, path: String) -> AppResult<Value> {
    let dir = config_dir(&app)?;
    let reply = tauri::async_runtime::spawn_blocking(move || admin::request(&dir, "GET", &path, None))
        .await
        .map_err(|e| AppError::Io(e.to_string()))??;
    admin::check(reply)
}

/// Anything that changes something.
#[tauri::command]
async fn admin_send(app: AppHandle, method: String, path: String, body: Option<Value>) -> AppResult<Value> {
    let dir = config_dir(&app)?;
    let method = method.to_ascii_uppercase();
    let reply = tauri::async_runtime::spawn_blocking(move || admin::request(&dir, &method, &path, body.as_ref()))
        .await
        .map_err(|e| AppError::Io(e.to_string()))??;
    admin::check(reply)
}

/// Notes what the server just told us about itself, so the picker reads
/// properly next time even before a request is made.
#[tauri::command]
fn server_note(app: AppHandle, id: String, instance_name: Option<String>, version: Option<String>) -> AppResult<()> {
    servers::note_connection(&config_dir(&app)?, &id, instance_name, version)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // servers
            servers_list,
            server_probe,
            server_add,
            server_pair,
            server_select,
            server_rename,
            server_remove,
            server_set_token,
            server_has_token,
            server_note,
            // management
            admin_get,
            admin_send,
        ])
        .run(tauri::generate_context!())
        .expect("Kern Platform couldn't start");
}
