// @Author Christian Relf
// @Date 2026-10-21

//! The management API client.
//!
//! Every request the interface makes goes through `admin_request`: the front
//! end names a method, a path under `/admin` and a body, and this attaches the
//! token for the selected server. The interface never holds the token and
//! cannot choose the host - the path is checked, and the base comes from the
//! stored profile. That is the same division Kern itself uses for its session
//! token, and for the same reason: the window's CSP doesn't apply to requests
//! made here in Rust, so an address the front end could set would be a way to
//! hand the token to somebody else's server.

use crate::error::{AppError, AppResult};
use crate::servers;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub status: u16,
    pub body: Value,
}

fn agent(timeout: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout)))
        .http_status_as_error(false)
        .user_agent(concat!("KernPlatform/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

/// Refuses a path that could leave the management API or the server.
fn check_path(path: &str) -> AppResult<()> {
    if !path.starts_with('/') || path.contains("..") || path.contains("://") || path.contains('\\') {
        return Err(AppError::Invalid(format!("{path} isn't a management API path.")));
    }
    Ok(())
}

/// Sends a request to `<selected server>/admin<path>`.
pub fn request(config_dir: &PathBuf, method: &str, path: &str, body: Option<&Value>) -> AppResult<Reply> {
    check_path(path)?;
    let server = servers::selected(config_dir)?.ok_or_else(|| AppError::Invalid("No server is selected yet. Add one first.".into()))?;
    let token = servers::token_of(&server.id).ok_or_else(|| {
        AppError::Auth(format!(
            "There's no management token for \"{}\". On the server, run `kernctl token new \"Kern Platform\"` (or `kernctl pair`) and paste what it prints.",
            server.name
        ))
    })?;
    send(&format!("{}/admin{}", server.url, path), &token, method, body, 60)
}

/// The same, for a server that hasn't been saved yet: used when testing a
/// token someone has just typed in.
pub fn request_with(url: &str, token: &str, method: &str, path: &str, body: Option<&Value>) -> AppResult<Reply> {
    check_path(path)?;
    let verdict = servers::vet(url)?;
    send(&format!("{}/admin{}", verdict.url, path), token, method, body, 20)
}

fn send(url: &str, token: &str, method: &str, body: Option<&Value>, timeout: u64) -> AppResult<Reply> {
    let agent = agent(timeout);
    let auth = format!("Bearer {token}");
    let response = match method {
        "GET" => agent.get(url).header("Authorization", &auth).header("Accept", "application/json").call(),
        // No body on DELETE: the destructive routes take their confirmation
        // in the query string, because a DELETE body is a lottery across HTTP
        // clients - ureq won't send one at all.
        "DELETE" => agent.delete(url).header("Authorization", &auth).header("Accept", "application/json").call(),
        "POST" | "PATCH" | "PUT" => {
            let payload = body.map(|b| b.to_string()).unwrap_or_else(|| "{}".into());
            let builder = match method {
                "POST" => agent.post(url),
                "PATCH" => agent.patch(url),
                _ => agent.put(url),
            };
            builder
                .header("Authorization", &auth)
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .send(payload)
        }
        other => return Err(AppError::Invalid(format!("{other} isn't a request Kern Platform makes."))),
    };

    let mut response = response.map_err(|e| unreachable_message(url, &e.to_string()))?;
    let status = response.status().as_u16();
    let text = response.body_mut().with_config().limit(16 * 1024 * 1024).read_to_string().unwrap_or_default();
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    Ok(Reply { status, body })
}

fn unreachable_message(url: &str, detail: &str) -> AppError {
    let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_else(|| "the server".into());
    AppError::Network(format!(
        "Couldn't reach {host}.\n\nIf it's on another machine, its management API answers only its own loopback by default - forward the port first:\n  ssh -L 8787:127.0.0.1:8787 you@{host}\n\n({detail})"
    ))
}

/// Turns a refusal into something the interface can show as it is.
pub fn check(reply: Reply) -> AppResult<Value> {
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
        401 => AppError::Auth(message),
        403 if code == "admin_local_only" => AppError::Refused(message),
        403 => AppError::Refused(message),
        404 => AppError::NotFound(message.trim_end_matches(" wasn't found.").to_string()),
        s if s >= 500 => AppError::Network(format!("The server had trouble with that ({s}). {message}")),
        _ => AppError::Invalid(message),
    })
}

/// `GET /instance` - no token needed, so it works before one is pasted in.
pub fn probe_instance(url: &str) -> AppResult<Value> {
    let verdict = servers::vet(url)?;
    let agent = agent(15);
    let mut response = agent
        .get(&format!("{}/instance", verdict.url))
        .header("Accept", "application/json")
        .call()
        .map_err(|e| unreachable_message(&verdict.url, &e.to_string()))?;
    let status = response.status().as_u16();
    let text = response.body_mut().with_config().limit(256 * 1024).read_to_string().unwrap_or_default();
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status == 404 {
        return Err(AppError::Invalid(format!(
            "{} answered, but it isn't a Kern server - there's no /instance there. Check the address.",
            verdict.url
        )));
    }
    if status >= 400 {
        return Err(AppError::Invalid(format!("{} answered {status}.", verdict.url)));
    }
    if body.get("service").and_then(|s| s.as_str()) != Some("kern-cloud") {
        return Err(AppError::Invalid(format!("{} answered, but it isn't a Kern server.", verdict.url)));
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn paths_stay_inside_the_management_api() {
        assert!(check_path("/overview").is_ok());
        assert!(check_path("/users/abc/hold").is_ok());
        assert!(check_path("overview").is_err());
        assert!(check_path("/../auth/sign-in/email").is_err());
        assert!(check_path("https://evil.example/x").is_err());
    }

    #[test]
    fn refusals_keep_the_servers_own_wording() {
        let err = check(Reply { status: 403, body: json!({"code": "admin_read_only", "message": "That management token is read-only."}) }).unwrap_err();
        assert_eq!(err.code(), "refused");
        assert_eq!(err.to_string(), "That management token is read-only.");
    }

    #[test]
    fn a_missing_token_reads_as_an_auth_problem() {
        let err = check(Reply { status: 401, body: json!({"message": "That management token isn't valid."}) }).unwrap_err();
        assert_eq!(err.code(), "auth");
    }

    #[test]
    fn a_body_that_isnt_json_still_produces_a_usable_error() {
        let err = check(Reply { status: 502, body: Value::Null }).unwrap_err();
        assert_eq!(err.code(), "network");
        assert!(err.to_string().contains("502"));
    }
}
