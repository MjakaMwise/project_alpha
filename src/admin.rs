// Admin API: shops, their products, users and roles, and product image uploads. Admins only.
use crate::{
    ApiError, App, Product,
    auth::{ROLES, User, db_error, require_admin},
    error, store,
};
use rand_core::{OsRng, RngCore};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use crate::database::{Connection, params};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, fs, sync::Arc};

type Search = Query<HashMap<String, String>>;

fn bad(message: &str) -> ApiError {
    error(StatusCode::BAD_REQUEST, message)
}

fn not_found(message: &str) -> ApiError {
    error(StatusCode::NOT_FOUND, message)
}

fn like(query: &Search) -> String {
    let q = query.get("q").map(|q| q.trim()).unwrap_or("");
    format!("%{}%", q.replace(['%', '_'], ""))
}

fn slugify(text: &str, separator: char) -> String {
    let mut slug = String::new();
    for c in text.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with(separator) {
            slug.push(separator);
        }
    }
    slug.trim_end_matches(separator).chars().take(60).collect()
}

fn text(value: Option<String>, max: usize, field: &str) -> Result<String, ApiError> {
    let value = value.unwrap_or_default().trim().to_string();
    if value.chars().count() > max {
        return Err(bad(&format!("{field} is too long (up to {max} characters).")));
    }
    Ok(value)
}

fn required(value: Option<String>, max: usize, field: &str) -> Result<String, ApiError> {
    let value = text(value, max, field)?;
    if value.is_empty() {
        return Err(bad(&format!("{field} is required.")));
    }
    Ok(value)
}

/* ---------- shops ---------- */

#[derive(Deserialize)]
pub struct ShopInput {
    name: Option<String>,
    slug: Option<String>,
    description: Option<String>,
    owner_id: Option<i64>,
    status: Option<String>,
}

fn shop_json(conn: &Connection, id: i64) -> Result<Value, ApiError> {
    let shops = list_shop_rows(conn, Some(id), "%%")?;
    shops.into_iter().next().ok_or_else(|| not_found("Shop not found."))
}

fn list_shop_rows(conn: &Connection, id: Option<i64>, pattern: &str) -> Result<Vec<Value>, ApiError> {
    let mut statement = conn
        .prepare(
            "SELECT s.id, s.name, s.slug, s.description, s.status, s.created_at, s.owner_id,
                    u.name AS owner_name, u.email AS owner_email,
                    (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id) AS product_count
             FROM shops s LEFT JOIN users u ON u.id = s.owner_id
             WHERE (?1 IS NULL OR s.id = ?1)
               AND (s.name LIKE ?2 OR s.slug LIKE ?2 OR IFNULL(u.email, '') LIKE ?2 OR IFNULL(u.name, '') LIKE ?2)
             ORDER BY s.id",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![id, pattern], |row| {
            let owner_id: Option<i64> = row.get("owner_id")?;
            Ok(json!({
                "id": row.get::<_, i64>("id")?,
                "name": row.get::<_, String>("name")?,
                "slug": row.get::<_, String>("slug")?,
                "description": row.get::<_, String>("description")?,
                "status": row.get::<_, String>("status")?,
                "created_at": row.get::<_, i64>("created_at")?,
                "product_count": row.get::<_, i64>("product_count")?,
                "owner": owner_id.map(|id| -> rusqlite::Result<Value> { Ok(json!({
                    "id": id,
                    "name": row.get::<_, String>("owner_name")?,
                    "email": row.get::<_, String>("owner_email")?,
                })) }).transpose()?,
            }))
        })
        .map_err(db_error)?;
    rows.collect::<Result<_, _>>().map_err(db_error)
}

pub async fn list_shops(State(app): State<Arc<App>>, headers: HeaderMap, query: Search) -> Result<Json<Value>, ApiError> {
    let conn = app.db.lock().expect("db lock");
    require_admin(&conn, &headers)?;
    Ok(Json(json!({ "shops": list_shop_rows(&conn, None, &like(&query))? })))
}

