// Orders: recorded at checkout, tracked by the shopper, managed by admins.
use crate::{
    ApiError, App, OrderItem, Shopper,
    auth::{db_error, require_admin, session_user},
    error, store, valid_id,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use crate::database::{Connection, params};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

pub const STATUSES: [&str; 6] = ["placed", "confirmed", "preparing", "out_for_delivery", "delivered", "cancelled"];

/// The one status an order moves to next. Delivered and cancelled are final.
fn next_status(status: &str) -> Option<&'static str> {
    match status {
        "placed" => Some("confirmed"),
        "confirmed" => Some("preparing"),
        "preparing" => Some("out_for_delivery"),
        "out_for_delivery" => Some("delivered"),
        _ => None,
    }
}

pub fn number(id: i64) -> String {
    format!("CU-{id:06}")
}

fn parse_number(text: &str) -> Option<i64> {
    let text = text.trim().to_ascii_uppercase();
    let digits = text.strip_prefix("CU-").or_else(|| text.strip_prefix("CU")).unwrap_or(&text);
    digits.trim().parse().ok().filter(|id| *id > 0)
}

/// Last nine digits, so 0712 345 678, +254712345678 and 712345678 all match.
fn phone_key(phone: &str) -> String {
    let digits: String = phone.chars().filter(char::is_ascii_digit).collect();
    digits[digits.len().saturating_sub(9)..].to_string()
}

fn bad(message: &str) -> ApiError {
    error(StatusCode::BAD_REQUEST, message)
}

#[derive(Deserialize, Clone, Default)]
pub struct Delivery {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub note: String,
}

impl Delivery {
    /// Trims and checks checkout details. Name, phone and address are required.
    pub fn validated(&self) -> Result<Delivery, ApiError> {
        let name = self.name.trim().to_string();
        let phone = self.phone.trim().to_string();
        let address = self.address.trim().to_string();
        let note = self.note.trim().to_string();
        if name.is_empty() || name.chars().count() > 80 {
            return Err(bad("Enter the name for the delivery (up to 80 characters)."));
        }
        let digits = phone.chars().filter(char::is_ascii_digit).count();
        if !(9..=15).contains(&digits) || !phone.chars().all(|c| c.is_ascii_digit() || " +-()".contains(c)) {
            return Err(bad("Enter a phone number, for example 0712 345 678."));
        }
        if address.is_empty() || address.chars().count() > 200 {
            return Err(bad("Enter the delivery address or area (up to 200 characters)."));
        }
        if note.chars().count() > 300 {
            return Err(bad("Keep the note under 300 characters."));
        }
        Ok(Delivery { name, phone, address, note })
    }
}

/// Lines of a recorded shopper order: cart orders list items, older ones a single product.
fn lines(order: &crate::Order) -> Vec<OrderItem> {
    if order.items.is_empty() {
        vec![OrderItem { product_id: order.product_id.clone(), quantity: 1 }]
    } else {
        order.items.clone()
    }
}

