// @Author Christian Relf
// @Date 2026-10-21

//! The servers this copy of Kern Platform manages, and the rule about which
//! addresses it will send a management token to.
//!
//! A profile is a name, an address and an id. The **token is not in it**: it
//! lives in the operating system's credential store under the profile's id,
//! is read here in Rust when a request is made, and never reaches the webview.
//! So a profile file that leaks, or a bug in the interface, gives up the list
//! of servers somebody manages - not the keys to them.
//!
//! ## Where a token may be sent
//!
//! A management token is the whole instance. Sending one over cleartext to an
//! address anybody could be between is not a trade-off worth offering, so the
//! rule is enforced here rather than left to the person adding the server:
//!
//! | Address                           | Allowed | Why |
//! |-----------------------------------|---------|-----|
//! | `http://127.0.0.1`, `::1`         | yes     | same machine, or an SSH tunnel to it |
//! | `https://` anything               | yes     | encrypted, and the server's name is checked |
//! | `http://192.168.x`, `10.x`, `.local` | yes, with a warning | a home or office network |
//! | `http://` a public address        | **no**  | the token would cross the internet in the clear |
//!
//! The intended shape is the first row: Kern Platform runs on the server, or
//! forwards its port over SSH, which is why the server's management API is
//! loopback-only by default.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;
use url::{Host, Url};

/// The credential-store service name. One entry per profile id.
const KEYRING_SERVICE: &str = "kern-platform";

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    /// Our own id for this profile, and the credential-store key.
    pub id: String,
    /// What to call it in the sidebar. Defaults to the instance's own name.
    pub name: String,
    /// The API base, e.g. `http://127.0.0.1:8787/kern/v1`.
    pub url: String,
    /// Set once we've spoken to it, so the list reads properly offline.
    #[serde(default)]
    pub instance_name: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub last_connected_at: Option<i64>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    #[serde(flatten)]
    pub server: Server,
    /// Whether a token for it is in the credential store.
    pub has_token: bool,
    /// Set when the address is allowed but not encrypted.
    pub warning: Option<String>,
    pub selected: bool,
}

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct Store {
    #[serde(default)]
    servers: Vec<Server>,
    #[serde(default)]
    selected: Option<String>,
}

fn store_path(config_dir: &PathBuf) -> PathBuf {
    config_dir.join("servers.json")
}

fn read(config_dir: &PathBuf) -> AppResult<Store> {
    match fs::read_to_string(store_path(config_dir)) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| AppError::Io(format!("The server list is unreadable ({e}). Delete servers.json to start again."))),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(AppError::Io(format!("Couldn't read the server list: {e}"))),
    }
}

fn write(config_dir: &PathBuf, store: &Store) -> AppResult<()> {
    fs::create_dir_all(config_dir).map_err(|e| AppError::Io(format!("Couldn't make {}: {e}", config_dir.display())))?;
    let text = serde_json::to_string_pretty(store).map_err(|e| AppError::Io(e.to_string()))?;
    // Write beside and rename, so an interrupted save can't leave half a file.
    let tmp = store_path(config_dir).with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| AppError::Io(format!("Couldn't save the server list: {e}")))?;
    fs::rename(&tmp, store_path(config_dir)).map_err(|e| AppError::Io(format!("Couldn't save the server list: {e}")))?;
    Ok(())
}

// ------------------------------------------------------------------ addresses

/// What we decided about an address, and why.
pub struct Verdict {
    pub url: String,
    /// Shown next to the server when it is reachable but unencrypted.
    pub warning: Option<String>,
}