/// Checks a shop form, and makes a newly assigned shopper a shop owner.
fn shop_fields(conn: &Connection, input: ShopInput) -> Result<(String, String, String, Option<i64>, String), ApiError> {
    let name = required(input.name, 80, "Shop name")?;
    let slug = match input.slug.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(slug) => {
            if slug.len() > 60 || !slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
                return Err(bad("The web address may only use lowercase letters, numbers and dashes."));
            }
            slug
        }
        None => slugify(&name, '-'),
    };
    if slug.is_empty() {
        return Err(bad("Give the shop a name with some letters or numbers."));
    }
    let description = text(input.description, 500, "Description")?;
    let status = input.status.unwrap_or_else(|| "active".into());
    if status != "active" && status != "suspended" {
        return Err(bad("Status must be active or suspended."));
    }
    if let Some(owner) = input.owner_id {
        let role: Option<String> = conn
            .query_row("SELECT role FROM users WHERE id = ?1", [owner], |r| r.get(0))
            .optional()
            .map_err(db_error)?;
        match role.as_deref() {
            None => return Err(bad("That owner account does not exist.")),
            Some("shopper") => {
                conn.execute("UPDATE users SET role = 'shop_owner' WHERE id = ?1", [owner]).map_err(db_error)?;
            }
            Some(_) => {}
        }
    }
    Ok((name, slug, description, input.owner_id, status))
}

fn slug_taken(result: rusqlite::Result<usize>) -> Result<usize, ApiError> {
    match result {
        Err(rusqlite::Error::SqliteFailure(failure, _)) if failure.code == rusqlite::ErrorCode::ConstraintViolation => {
            Err(error(StatusCode::CONFLICT, "Another shop already uses that web address."))
        }
        other => other.map_err(db_error),
    }
}

pub async fn create_shop(State(app): State<Arc<App>>, headers: HeaderMap, Json(input): Json<ShopInput>) -> Result<(StatusCode, Json<Value>), ApiError> {
    let conn = app.db.lock().expect("db lock");
    require_admin(&conn, &headers)?;
    let (name, slug, description, owner, status) = shop_fields(&conn, input)?;
    slug_taken(conn.execute(
        "INSERT INTO shops (name, slug, description, owner_id, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![name, slug, description, owner, status, store::now()],
    ))?;
    Ok((StatusCode::CREATED, Json(shop_json(&conn, conn.last_insert_rowid())?)))
}

pub async fn update_shop(State(app): State<Arc<App>>, headers: HeaderMap, Path(id): Path<i64>, Json(input): Json<ShopInput>) -> Result<Json<Value>, ApiError> {
    let conn = app.db.lock().expect("db lock");
    require_admin(&conn, &headers)?;
    shop_json(&conn, id)?;
    let (name, slug, description, owner, status) = shop_fields(&conn, input)?;
    slug_taken(conn.execute(
        "UPDATE shops SET name = ?1, slug = ?2, description = ?3, owner_id = ?4, status = ?5 WHERE id = ?6",
        params![name, slug, description, owner, status, id],
    ))?;
    Ok(Json(shop_json(&conn, id)?))
}

pub async fn delete_shop(State(app): State<Arc<App>>, headers: HeaderMap, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    let conn = app.db.lock().expect("db lock");
    require_admin(&conn, &headers)?;
    if conn.execute("DELETE FROM shops WHERE id = ?1", [id]).map_err(db_error)? == 0 {
        return Err(not_found("Shop not found."));
    }
    Ok(Json(json!({ "ok": true })))
}

/* ---------- products ---------- */

#[derive(Deserialize)]
pub struct ProductInput {
    name: Option<String>,
    r#type: Option<String>,
    vessel: Option<String>,
    description: Option<String>,
    price: Option<u32>,
    height_cm: Option<u32>,
    size: Option<String>,
    light: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    scale: Option<f64>,
    image: Option<String>,
}

