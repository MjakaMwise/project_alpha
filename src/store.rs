// SQLite storage: users, sessions, shops, their products and shopper activity.
use crate::{Product, Shopper};
use crate::database::{Connection, params};
use rusqlite::OptionalExtension;
use std::{collections::HashMap, fs, io, path::Path};

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

const SCHEMA: &str = "
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('shopper', 'shop_owner', 'admin')),
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shops (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    vessel TEXT NOT NULL,
    description TEXT NOT NULL,
    price INTEGER NOT NULL,
    height_cm INTEGER NOT NULL,
    size TEXT NOT NULL,
    light TEXT NOT NULL,
    tags TEXT NOT NULL,
    scale REAL NOT NULL,
    image TEXT
);
CREATE TABLE IF NOT EXISTS shoppers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL,
    shopper_key TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    customer_name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    total INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('placed', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (shopper_key, ref)
);
CREATE INDEX IF NOT EXISTS orders_status ON orders (status, created_at);
CREATE TABLE IF NOT EXISTS order_items (
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    name TEXT NOT NULL,
    shop_id INTEGER,
    shop_name TEXT NOT NULL DEFAULT '',
    price INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    image TEXT
);
CREATE TABLE IF NOT EXISTS order_events (
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL,
    at INTEGER NOT NULL
);
";

/// Opens the database, creates tables, seeds the CASINI shop once and imports the old shoppers.json.
pub fn open(db_path: &Path, legacy_json: &Path) -> Result<Connection, Box<dyn std::error::Error>> {
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut conn = Connection::open(db_path)?;
    conn.execute_batch(SCHEMA)?;
    seed_catalog(&mut conn)?;
    migrate_shoppers(&mut conn, legacy_json)?;
    crate::orders::migrate_demo_orders(&mut conn)?;
    Ok(conn)
}

pub fn meta(conn: &Connection, key: &str) -> rusqlite::Result<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM meta WHERE key = ?1", [key], |_| Ok(()))
        .optional()?
        .is_some())
}

fn seed_catalog(conn: &mut Connection) -> Result<(), Box<dyn std::error::Error>> {
    if meta(conn, "seeded")? {
        return Ok(());
    }
    let catalog: Vec<Product> = serde_json::from_str(include_str!("catalog.json"))?;
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT OR IGNORE INTO shops (name, slug, description, status, created_at) VALUES ('CASINI', 'casini', 'The original Customize botanical collection.', 'active', ?1)",
        [now()],
    )?;
    let shop_id: i64 = tx.query_row("SELECT id FROM shops WHERE slug = 'casini'", [], |r| r.get(0))?;
    for (position, product) in catalog.iter().enumerate() {
        insert_product(&tx, shop_id, position as i64, product)?;
    }
    tx.execute("INSERT INTO meta (key, value) VALUES ('seeded', '1')", [])?;
    tx.commit()?;
    Ok(())
}

pub fn insert_product(conn: &Connection, shop_id: i64, position: i64, p: &Product) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO products (id, shop_id, position, name, type, vessel, description, price, height_cm, size, light, tags, scale, image)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            p.id, shop_id, position, p.name, p.r#type, p.vessel, p.description, p.price, p.height_cm,
            p.size, p.light, serde_json::to_string(&p.tags).unwrap_or_else(|_| "[]".into()), p.scale, p.image
        ],
    )?;
    Ok(())
}

fn migrate_shoppers(conn: &mut Connection, legacy: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if meta(conn, "shoppers_migrated")? {
        return Ok(());
    }
    let shoppers: HashMap<String, Shopper> = match fs::read(legacy) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(cause) if cause.kind() == io::ErrorKind::NotFound => HashMap::new(),
        Err(cause) => return Err(cause.into()),
    };
    let tx = conn.transaction()?;
    for (id, shopper) in &shoppers {
        tx.execute(
            "INSERT OR IGNORE INTO shoppers (id, data) VALUES (?1, ?2)",
            params![id, serde_json::to_string(shopper)?],
        )?;
    }
    tx.execute("INSERT INTO meta (key, value) VALUES ('shoppers_migrated', '1')", [])?;
    tx.commit()?;
    if !shoppers.is_empty() {
        // Keep the old file as a backup instead of deleting it.
        let _ = fs::rename(legacy, legacy.with_extension("json.migrated"));
        println!("Imported {} shoppers from {}", shoppers.len(), legacy.display());
    }
    Ok(())
}