fn private_host(host: &Host<&str>) -> bool {
    match host {
        Host::Ipv4(ip) => ip.is_private() || ip.is_link_local(),
        Host::Ipv6(ip) => {
            let s = ip.segments();
            // fc00::/7 (unique local) and fe80::/10 (link local).
            (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80
        }
        Host::Domain(name) => {
            let n = name.to_ascii_lowercase();
            n == "localhost" || n.ends_with(".localhost") || n.ends_with(".local") || n.ends_with(".internal") || n.ends_with(".home.arpa")
        }
    }
}

fn loopback_host(host: &Host<&str>) -> bool {
    match host {
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => ip.is_loopback(),
        Host::Domain(name) => {
            let n = name.to_ascii_lowercase();
            n == "localhost" || n.ends_with(".localhost")
        }
    }
}

/// Normalises an address and applies the rule in the module docs.
pub fn vet(raw: &str) -> AppResult<Verdict> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Invalid("Give the server's address, for example http://127.0.0.1:8787".into()));
    }
    // "127.0.0.1:8787" on its own is what people type; assume http.
    let with_scheme = if trimmed.contains("://") { trimmed.to_string() } else { format!("http://{trimmed}") };
    let mut parsed = Url::parse(&with_scheme).map_err(|_| AppError::Invalid(format!("{trimmed} isn't an address Kern Platform can use.")))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(AppError::Invalid(format!("{other}:// isn't an address Kern Platform can use. Use http:// or https://."))),
    }
    parsed.set_query(None);
    parsed.set_fragment(None);

    let host = parsed.host().ok_or_else(|| AppError::Invalid(format!("{trimmed} has no host in it.")))?;
    let secure = parsed.scheme() == "https";
    let loopback = loopback_host(&host);
    let private = private_host(&host);

    if !secure && !loopback && !private {
        return Err(AppError::Invalid(format!(
            "Kern Platform won't send a management token to {} over plain HTTP - it would cross the network unencrypted, and that token is the whole server.\n\nEither put the server behind HTTPS, or forward its port and connect to 127.0.0.1:\n  ssh -L 8787:127.0.0.1:8787 you@{}",
            parsed.host_str().unwrap_or(trimmed),
            parsed.host_str().unwrap_or("server")
        )));
    }

    // Accept the origin or the full API base, and store the full base.
    let path = parsed.path().trim_end_matches('/').to_string();
    let url = if path.ends_with("/kern/v1") {
        format!("{}://{}{}", parsed.scheme(), authority(&parsed), path)
    } else if path.is_empty() {
        format!("{}://{}/kern/v1", parsed.scheme(), authority(&parsed))
    } else {
        format!("{}://{}{}/kern/v1", parsed.scheme(), authority(&parsed), path)
    };

    let warning = if secure || loopback {
        None
    } else {
        Some(format!(
            "{} is on a private network but not encrypted. Anyone on that network could read this server's management token.",
            parsed.host_str().unwrap_or_default()
        ))
    };
    Ok(Verdict { url, warning })
}

fn authority(u: &Url) -> String {
    match u.port() {
        Some(port) => format!("{}:{}", u.host_str().unwrap_or_default(), port),
        None => u.host_str().unwrap_or_default().to_string(),
    }
}

// -------------------------------------------------------------------- tokens

fn entry(id: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| AppError::Io(format!("The credential store wouldn't open: {e}")))
}

pub fn token_of(id: &str) -> Option<String> {
    entry(id).ok().and_then(|e| e.get_password().ok()).filter(|t| !t.trim().is_empty())
}

pub fn set_token(id: &str, token: &str) -> AppResult<()> {
    let token = token.trim();
    if !looks_like_token(token) {
        return Err(AppError::Invalid(
            "That doesn't look like a management token. They read kern_<16 characters>_<secret>, and `kernctl token new` on the server prints one.".into(),
        ));
    }
    entry(id)?
        .set_password(token)
        .map_err(|e| AppError::Io(format!("Couldn't save the token to the credential store: {e}")))
}

pub fn forget_token(id: &str) -> AppResult<()> {
    if let Ok(e) = entry(id) {
        // Already gone is the outcome we wanted.
        let _ = e.delete_credential();
    }
    Ok(())
}