fn product_fields(id: String, input: ProductInput) -> Result<Product, ApiError> {
    let name = required(input.name, 80, "Product name")?;
    let r#type = required(input.r#type, 40, "Category")?;
    let price = input.price.ok_or_else(|| bad("Price is required."))?;
    if !(1..=10_000_000).contains(&price) {
        return Err(bad("Price must be between 1 and 10,000,000 KSh."));
    }
    let height_cm = input.height_cm.ok_or_else(|| bad("Height is required."))?;
    if !(5..=300).contains(&height_cm) {
        return Err(bad("Height must be between 5 and 300 cm."));
    }
    let scale = input.scale.unwrap_or(0.3);
    if !(0.05..=1.0).contains(&scale) {
        return Err(bad("Scale must be between 0.05 and 1."));
    }
    let mut tags: Vec<String> = Vec::new();
    for tag in input.tags {
        let tag = tag.trim().to_lowercase();
        if tag.is_empty() || tags.contains(&tag) {
            continue;
        }
        if tag.chars().count() > 30 {
            return Err(bad("Each tag can be up to 30 characters."));
        }
        tags.push(tag);
    }
    if tags.len() > 8 {
        return Err(bad("Use at most 8 tags."));
    }
    let image = input.image.map(|i| i.trim().to_string()).filter(|i| !i.is_empty());
    if let Some(image) = &image {
        let allowed = image.starts_with("assets/") || image.starts_with("uploads/") || image.starts_with("https://");
        if !allowed || image.len() > 300 || image.contains("..") || image.chars().any(|c| c.is_whitespace() || "\"'<>\\".contains(c)) {
            return Err(bad("Image must be an uploaded image, an assets/ path or an https:// address."));
        }
    }
    let size = text(input.size, 40, "Size")?;
    Ok(Product {
        id,
        size: if size.is_empty() { format!("{height_cm} cm tall") } else { size },
        name,
        r#type,
        vessel: text(input.vessel, 80, "Vessel")?,
        description: text(input.description, 500, "Description")?,
        price,
        height_cm,
        light: text(input.light, 80, "Light")?,
        tags,
        scale,
        image,
        shop: None,
    })
}

pub async fn list_products(State(app): State<Arc<App>>, headers: HeaderMap, Path(shop): Path<i64>) -> Result<Json<Value>, ApiError> {
    let conn = app.db.lock().expect("db lock");
    require_admin(&conn, &headers)?;
    shop_json(&conn, shop)?;
    let mut statement = conn
        .prepare("SELECT * FROM products WHERE shop_id = ?1 ORDER BY position, rowid")
        .map_err(db_error)?;
    let products: Vec<Product> = statement
        .query_map([shop], store::product_from_row)
        .and_then(|rows| rows.collect())
        .map_err(db_error)?;
    Ok(Json(json!({ "products": products })))
}

pub async fn create_product(State(app): State<Arc<App>>, headers: HeaderMap, Path(shop): Path<i64>, Json(input): Json<ProductInput>) -> Result<(StatusCode, Json<Value>), ApiError> {
    let conn = app.db.lock().expect("db lock");
    require_admin(&conn, &headers)?;
    shop_json(&conn, shop)?;
    let mut product = product_fields(String::new(), input)?;
    // Product ids are shared by the shopper app (saves, orders, image names), so keep them unique and stable.
    let base = match slugify(&product.name, '_') {
        base if base.is_empty() => "product".to_string(),
        base => base,
    };
    let exists = |id: &str| -> Result<bool, ApiError> {
        Ok(conn
            .query_row("SELECT 1 FROM products WHERE id = ?1", [id], |_| Ok(()))
            .optional()
            .map_err(db_error)?
            .is_some())
    };
    let mut id = base.clone();
    let mut n = 2;
    while exists(&id)? {
        id = format!("{base}_{n}");
        n += 1;
    }
    product.id = id;
    let position: i64 = conn
        .query_row("SELECT IFNULL(MAX(position), -1) + 1 FROM products WHERE shop_id = ?1", [shop], |r| r.get(0))
        .map_err(db_error)?;
    store::insert_product(&conn, shop, position, &product).map_err(db_error)?;
    Ok((StatusCode::CREATED, Json(json!(product))))
}

