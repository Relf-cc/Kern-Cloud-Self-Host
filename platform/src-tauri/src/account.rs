// @Author Christian Relf
// @Date 2026-10-21

//! Signing in to a server as yourself, instead of with a management token.
//!
//! There are two ways to manage a server from here, and they are deliberately
//! not equal:
//!
//! | | Reaches | Needs |
//! |---|---|---|
//! | **A management token** | `/admin/*` — everything | loopback or an SSH tunnel |
//! | **Your own account** | `/owner/*` — workspace keys, nothing else | an account listed in `ADMIN_EMAILS` |
//!
//! The first is the full management API and answers only the server's own
//! machine, which is why it needs a tunnel. The second is an ordinary signed-in
//! session, so it works over the internet like the rest of the app's API — and
//! because it does, the server keeps it to the one job that has to be done from
//! wherever you happen to be: handing out workspace keys. A password reaching
//! the SQL console is not a trade anybody should be offered, so the surface is
//! small by construction rather than by permission.
//!
//! Sessions live in the operating system's credential store beside management
//! tokens, under the profile's id with `#account` appended, and are read here
//! in Rust. The webview never sees one.

use crate::admin::{agent, unreachable_message, Reply};
use crate::error::{AppError, AppResult};
use crate::servers;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;

/// The credential-store key for a profile's account session.
pub fn session_key(id: &str) -> String {
    format!("{id}#account")
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    pub email: String,
    pub name: Option<String>,
    /// The instance's own name, as it calls itself.
    pub instance: String,
    /// Whether creating a workspace on it currently takes a key.
    pub workspace_keys: String,
}

/// Refuses a path that could leave the owner API or the server.
fn check_path(path: &str) -> AppResult<()> {
    if !path.starts_with('/') || path.contains("..") || path.contains("://") || path.contains('\\') {
        return Err(AppError::Invalid(format!("{path} isn't an owner API path.")));
    }
    Ok(())
}

/// Sends one request, returning the reply and any `set-auth-token` header.
/// Better Auth hands a new session back in that header rather than the body.
fn send(url: &str, token: Option<&str>, method: &str, body: Option<&Value>, timeout: u64) -> AppResult<(Reply, Option<String>)> {
    let agent = agent(timeout);
    // ureq's builder changes type once a body is allowed, so a request with a
    // body and one without can't share a closure. Two small arms instead.
    let auth = token.map(|t| format!("Bearer {t}"));
    let response = match method {
        "GET" | "DELETE" => {
            let mut r = if method == "GET" { agent.get(url) } else { agent.delete(url) };
            if let Some(a) = &auth {
                r = r.header("Authorization", a);
            }
            r.header("Accept", "application/json").call()
        }
        "POST" | "PATCH" => {
            let payload = body.map(|b| b.to_string()).unwrap_or_else(|| "{}".into());
            let mut r = if method == "POST" { agent.post(url) } else { agent.patch(url) };
            if let Some(a) = &auth {
                r = r.header("Authorization", a);
            }
            r.header("Accept", "application/json").header("Content-Type", "application/json").send(payload)
        }
        other => return Err(AppError::Invalid(format!("{other} isn't a request Kern Platform makes."))),
    };
    let mut response = response.map_err(|e| unreachable_message(url, &e.to_string()))?;
    let status = response.status().as_u16();
    let issued = response.headers().get("set-auth-token").and_then(|v| v.to_str().ok()).map(String::from);
    let text = response.body_mut().with_config().limit(8 * 1024 * 1024).read_to_string().unwrap_or_default();
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    Ok((Reply { status, body }, issued))
}

/// Turns a refusal into something worth reading. The two that matter here are
/// a wrong password and an account the server doesn't recognise as managing it.
fn check(reply: Reply) -> AppResult<Value> {
    if reply.status < 400 {
        return Ok(reply.body);
    }
    let code = reply.body.get("code").and_then(|c| c.as_str()).unwrap_or_default().to_string();
    let message = reply
        .body
        .get("message")
        .and_then(|m| m.as_str())
        .filter(|m| !m.is_empty())
        .map(String::from)
        .unwrap_or_else(|| format!("The server answered {}.", reply.status));
    Err(match reply.status {
        401 if code == "INVALID_EMAIL_OR_PASSWORD" => AppError::Invalid("That email and password don't match an account on this server.".into()),
        401 => AppError::Auth(message),
        403 if code == "not_owner" => AppError::Refused(
            "That account doesn't manage this server.\n\nWhoever runs it adds an account to ADMIN_EMAILS in the server's .env, then restarts it.".into(),
        ),
        403 => AppError::Refused(message),
        404 => AppError::NotFound(message.trim_end_matches(" wasn't found.").to_string()),
        s if s >= 500 => AppError::Network(format!("The server had trouble with that ({s}). {message}")),
        _ => AppError::Invalid(message),
    })
}