/// The shape the server mints. Checked here so a typo is caught before a
/// request, and so nothing else gets written to the credential store.
pub fn looks_like_token(token: &str) -> bool {
    let rest = match token.strip_prefix("kern_") {
        Some(r) => r,
        None => return false,
    };
    let mut parts = rest.splitn(2, '_');
    let (id, secret) = match (parts.next(), parts.next()) {
        (Some(a), Some(b)) => (a, b),
        _ => return false,
    };
    id.len() == 16
        && id.chars().all(|c| c.is_ascii_hexdigit())
        && (32..=96).contains(&secret.len())
        && secret.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Decodes the one-line string `kernctl pair` prints.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub url: String,
    pub token: String,
    #[serde(default)]
    pub name: Option<String>,
}

pub fn decode_pairing(text: &str) -> AppResult<Pairing> {
    use base64::Engine;
    let body = text.trim().strip_prefix("kern-platform:").ok_or_else(|| {
        AppError::Invalid("That isn't a pairing line. Run `kernctl pair` on the server and paste the line beginning kern-platform:".into())
    })?;
    // `kernctl` strips the padding, so put it back before decoding.
    let padded = {
        let mut s = body.trim().to_string();
        while s.len() % 4 != 0 {
            s.push('=');
        }
        s
    };
    let bytes = base64::engine::general_purpose::URL_SAFE
        .decode(padded.as_bytes())
        .map_err(|_| AppError::Invalid("That pairing line is damaged. Copy the whole of it, including the kern-platform: at the start.".into()))?;
    serde_json::from_slice(&bytes).map_err(|_| AppError::Invalid("That pairing line isn't one Kern Platform understands.".into()))
}

// ------------------------------------------------------------------ profiles

pub fn list(config_dir: &PathBuf) -> AppResult<Vec<ServerView>> {
    let store = read(config_dir)?;
    Ok(store
        .servers
        .iter()
        .map(|s| ServerView {
            has_token: token_of(&s.id).is_some(),
            warning: vet(&s.url).ok().and_then(|v| v.warning),
            selected: store.selected.as_deref() == Some(s.id.as_str()),
            server: s.clone(),
        })
        .collect())
}

pub fn selected(config_dir: &PathBuf) -> AppResult<Option<Server>> {
    let store = read(config_dir)?;
    let id = match store.selected {
        Some(id) => id,
        None => return Ok(store.servers.first().cloned()),
    };
    Ok(store.servers.into_iter().find(|s| s.id == id))
}

fn new_id() -> String {
    // Enough to keep profiles apart in a credential store; not a secret.
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}", now)
}

pub fn add(config_dir: &PathBuf, name: &str, raw_url: &str, token: Option<&str>) -> AppResult<Server> {
    let verdict = vet(raw_url)?;
    let mut store = read(config_dir)?;
    if let Some(existing) = store.servers.iter().find(|s| s.url == verdict.url) {
        return Err(AppError::Invalid(format!("{} is already here, as \"{}\".", verdict.url, existing.name)));
    }
    let server = Server {
        id: new_id(),
        name: if name.trim().is_empty() { verdict.url.clone() } else { name.trim().to_string() },
        url: verdict.url,
        instance_name: None,
        version: None,
        last_connected_at: None,
    };
    if let Some(t) = token {
        set_token(&server.id, t)?;
    }
    store.selected = Some(server.id.clone());
    store.servers.push(server.clone());
    write(config_dir, &store)?;
    Ok(server)
}

pub fn select(config_dir: &PathBuf, id: &str) -> AppResult<Server> {
    let mut store = read(config_dir)?;
    let server = store.servers.iter().find(|s| s.id == id).cloned().ok_or_else(|| AppError::NotFound("That server".into()))?;
    store.selected = Some(id.to_string());
    write(config_dir, &store)?;
    Ok(server)
}

pub fn rename(config_dir: &PathBuf, id: &str, name: &str) -> AppResult<Server> {
    let mut store = read(config_dir)?;
    let server = store.servers.iter_mut().find(|s| s.id == id).ok_or_else(|| AppError::NotFound("That server".into()))?;
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Invalid("A server needs a name.".into()));
    }
    server.name = trimmed.chars().take(60).collect();
    let out = server.clone();
    write(config_dir, &store)?;
    Ok(out)
}