fn insert(
    conn: &Connection,
    shopper_key: &str,
    user_id: Option<i64>,
    order: &crate::Order,
    delivery: &Delivery,
    created_at: i64,
    event_note: &str,
) -> rusqlite::Result<Option<i64>> {
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO orders (ref, shopper_key, user_id, customer_name, phone, address, note, total, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'placed', ?9, ?9)",
        params![order.id, shopper_key, user_id, delivery.name, delivery.phone, delivery.address, delivery.note, order.amount, created_at],
    )?;
    if inserted == 0 {
        return Ok(None);
    }
    let id = conn.last_insert_rowid();
    for line in lines(order) {
        let product: Option<(String, i64, i64, String, Option<String>)> = conn
            .query_row(
                "SELECT p.name, p.price, s.id, s.name, p.image FROM products p JOIN shops s ON s.id = p.shop_id WHERE p.id = ?1",
                [&line.product_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        let (name, price, shop_id, shop_name, image) = match product {
            Some((name, price, shop, shop_name, image)) => (name, price, Some(shop), shop_name, image),
            None => (line.product_id.clone(), 0, None, String::new(), None),
        };
        conn.execute(
            "INSERT INTO order_items (order_id, product_id, name, shop_id, shop_name, price, quantity, image) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, line.product_id, name, shop_id, shop_name, price, line.quantity, image],
        )?;
    }
    conn.execute(
        "INSERT INTO order_events (order_id, status, note, actor, at) VALUES (?1, 'placed', ?2, 'customer', ?3)",
        params![id, event_note, created_at],
    )?;
    Ok(Some(id))
}

/// Called after a checkout interaction is saved: files the order for tracking (once per reference).
pub fn record_checkout(conn: &Connection, shopper_key: &str, shopper: &Shopper, order_ref: &str, delivery: &Delivery) -> rusqlite::Result<()> {
    let user_id = shopper_key.strip_prefix("user-").and_then(|id| id.parse().ok());
    if let Some(order) = shopper.orders.iter().find(|o| o.id == order_ref) {
        insert(conn, shopper_key, user_id, order, delivery, store::now(), "")?;
    }
    Ok(())
}

/// One-time move of demo orders that only lived inside shopper activity records.
pub fn migrate_demo_orders(conn: &mut Connection) -> Result<(), Box<dyn std::error::Error>> {
    if store::meta(conn, "orders_migrated")? {
        return Ok(());
    }
    let tx = conn.transaction()?;
    let shoppers: Vec<(String, String)> = {
        let mut statement = tx.prepare("SELECT id, data FROM shoppers")?;
        let rows = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut moved = 0;
    for (key, data) in shoppers {
        let Ok(shopper) = serde_json::from_str::<Shopper>(&data) else { continue };
        let user_id = key.strip_prefix("user-").and_then(|id| id.parse().ok());
        for order in &shopper.orders {
            if insert(&tx, &key, user_id, order, &Delivery::default(), store::now(), "Demo order placed before tracking existed")?.is_some() {
                moved += 1;
            }
        }
    }
    tx.execute("INSERT INTO meta (key, value) VALUES ('orders_migrated', '1')", [])?;
    tx.commit()?;
    if moved > 0 {
        println!("Moved {moved} demo orders into order tracking.");
    }
    Ok(())
}

fn order_json(conn: &Connection, id: i64) -> Result<Value, ApiError> {
    let order = conn
        .query_row("SELECT * FROM orders WHERE id = ?1", [id], |r| {
            Ok(json!({
                "id": r.get::<_, i64>("id")?,
                "number": number(r.get("id")?),
                "ref": r.get::<_, String>("ref")?,
                "status": r.get::<_, String>("status")?,
                "total": r.get::<_, i64>("total")?,
                "created_at": r.get::<_, i64>("created_at")?,
                "updated_at": r.get::<_, i64>("updated_at")?,
                "customer": {
                    "name": r.get::<_, String>("customer_name")?,
                    "phone": r.get::<_, String>("phone")?,
                    "address": r.get::<_, String>("address")?,
                    "note": r.get::<_, String>("note")?,
                },
                "account": r.get::<_, Option<i64>>("user_id")?.is_some(),
            }))
        })
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Order not found."))?;
    let mut order = order;
    let mut items = conn.prepare_cached("SELECT * FROM order_items WHERE order_id = ?1 ORDER BY rowid").map_err(db_error)?;
    let items: Vec<Value> = items
        .query_map([id], |r| {
            Ok(json!({
                "product_id": r.get::<_, String>("product_id")?,
                "name": r.get::<_, String>("name")?,
                "shop_id": r.get::<_, Option<i64>>("shop_id")?,
                "shop_name": r.get::<_, String>("shop_name")?,
                "price": r.get::<_, i64>("price")?,
                "quantity": r.get::<_, i64>("quantity")?,
                "image": r.get::<_, Option<String>>("image")?,
            }))
        })
        .and_then(|rows| rows.collect())
        .map_err(db_error)?;
    let mut events = conn.prepare_cached("SELECT * FROM order_events WHERE order_id = ?1 ORDER BY at, rowid").map_err(db_error)?;
    let events: Vec<Value> = events
        .query_map([id], |r| {
            Ok(json!({
                "status": r.get::<_, String>("status")?,
                "note": r.get::<_, String>("note")?,
                "actor": r.get::<_, String>("actor")?,
                "at": r.get::<_, i64>("at")?,
            }))
        })
        .and_then(|rows| rows.collect())
        .map_err(db_error)?;
    order["items"] = json!(items);
    order["events"] = json!(events);
    order["next_status"] = json!(next_status(order["status"].as_str().unwrap_or("")));
    Ok(order)
}

fn change_status(conn: &Connection, id: i64, status: &str, note: &str, actor: &str) -> Result<(), ApiError> {
    let now = store::now();
    conn.execute("UPDATE orders SET status = ?1, updated_at = ?2 WHERE id = ?3", params![status, now, id]).map_err(db_error)?;
    conn.execute(
        "INSERT INTO order_events (order_id, status, note, actor, at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, status, note, actor, now],
    )
    .map_err(db_error)?;
    Ok(())
}

/// The activity key and account for this request (same rule as the catalog).
fn owner(conn: &Connection, headers: &HeaderMap, shopper: &str) -> Result<(String, Option<i64>), ApiError> {
    if !valid_id(shopper) {
        return Err(bad("Invalid session."));
    }
    Ok(match session_user(conn, headers) {
        Some(user) => (crate::user_key(user.id), Some(user.id)),
        None => (shopper.to_string(), None),
    })
}

/* ---------- shopper ---------- */

pub async fn mine(State(app): State<Arc<App>>, headers: HeaderMap, Path(shopper): Path<String>) -> Result<Json<Value>, ApiError> {
    let conn = app.db.lock().expect("db lock");
    let (key, user) = owner(&conn, &headers, &shopper)?;
    let ids: Vec<i64> = conn
        .prepare("SELECT id FROM orders WHERE shopper_key = ?1 OR (?2 IS NOT NULL AND user_id = ?2) ORDER BY id DESC LIMIT 100")
        .and_then(|mut s| s.query_map(params![key, user], |r| r.get(0))?.collect())
        .map_err(db_error)?;
    let orders = ids.into_iter().map(|id| order_json(&conn, id)).collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({ "orders": orders })))
}

