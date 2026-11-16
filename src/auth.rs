// Accounts and sessions: signup, login, logout, "who am I", and the first admin.
use crate::{ApiError, App, error, store};
use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::SaltString,
};
use rand_core::{OsRng, RngCore};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};
use crate::database::{Connection, params};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

pub const COOKIE: &str = "customize_session";
const SESSION_SECONDS: i64 = 30 * 24 * 60 * 60;
const MAX_FAILURES: u32 = 5;
const FAILURE_WINDOW: Duration = Duration::from_secs(15 * 60);
pub const ROLES: [&str; 3] = ["shopper", "shop_owner", "admin"];

#[derive(Clone, Serialize)]
pub struct User {
    pub id: i64,
    pub name: String,
    pub email: String,
    pub role: String,
    pub created_at: i64,
}

impl User {
    pub fn from_row(row: &crate::database::Row) -> rusqlite::Result<User> {
        Ok(User {
            id: row.get("id")?,
            name: row.get("name")?,
            email: row.get("email")?,
            role: row.get("role")?,
            created_at: row.get("created_at")?,
        })
    }
}

pub fn db_error(cause: rusqlite::Error) -> ApiError {
    eprintln!("Database error: {cause}");
    error(StatusCode::INTERNAL_SERVER_ERROR, "Something went wrong. Try again.")
}

pub fn hash_password(password: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .expect("argon2 hashing")
        .to_string()
}

fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
        .unwrap_or(false)
}

/// Used when the email is unknown, so a failed login takes as long either way.
fn dummy_hash() -> &'static str {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| hash_password("customize-placeholder-password"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn token_hash(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

pub fn valid_email(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else { return false };
    email.len() <= 254
        && !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !email.contains(char::is_whitespace)
        && !domain.contains('@')
}

pub fn valid_password(password: &str) -> Result<(), ApiError> {
    let length = password.chars().count();
    if length < 8 {
        return Err(error(StatusCode::BAD_REQUEST, "Use a password of at least 8 characters."));
    }
    if length > 128 {
        return Err(error(StatusCode::BAD_REQUEST, "Use a password of at most 128 characters."));
    }
    Ok(())
}

fn session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == COOKIE)
        .map(|(_, value)| value.to_string())
        .filter(|value| (32..=128).contains(&value.len()))
}

/// The signed-in user for this request, if the session cookie is valid and unexpired.
pub fn session_user(conn: &Connection, headers: &HeaderMap) -> Option<User> {
    let token = session_token(headers)?;
    conn.query_row(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1 AND s.expires_at > ?2",
        params![token_hash(&token), store::now()],
        User::from_row,
    )
    .optional()
    .unwrap_or(None)
}

pub fn require_admin(conn: &Connection, headers: &HeaderMap) -> Result<User, ApiError> {
    match session_user(conn, headers) {
        None => Err(error(StatusCode::UNAUTHORIZED, "Please log in.")),
        Some(user) if user.role != "admin" => Err(error(StatusCode::FORBIDDEN, "Only admins can do this.")),
        Some(user) => Ok(user),
    }
}

fn start_session(conn: &Connection, user_id: i64) -> Result<String, ApiError> {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token = hex(&bytes);
    let now = store::now();
    conn.execute("DELETE FROM sessions WHERE expires_at <= ?1", [now]).map_err(db_error)?;
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)",
        params![token_hash(&token), user_id, now + SESSION_SECONDS],
    )
    .map_err(db_error)?;
    Ok(format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_SECONDS}"))
}

fn signed_in(cookie: String, user: User) -> impl IntoResponse {
    ([(header::SET_COOKIE, cookie)], Json(json!({ "user": user })))
}

#[derive(Deserialize)]
pub struct Signup {
    name: String,
    email: String,
    password: String,
    #[serde(default)]
    shopper: Option<String>,
}

pub async fn signup(State(app): State<Arc<App>>, Json(body): Json<Signup>) -> Result<impl IntoResponse, ApiError> {
    let name = body.name.trim().to_string();
    let email = body.email.trim().to_lowercase();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(error(StatusCode::BAD_REQUEST, "Enter your name (up to 80 characters)."));
    }
    if !valid_email(&email) {
        return Err(error(StatusCode::BAD_REQUEST, "Enter a valid email address."));
    }
    valid_password(&body.password)?;
    let hash = hash_password(&body.password);
    let mut db = app.db.lock().expect("db lock");
    let conn = db.transaction().map_err(db_error)?;
    let inserted = conn.execute(
        "INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?1, ?2, ?3, 'shopper', ?4)",
        params![name, email, hash, store::now()],
    );
    match inserted {
        Err(rusqlite::Error::SqliteFailure(failure, _))
            if failure.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            return Err(error(StatusCode::CONFLICT, "An account with this email already exists. Log in instead."));
        }
        other => other.map_err(db_error)?,
    };
    let user = conn
        .query_row("SELECT * FROM users WHERE id = ?1", [conn.last_insert_rowid()], User::from_row)
        .map_err(db_error)?;
    if let Some(shopper) = &body.shopper {
        store::adopt_shopper(&conn, shopper, user.id).map_err(db_error)?;
    }
    let cookie = start_session(&conn, user.id)?;
    conn.commit().map_err(db_error)?;
    Ok((StatusCode::CREATED, signed_in(cookie, user)))
}

