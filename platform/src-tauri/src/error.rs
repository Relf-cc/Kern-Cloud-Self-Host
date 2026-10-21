// @Author Christian Relf
// @Date 2026-10-21

//! Errors that cross into the interface.
//!
//! Each one carries a stable code the front end switches on (`describeError`
//! in `src/lib/ipc.ts`) and a message a person can act on. The codes are a
//! contract: change what one means and the interface starts saying the wrong
//! thing.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// The request was wrong: a bad address, a missing field.
    #[error("{0}")]
    Invalid(String),
    /// The server refused the token, or there isn't one.
    #[error("{0}")]
    Auth(String),
    /// The server couldn't be reached at all.
    #[error("{0}")]
    Network(String),
    /// The server answered, but refused: wrong scope, loopback-only.
    #[error("{0}")]
    Refused(String),
    /// Nothing of that name on the server.
    #[error("{0} wasn't found.")]
    NotFound(String),
    /// A file or the credential store wouldn't cooperate.
    #[error("{0}")]
    Io(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Invalid(_) => "invalid",
            AppError::Auth(_) => "auth",
            AppError::Network(_) => "network",
            AppError::Refused(_) => "refused",
            AppError::NotFound(_) => "not_found",
            AppError::Io(_) => "io",
        }
    }
}

#[derive(Serialize)]
struct Wire {
    code: &'static str,
    message: String,
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        Wire { code: self.code(), message: self.to_string() }.serialize(s)
    }
}

pub type AppResult<T> = Result<T, AppError>;

pub fn invalid<T>(message: impl Into<String>) -> AppResult<T> {
    Err(AppError::Invalid(message.into()))
}