#[derive(Deserialize)]
pub struct Lookup {
    number: String,
    phone: String,
}

/// Guests track an order with its number and the phone used at checkout.
pub async fn lookup(State(app): State<Arc<App>>, Json(body): Json<Lookup>) -> Result<Json<Value>, ApiError> {
    let not_found = || error(StatusCode::NOT_FOUND, "No order matches that number and phone.");
    let limit_key = format!("order:{}", body.number.trim().to_ascii_uppercase());
    {
        let mut failures = app.login_failures.lock().expect("failure lock");
        failures.retain(|_, (_, since)| since.elapsed() < Duration::from_secs(15 * 60));
        if failures.get(&limit_key).is_some_and(|(count, _)| *count >= 5) {
            return Err(error(StatusCode::TOO_MANY_REQUESTS, "Too many attempts. Wait 15 minutes and try again."));
        }
    }
    let conn = app.db.lock().expect("db lock");
    let found = parse_number(&body.number).and_then(|id| {
        conn.query_row("SELECT phone FROM orders WHERE id = ?1", [id], |r| r.get::<_, String>(0))
            .optional()
            .ok()
            .flatten()
            .map(|phone| (id, phone))
    });
    let wanted = phone_key(&body.phone);
    match found {
        Some((id, phone)) if wanted.len() == 9 && phone_key(&phone) == wanted => {
            app.login_failures.lock().expect("failure lock").remove(&limit_key);
            Ok(Json(order_json(&conn, id)?))
        }
        _ => {
            let mut failures = app.login_failures.lock().expect("failure lock");
            failures.entry(limit_key).or_insert((0, Instant::now())).0 += 1;
            Err(not_found())
        }
    }
}

#[derive(Deserialize)]
pub struct CancelBody {
    shopper: String,
}