pub fn product_from_row(row: &crate::database::Row) -> rusqlite::Result<Product> {
    let tags: String = row.get("tags")?;
    Ok(Product {
        id: row.get("id")?,
        name: row.get("name")?,
        r#type: row.get("type")?,
        vessel: row.get("vessel")?,
        description: row.get("description")?,
        price: row.get("price")?,
        height_cm: row.get("height_cm")?,
        size: row.get("size")?,
        light: row.get("light")?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        scale: row.get("scale")?,
        image: row.get("image")?,
        shop: row.get("shop_name").ok(),
    })
}

/// Every product from active shops, in shop then display order.
pub fn active_products(conn: &Connection) -> rusqlite::Result<Vec<Product>> {
    let mut statement = conn.prepare_cached(
        "SELECT p.*, s.name AS shop_name FROM products p JOIN shops s ON s.id = p.shop_id
         WHERE s.status = 'active' ORDER BY s.id, p.position, p.rowid",
    )?;
    let rows = statement.query_map([], product_from_row)?;
    rows.collect()
}

pub fn load_shopper(conn: &Connection, key: &str) -> rusqlite::Result<Shopper> {
    let data: Option<String> = conn
        .query_row("SELECT data FROM shoppers WHERE id = ?1", [key], |r| r.get(0))
        .optional()?;
    Ok(data.and_then(|d| serde_json::from_str(&d).ok()).unwrap_or_default())
}

pub fn save_shopper(conn: &Connection, key: &str, shopper: &Shopper) -> rusqlite::Result<()> {
    let data = serde_json::to_string(shopper).expect("shopper serializes");
    conn.execute(
        "INSERT INTO shoppers (id, data) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        params![key, data],
    )?;
    Ok(())
}

/// Moves an anonymous shopper's previews, saves and orders into a signed-in account.
pub fn adopt_shopper(conn: &Connection, anonymous: &str, user_id: i64) -> rusqlite::Result<()> {
    if !crate::valid_id(anonymous) {
        return Ok(());
    }
    let from = load_shopper(conn, anonymous)?;
    let key = crate::user_key(user_id);
    let mut into = load_shopper(conn, &key)?;
    for (product, count) in from.previews {
        let entry = into.previews.entry(product).or_default();
        *entry = (*entry).max(count).min(3);
    }
    into.saved.extend(from.saved);
    for order in from.orders {
        if !into.orders.iter().any(|o| o.id == order.id) {
            into.orders.push(order);
        }
    }
    save_shopper(conn, &key, &into)?;
    conn.execute("DELETE FROM shoppers WHERE id = ?1", [anonymous])?;
    // Orders placed on this device now belong to the account too.
    conn.execute(
        "UPDATE orders SET shopper_key = ?1, user_id = ?2 WHERE shopper_key = ?3
         AND NOT EXISTS (SELECT 1 FROM orders existing WHERE existing.shopper_key = ?1 AND existing.ref = orders.ref)",
        params![key, user_id, anonymous],
    )?;
    Ok(())
}

/// Opens the central server database. A configured connection must never fall back to SQLite.
#[cfg(not(target_os = "android"))]
pub fn open_postgres(url: &str) -> Result<Connection, Box<dyn std::error::Error>> {
    let mut conn = Connection::postgres(url)?;
    // Schema is installed explicitly by the migration, never by an application request.
    let _: i64 = conn.query_row("SELECT COUNT(*) FROM meta", [], |r| r.get(0))?;
    seed_catalog(&mut conn)?;
    Ok(conn)
}