/// Reads `/owner/me` with a session, which is both the ownership check and
/// where the instance's name comes from.
fn whoami(base: &str, token: &str) -> AppResult<Owner> {
    let (reply, _) = send(&format!("{base}/owner/me"), Some(token), "GET", None, 20)?;
    let body = check(reply)?;
    Ok(Owner {
        email: body.get("email").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        name: None,
        instance: body.get("instance").and_then(|v| v.as_str()).unwrap_or("Kern").to_string(),
        workspace_keys: body.get("workspaceKeys").and_then(|v| v.as_str()).unwrap_or("off").to_string(),
    })
}

/// Signs in to `raw_url` and, if the account manages it, saves the session
/// against a profile for that address (creating one if it is new).
///
/// The ownership check happens before anything is stored. An account that
/// cannot manage the server leaves no profile and no session behind, so a
/// mistyped address or the wrong account doesn't silently add clutter.
pub fn sign_in(config_dir: &PathBuf, raw_url: &str, email: &str, password: &str) -> AppResult<(servers::Server, Owner)> {
    let verdict = servers::vet(raw_url)?;
    let base = verdict.url.clone();
    let (reply, issued) = send(
        &format!("{base}/auth/sign-in/email"),
        None,
        "POST",
        Some(&json!({ "email": email.trim(), "password": password, "rememberMe": true })),
        30,
    )?;
    let body = check(reply)?;
    let token = issued
        .or_else(|| body.get("token").and_then(|t| t.as_str()).map(String::from))
        .ok_or_else(|| AppError::Auth("The server didn't return a session.".into()))?;

    let mut owner = whoami(&base, &token)?;
    if owner.email.is_empty() {
        owner.email = email.trim().to_string();
    }
    owner.name = body.get("user").and_then(|u| u.get("name")).and_then(|n| n.as_str()).map(String::from);

    // Reuse the profile for this address if there is one, so signing in twice
    // doesn't leave two entries for the same server.
    let existing = servers::list(config_dir)?.into_iter().find(|v| v.server.url == base).map(|v| v.server);
    let server = match existing {
        Some(s) => s,
        None => servers::add(config_dir, &owner.instance, &base, None)?,
    };
    servers::set_secret(&session_key(&server.id), &token)?;
    servers::select(config_dir, &server.id)?;
    servers::note_connection(config_dir, &server.id, Some(owner.instance.clone()), None)?;
    Ok((server, owner))
}

/// The session for a profile, if one has been saved.
pub fn session_of(id: &str) -> Option<String> {
    servers::token_of(&session_key(id))
}

pub fn sign_out(id: &str) -> AppResult<()> {
    servers::forget_token(&session_key(id))
}

/// Who the saved session belongs to, asked of the server. Also the way the
/// interface finds out that a session has expired.
pub fn me(config_dir: &PathBuf) -> AppResult<Owner> {
    let server = servers::selected(config_dir)?.ok_or_else(|| AppError::Invalid("No server is selected yet.".into()))?;
    let token = session_of(&server.id).ok_or_else(|| AppError::Auth("Not signed in to this server.".into()))?;
    whoami(&server.url, &token)
}

/// Sends a request to `<selected server>/owner<path>` with the saved session.
pub fn request(config_dir: &PathBuf, method: &str, path: &str, body: Option<&Value>) -> AppResult<Value> {
    check_path(path)?;
    let server = servers::selected(config_dir)?.ok_or_else(|| AppError::Invalid("No server is selected yet.".into()))?;
    let token = session_of(&server.id).ok_or_else(|| {
        AppError::Auth(format!("You're not signed in to \"{}\". Sign in again to manage its keys.", server.name))
    })?;
    let (reply, _) = send(&format!("{}/owner{}", server.url, path), Some(&token), method, body, 60)?;
    check(reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn paths_stay_inside_the_owner_api() {
        assert!(check_path("/workspace-keys").is_ok());
        assert!(check_path("/workspace-keys/a1b2c3d4").is_ok());
        assert!(check_path("workspace-keys").is_err());
        assert!(check_path("/../admin/overview").is_err());
        assert!(check_path("https://evil.example/x").is_err());
        assert!(check_path("/keys\\..\\admin").is_err());
    }

    #[test]
    fn the_session_key_is_distinct_from_the_management_token() {
        assert_eq!(session_key("abc"), "abc#account");
        assert_ne!(session_key("abc"), "abc");
    }

    #[test]
    fn a_wrong_password_says_so_rather_than_leaking_which_half_was_wrong() {
        let err = check(Reply { status: 401, body: json!({"code": "INVALID_EMAIL_OR_PASSWORD"}) }).unwrap_err();
        assert_eq!(err.code(), "invalid");
        assert!(err.to_string().contains("don't match an account"));
    }

    #[test]
    fn an_account_that_doesnt_manage_the_server_is_told_how_that_is_granted() {
        let err = check(Reply { status: 403, body: json!({"code": "not_owner", "message": "That account doesn't manage this server."}) }).unwrap_err();
        assert_eq!(err.code(), "refused");
        assert!(err.to_string().contains("ADMIN_EMAILS"));
    }

    #[test]
    fn other_refusals_keep_the_servers_own_wording() {
        let err = check(Reply { status: 403, body: json!({"message": "Nope."}) }).unwrap_err();
        assert_eq!(err.to_string(), "Nope.");
    }
}