pub async fn cancel(State(app): State<Arc<App>>, headers: HeaderMap, Path(order): Path<String>, Json(body): Json<CancelBody>) -> Result<Json<Value>, ApiError> {
    let conn = app.db.lock().expect("db lock");
    let (key, user) = owner(&conn, &headers, &body.shopper)?;
    let id = parse_number(&order).ok_or_else(|| error(StatusCode::NOT_FOUND, "Order not found."))?;
    let status: String = conn
        .query_row(
            "SELECT status FROM orders WHERE id = ?1 AND (shopper_key = ?2 OR (?3 IS NOT NULL AND user_id = ?3))",
            params![id, key, user],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Order not found."))?;
    if status != "placed" {
        return Err(error(StatusCode::CONFLICT, "This order is already being prepared, so it can no longer be cancelled here."));
    }
    change_status(&conn, id, "cancelled", "Cancelled by the customer", "customer")?;
    Ok(Json(order_json(&conn, id)?))
}

/* ---------- admin ---------- */

pub async fn admin_list(State(app): State<Arc<App>>, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Result<Json<Value>, ApiError> {
    let conn = app.db.lock().expect("db lock");
    require_admin(&conn, &headers)?;
    let get = |name: &str| query.get(name).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let status = get("status").filter(|s| STATUSES.contains(&s.as_str()) || s == "active");
    let shop: Option<i64> = get("shop").and_then(|s| s.parse().ok());
    let from: Option<i64> = get("from").and_then(|s| s.parse().ok());
    let to: Option<i64> = get("to").and_then(|s| s.parse().ok());
    let q = get("q").unwrap_or_default();
    let q_id = parse_number(&q);
    let pattern = format!("%{}%", q.replace(['%', '_'], ""));
    let digits = phone_key(&q);
    let ids: Vec<i64> = conn
        .prepare(
            "SELECT o.id FROM orders o
             WHERE (?1 IS NULL OR o.status = ?1 OR (?1 = 'active' AND o.status IN ('confirmed', 'preparing', 'out_for_delivery')))
               AND (?2 IS NULL OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.shop_id = ?2))
               AND (?3 IS NULL OR o.created_at >= ?3)
               AND (?4 IS NULL OR o.created_at < ?4)
               AND (?5 = '' OR o.id = ?6 OR o.customer_name LIKE ?7 OR o.address LIKE ?7
                    OR (length(?8) >= 4 AND replace(replace(replace(o.phone, ' ', ''), '-', ''), '+', '') LIKE '%' || ?8 || '%'))
             ORDER BY o.id DESC LIMIT 300",
        )
        .and_then(|mut s| s.query_map(params![status, shop, from, to, q, q_id, pattern, digits], |r| r.get(0))?.collect())
        .map_err(db_error)?;
    let orders = ids.into_iter().map(|id| order_json(&conn, id)).collect::<Result<Vec<_>, _>>()?;
    // "Today" starts at the time the page sends (the admin's local midnight); default: last 24 hours.
    let today: i64 = get("today").and_then(|s| s.parse().ok()).unwrap_or(store::now() - 86_400);
    let count = |sql: &str, arg: Option<i64>| -> Result<i64, ApiError> {
        conn.query_row(sql, params![arg], |r| r.get(0)).map_err(db_error)
    };
    let counts = json!({
        "new": count("SELECT COUNT(*) FROM orders WHERE status = 'placed' AND ?1 IS NULL", None)?,
        "in_progress": count("SELECT COUNT(*) FROM orders WHERE status IN ('confirmed', 'preparing', 'out_for_delivery') AND ?1 IS NULL", None)?,
        "delivered_today": count("SELECT COUNT(*) FROM orders WHERE status = 'delivered' AND updated_at >= ?1", Some(today))?,
        "total": count("SELECT COUNT(*) FROM orders WHERE ?1 IS NULL", None)?,
    });
    Ok(Json(json!({ "orders": orders, "counts": counts })))
}

pub async fn admin_get(State(app): State<Arc<App>>, headers: HeaderMap, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    let conn = app.db.lock().expect("db lock");
    require_admin(&conn, &headers)?;
    Ok(Json(order_json(&conn, id)?))
}

#[derive(Deserialize)]
pub struct StatusInput {
    status: String,
    #[serde(default)]
    note: String,
}

pub async fn admin_update(State(app): State<Arc<App>>, headers: HeaderMap, Path(id): Path<i64>, Json(input): Json<StatusInput>) -> Result<Json<Value>, ApiError> {
    let conn = app.db.lock().expect("db lock");
    let admin = require_admin(&conn, &headers)?;
    let current: String = conn
        .query_row("SELECT status FROM orders WHERE id = ?1", [id], |r| r.get(0))
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Order not found."))?;
    let note = input.note.trim();
    if note.chars().count() > 300 {
        return Err(bad("Keep the note under 300 characters."));
    }
    let allowed = Some(input.status.as_str()) == next_status(&current)
        || (input.status == "cancelled" && !matches!(current.as_str(), "delivered" | "cancelled"));
    if !allowed {
        return Err(error(StatusCode::CONFLICT, "That status change is not possible from the order's current status."));
    }
    change_status(&conn, id, &input.status, note, &format!("admin:{}", admin.email))?;
    Ok(Json(order_json(&conn, id)?))
}