pub async fn update_product(State(app): State<Arc<App>>, headers: HeaderMap, Path(id): Path<String>, Json(input): Json<ProductInput>) -> Result<Json<Value>, ApiError> {
    let conn = app.db.lock().expect("db lock");
    require_admin(&conn, &headers)?;
    let product = product_fields(id.clone(), input)?;
    let changed = conn
        .execute(
            "UPDATE products SET name = ?1, type = ?2, vessel = ?3, description = ?4, price = ?5, height_cm = ?6,
             size = ?7, light = ?8, tags = ?9, scale = ?10, image = ?11 WHERE id = ?12",
            params![
                product.name, product.r#type, product.vessel, product.description, product.price, product.height_cm,
                product.size, product.light, serde_json::to_string(&product.tags).unwrap_or_default(), product.scale,
                product.image, id
            ],
        )
        .map_err(db_error)?;
    if changed == 0 {
        return Err(not_found("Product not found."));
    }
    Ok(Json(json!(product)))
}

pub async fn delete_product(State(app): State<Arc<App>>, headers: HeaderMap, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let conn = app.db.lock().expect("db lock");
    require_admin(&conn, &headers)?;
    if conn.execute("DELETE FROM products WHERE id = ?1", [&id]).map_err(db_error)? == 0 {
        return Err(not_found("Product not found."));
    }
    Ok(Json(json!({ "ok": true })))
}

/* ---------- users ---------- */

pub async fn list_users(State(app): State<Arc<App>>, headers: HeaderMap, query: Search) -> Result<Json<Value>, ApiError> {
    let conn = app.db.lock().expect("db lock");
    require_admin(&conn, &headers)?;
    let mut statement = conn
        .prepare("SELECT id, name, email, role, created_at FROM users WHERE name LIKE ?1 OR email LIKE ?1 ORDER BY id")
        .map_err(db_error)?;
    let users: Vec<User> = statement
        .query_map([like(&query)], User::from_row)
        .and_then(|rows| rows.collect())
        .map_err(db_error)?;
    Ok(Json(json!({ "users": users })))
}

#[derive(Deserialize)]
pub struct RoleInput {
    role: String,
}

pub async fn update_user(State(app): State<Arc<App>>, headers: HeaderMap, Path(id): Path<i64>, Json(input): Json<RoleInput>) -> Result<Json<Value>, ApiError> {
    let conn = app.db.lock().expect("db lock");
    let me = require_admin(&conn, &headers)?;
    if !ROLES.contains(&input.role.as_str()) {
        return Err(bad("Role must be shopper, shop_owner or admin."));
    }
    let current: String = conn
        .query_row("SELECT role FROM users WHERE id = ?1", [id], |r| r.get(0))
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| not_found("User not found."))?;
    if current == "admin" && input.role != "admin" {
        if id == me.id {
            return Err(bad("You cannot remove your own admin role."));
        }
        let admins: i64 = conn
            .query_row("SELECT COUNT(*) FROM users WHERE role = 'admin'", [], |r| r.get(0))
            .map_err(db_error)?;
        if admins <= 1 {
            return Err(bad("Keep at least one admin."));
        }
    }
    conn.execute("UPDATE users SET role = ?1 WHERE id = ?2", params![input.role, id]).map_err(db_error)?;
    let user = conn
        .query_row("SELECT id, name, email, role, created_at FROM users WHERE id = ?1", [id], User::from_row)
        .map_err(db_error)?;
    Ok(Json(json!(user)))
}

/* ---------- product images ---------- */

pub async fn upload(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> Result<Json<Value>, ApiError> {
    {
        let conn = app.db.lock().expect("db lock");
        require_admin(&conn, &headers)?;
    }
    // Trust the file's first bytes, not its name or the declared type.
    let extension = if body.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if body.starts_with(b"\xff\xd8\xff") {
        "jpg"
    } else if body.len() > 12 && &body[0..4] == b"RIFF" && &body[8..12] == b"WEBP" {
        "webp"
    } else {
        return Err(bad("Upload a PNG, JPEG or WebP image."));
    };
    let mut bytes = [0u8; 12];
    OsRng.fill_bytes(&mut bytes);
    let name = format!("{}.{extension}", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>());
    fs::create_dir_all(&app.uploads)
        .and_then(|()| fs::write(app.uploads.join(&name), &body))
        .map_err(|cause| {
            eprintln!("Could not store upload: {cause}");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Could not save the image. Try again.")
        })?;
    Ok(Json(json!({ "url": format!("uploads/{name}") })))
}