#[derive(Deserialize)]
pub struct Login {
    email: String,
    password: String,
    #[serde(default)]
    shopper: Option<String>,
}

pub async fn login(State(app): State<Arc<App>>, Json(body): Json<Login>) -> Result<impl IntoResponse, ApiError> {
    let email = body.email.trim().to_lowercase();
    let too_many = || error(StatusCode::TOO_MANY_REQUESTS, "Too many attempts. Wait 15 minutes and try again.");
    {
        let mut failures = app.login_failures.lock().expect("failure lock");
        failures.retain(|_, (_, since)| since.elapsed() < FAILURE_WINDOW);
        if failures.get(&email).is_some_and(|(count, _)| *count >= MAX_FAILURES) {
            return Err(too_many());
        }
    }
    let found = {
        let conn = app.db.lock().expect("db lock");
        conn.query_row("SELECT * FROM users WHERE email = ?1", [&email], |row| {
            Ok((User::from_row(row)?, row.get::<_, String>("password_hash")?))
        })
        .optional()
        .map_err(db_error)?
    };
    let user = match found {
        Some((user, hash)) if verify_password(&body.password, &hash) => user,
        other => {
            if other.is_none() {
                verify_password(&body.password, dummy_hash());
            }
            let mut failures = app.login_failures.lock().expect("failure lock");
            let entry = failures.entry(email).or_insert((0, Instant::now()));
            entry.0 += 1;
            return Err(error(StatusCode::UNAUTHORIZED, "Email or password is incorrect."));
        }
    };
    app.login_failures.lock().expect("failure lock").remove(&email);
    let conn = app.db.lock().expect("db lock");
    if let Some(shopper) = &body.shopper {
        store::adopt_shopper(&conn, shopper, user.id).map_err(db_error)?;
    }
    let cookie = start_session(&conn, user.id)?;
    Ok(signed_in(cookie, user))
}

pub async fn logout(State(app): State<Arc<App>>, headers: HeaderMap) -> Result<impl IntoResponse, ApiError> {
    if let Some(token) = session_token(&headers) {
        let conn = app.db.lock().expect("db lock");
        conn.execute("DELETE FROM sessions WHERE token_hash = ?1", [token_hash(&token)])
            .map_err(db_error)?;
    }
    let cookie = format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    Ok(([(header::SET_COOKIE, cookie)], Json(json!({ "ok": true }))))
}

pub async fn me(State(app): State<Arc<App>>, headers: HeaderMap) -> Json<Value> {
    let conn = app.db.lock().expect("db lock");
    Json(json!({ "user": session_user(&conn, &headers) }))
}

/// Creates the first admin from CUSTOMIZE_ADMIN_EMAIL / CUSTOMIZE_ADMIN_PASSWORD when no admin exists.
pub fn ensure_admin(conn: &Connection, credentials: Option<(String, String)>) -> rusqlite::Result<()> {
    let admins: i64 = conn.query_row("SELECT COUNT(*) FROM users WHERE role = 'admin'", [], |r| r.get(0))?;
    if admins > 0 {
        return Ok(());
    }
    let Some((email, password)) = credentials else {
        println!("No admin account yet. Set CUSTOMIZE_ADMIN_EMAIL and CUSTOMIZE_ADMIN_PASSWORD and restart to create one.");
        return Ok(());
    };
    let email = email.trim().to_lowercase();
    if !valid_email(&email) || valid_password(&password).is_err() {
        eprintln!("CUSTOMIZE_ADMIN_EMAIL must be an email and CUSTOMIZE_ADMIN_PASSWORD 8-128 characters. No admin was created.");
        return Ok(());
    }
    let promoted = conn.execute("UPDATE users SET role = 'admin' WHERE email = ?1", [&email])?;
    if promoted == 0 {
        conn.execute(
            "INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('Admin', ?1, ?2, 'admin', ?3)",
            params![email, hash_password(&password), store::now()],
        )?;
        println!("Created admin account {email}.");
    } else {
        println!("Made existing account {email} an admin (its password was not changed).");
    }
    Ok(())
}