/// Records what the instance told us about itself, so the list reads properly
/// before the first request of the next session.
pub fn note_connection(config_dir: &PathBuf, id: &str, instance_name: Option<String>, version: Option<String>) -> AppResult<()> {
    let mut store = read(config_dir)?;
    if let Some(server) = store.servers.iter_mut().find(|s| s.id == id) {
        if instance_name.is_some() {
            server.instance_name = instance_name;
        }
        if version.is_some() {
            server.version = version;
        }
        server.last_connected_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis() as i64);
        write(config_dir, &store)?;
    }
    Ok(())
}

pub fn remove(config_dir: &PathBuf, id: &str) -> AppResult<()> {
    let mut store = read(config_dir)?;
    let before = store.servers.len();
    store.servers.retain(|s| s.id != id);
    if store.servers.len() == before {
        return Err(AppError::NotFound("That server".into()));
    }
    if store.selected.as_deref() == Some(id) {
        store.selected = store.servers.first().map(|s| s.id.clone());
    }
    // The token goes with the profile: leaving it in the credential store
    // would keep a key to a server the person thinks they have removed.
    forget_token(id)?;
    write(config_dir, &store)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_and_https_are_fine() {
        assert_eq!(vet("127.0.0.1:8787").unwrap().url, "http://127.0.0.1:8787/kern/v1");
        assert_eq!(vet("http://localhost:8787/kern/v1").unwrap().url, "http://localhost:8787/kern/v1");
        assert_eq!(vet("https://kern.example.com").unwrap().url, "https://kern.example.com/kern/v1");
        assert!(vet("http://[::1]:8787").unwrap().warning.is_none());
        assert!(vet("https://kern.example.com").unwrap().warning.is_none());
    }

    #[test]
    fn a_private_network_is_allowed_but_said_so() {
        let v = vet("http://192.168.1.20:8787").unwrap();
        assert_eq!(v.url, "http://192.168.1.20:8787/kern/v1");
        assert!(v.warning.is_some());
        assert!(vet("http://10.1.2.3:8787").unwrap().warning.is_some());
        assert!(vet("http://kern.home.arpa:8787").unwrap().warning.is_some());
    }

    #[test]
    fn a_token_never_goes_over_the_open_internet_in_the_clear() {
        // The point of the whole module.
        assert!(vet("http://kern.example.com").is_err());
        assert!(vet("http://93.184.216.34:8787").is_err());
        assert!(vet("ftp://kern.example.com").is_err());
        assert!(vet("   ").is_err());
    }

    #[test]
    fn a_path_in_front_of_the_api_is_kept() {
        // Behind a reverse proxy that mounts Kern under a prefix.
        assert_eq!(vet("https://example.com/kern-server").unwrap().url, "https://example.com/kern-server/kern/v1");
        // And an address that already names the API isn't doubled up.
        assert_eq!(vet("https://example.com/kern-server/kern/v1").unwrap().url, "https://example.com/kern-server/kern/v1");
    }

    #[test]
    fn only_real_tokens_reach_the_credential_store() {
        let good = format!("kern_0123456789abcdef_{}", "a".repeat(43));
        assert!(looks_like_token(&good));
        assert!(!looks_like_token("kern_0123456789abcdef_short"));
        assert!(!looks_like_token("kern_nothex0123456_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(!looks_like_token("some-other-secret"));
        assert!(!looks_like_token(""));
    }

    #[test]
    fn a_pairing_line_round_trips() {
        use base64::Engine;
        let json = r#"{"url":"http://127.0.0.1:8787/kern/v1","token":"kern_0123456789abcdef_aaa","name":"Acme"}"#;
        let encoded = base64::engine::general_purpose::URL_SAFE.encode(json).trim_end_matches('=').to_string();
        let p = decode_pairing(&format!("kern-platform:{encoded}")).unwrap();
        assert_eq!(p.url, "http://127.0.0.1:8787/kern/v1");
        assert_eq!(p.name.as_deref(), Some("Acme"));
        assert!(decode_pairing("kern-platform:not-base64!!").is_err());
        assert!(decode_pairing("just some text").is_err());
    }
}
