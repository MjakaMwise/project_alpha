use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    response::Redirect,
    routing::{get, post, put},
};
use crate::database::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};
use tower_http::services::{ServeDir, ServeFile};

mod database;
mod admin;
mod auth;
mod orders;
mod store;

#[derive(Serialize, Deserialize)]
struct Product {
    id: String,
    name: String,
    r#type: String,
    vessel: String,
    description: String,
    price: u32,
    // Real height in centimetres, used to draw the product at true size once a room is scaled.
    height_cm: u32,
    size: String,
    light: String,
    tags: Vec<String>,
    scale: f64,
    // Image path or URL. Products without one use assets/<id>.webp.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    image: Option<String>,
    // Name of the shop selling it, filled in for the shopper catalog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shop: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Shopper {
    previews: HashMap<String, u32>,
    saved: HashSet<String>,
    orders: Vec<Order>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Order {
    id: String,
    product_id: String,
    amount: u32,
    // Whole-cart orders list every line here. Older single-product orders leave it empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    items: Vec<OrderItem>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct OrderItem {
    product_id: String,
    quantity: u32,
}

struct App {
    db: Mutex<Connection>,
    uploads: PathBuf,
    // Failed logins per email address: (count, first failure), for basic rate limiting.
    login_failures: Mutex<HashMap<String, (u32, Instant)>>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Interaction {
    Preview {
        product_id: String,
    },
    Save {
        product_id: String,
        saved: bool,
    },
    DemoOrder {
        product_id: String,
        order_id: String,
        // Checkout details for order tracking. Older clients leave them out.
        #[serde(default)]
        delivery: Option<orders::Delivery>,
    },
    CartOrder {
        items: Vec<OrderItem>,
        order_id: String,
        #[serde(default)]
        delivery: Option<orders::Delivery>,
    },
}

type ApiError = (StatusCode, Json<Value>);

fn error(status: StatusCode, message: &str) -> ApiError {
    (status, Json(json!({ "error": message })))
}

fn valid_id(id: &str) -> bool {
    (12..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// Signed-in shoppers keep their activity under their account instead of the device id.
fn user_key(user_id: i64) -> String {
    format!("user-{user_id}")
}

fn catalog_view(catalog: &[Product], shopper: &Shopper) -> Json<Value> {
    let mut weights = HashMap::new();
    for product in catalog {
        let previews = shopper
            .previews
            .get(&product.id)
            .copied()
            .unwrap_or(0)
            .min(3);
        let saved = u32::from(shopper.saved.contains(&product.id));
        let purchases: u32 = shopper
            .orders
            .iter()
            .map(|order| {
                if order.items.is_empty() {
                    u32::from(order.product_id == product.id)
                } else {
                    order
                        .items
                        .iter()
                        .filter(|item| item.product_id == product.id)
                        .map(|item| item.quantity.min(3))
                        .sum()
                }
            })
            .sum();
        let weight = previews + 4 * saved + 12 * purchases;
        for tag in &product.tags {
            *weights.entry(tag).or_insert(0) += weight;
        }
    }
    let mut products: Vec<_> = catalog.iter().collect();
    products.sort_by_cached_key(|product| {
        std::cmp::Reverse(product.tags.iter().map(|tag| weights[tag]).sum::<u32>())
    });
    let personalized =
        !shopper.saved.is_empty() || !shopper.orders.is_empty() || shopper.previews.len() >= 2;
    // The tag this shopper leans toward most, so the app can say why items are ranked first.
    let top_tag = if personalized {
        weights
            .iter()
            .filter(|(_, weight)| **weight > 0)
            .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
            .map(|(tag, _)| (*tag).clone())
    } else {
        None
    };
    Json(json!({
        "products": products,
        "saved": shopper.saved,
        "orders": shopper.orders,
        "personalized": personalized,
        "top_tag": top_tag
    }))
}

fn product<'a>(catalog: &'a [Product], id: &str) -> Result<&'a Product, ApiError> {
    catalog
        .iter()
        .find(|product| product.id == id)
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Product unavailable."))
}

fn apply(app: &[Product], shopper: &mut Shopper, interaction: Interaction) -> Result<(), ApiError> {
    match interaction {
        Interaction::Preview { product_id } => {
            product(app, &product_id)?;
            let previews = shopper.previews.entry(product_id).or_default();
            *previews = (*previews + 1).min(3);
        }
        Interaction::Save { product_id, saved } => {
            product(app, &product_id)?;
            if saved {
                shopper.saved.insert(product_id);
            } else {
                shopper.saved.remove(&product_id);
            }
        }
        Interaction::DemoOrder {
            product_id,
            order_id,
            ..
        } => {
            let price = product(app, &product_id)?.price;
            if !valid_id(&order_id) {
                return Err(error(StatusCode::BAD_REQUEST, "Invalid order reference."));
            }
            if let Some(existing) = shopper.orders.iter().find(|order| order.id == order_id) {
                if existing.product_id != product_id || !existing.items.is_empty() {
                    return Err(error(StatusCode::CONFLICT, "Order reference already used."));
                }
            } else {
                shopper.orders.push(Order {
                    id: order_id,
                    product_id,
                    amount: price,
                    items: Vec::new(),
                });
            }
        }
        Interaction::CartOrder { items, order_id, .. } => {
            if !valid_id(&order_id) {
                return Err(error(StatusCode::BAD_REQUEST, "Invalid order reference."));
            }
            if items.is_empty() || items.len() > 20 {
                return Err(error(StatusCode::BAD_REQUEST, "Your cart is empty."));
            }
            // Merge repeated lines so the same cart always produces the same order.
            let mut merged: Vec<OrderItem> = Vec::new();
            for item in items {
                if !(1..=99).contains(&item.quantity) {
                    return Err(error(StatusCode::BAD_REQUEST, "Invalid quantity."));
                }
                product(app, &item.product_id)?;
                match merged.iter_mut().find(|line| line.product_id == item.product_id) {
                    Some(line) => line.quantity += item.quantity,
                    None => merged.push(item),
                }
            }
            if let Some(existing) = shopper.orders.iter().find(|order| order.id == order_id) {
                if existing.items != merged {
                    return Err(error(StatusCode::CONFLICT, "Order reference already used."));
                }
            } else {
                let mut amount = 0;
                for line in &merged {
                    amount += product(app, &line.product_id)?.price * line.quantity;
                }
                shopper.orders.push(Order {
                    id: order_id,
                    product_id: merged[0].product_id.clone(),
                    amount,
                    items: merged,
                });
            }
        }
    }
    Ok(())
}

/// The products and activity record for this request: the account's when signed in, else the device's.
fn shopper_context(conn: &Connection, headers: &HeaderMap, id: &str) -> Result<(Vec<Product>, String), ApiError> {
    if !valid_id(id) {
        return Err(error(StatusCode::BAD_REQUEST, "Invalid session."));
    }
    let key = match auth::session_user(conn, headers) {
        Some(user) => user_key(user.id),
        None => id.to_string(),
    };
    Ok((store::active_products(conn).map_err(auth::db_error)?, key))
}

async fn catalog(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let conn = app.db.lock().expect("db lock");
    let (products, key) = shopper_context(&conn, &headers, &id)?;
    let shopper = store::load_shopper(&conn, &key).map_err(auth::db_error)?;
    Ok(catalog_view(&products, &shopper))
}

async fn record(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(interaction): Json<Interaction>,
) -> Result<Json<Value>, ApiError> {
    let mut db = app.db.lock().expect("db lock");
    let conn = db.transaction().map_err(auth::db_error)?;
    let (products, key) = shopper_context(&conn, &headers, &id)?;
    // Checkout details are checked before anything is saved.
    let checkout = match &interaction {
        Interaction::DemoOrder { order_id, delivery, .. } | Interaction::CartOrder { order_id, delivery, .. } => Some((
            order_id.clone(),
            match delivery {
                Some(details) => details.validated()?,
                None => orders::Delivery::default(),
            },
        )),
        _ => None,
    };
    // Changes are only written once the whole interaction is valid.
    let mut shopper = store::load_shopper(&conn, &key).map_err(auth::db_error)?;
    apply(&products, &mut shopper, interaction)?;
    let saved = store::save_shopper(&conn, &key, &shopper).and_then(|()| match &checkout {
        Some((order_ref, delivery)) => orders::record_checkout(&conn, &key, &shopper, order_ref, delivery),
        None => Ok(()),
    });
    saved.map_err(|cause| {
        eprintln!("Could not persist shopper history: {cause}");
        error(StatusCode::INTERNAL_SERVER_ERROR, "Could not save your activity. Try again.")
    })?;
    conn.commit().map_err(auth::db_error)?;
    Ok(catalog_view(&products, &shopper))
}

/// `legacy_json` is the old shoppers.json path. The database lives next to it as customize.db,
/// and uploaded product images in uploads/.
#[cfg(test)]
fn router_with(
    root: PathBuf,
    legacy_json: PathBuf,
    admin: Option<(String, String)>,
) -> Result<Router, Box<dyn std::error::Error>> {
    router_with_database(root, legacy_json, admin, None)
}

fn router_with_database(
    root: PathBuf,
    legacy_json: PathBuf,
    admin: Option<(String, String)>,
    database_url: Option<&str>,
) -> Result<Router, Box<dyn std::error::Error>> {
    let data = legacy_json.parent().map(PathBuf::from).unwrap_or_default();
    #[cfg(not(target_os = "android"))]
    let conn = match database_url {
        Some(url) if !url.trim().is_empty() => store::open_postgres(url)?,
        Some(_) => return Err("CUSTOMIZE_DATABASE_URL is empty".into()),
        None => store::open(&data.join("customize.db"), &legacy_json)?,
    };
    #[cfg(target_os = "android")]
    let conn = { let _ = database_url; store::open(&data.join("customize.db"), &legacy_json)? };
    auth::ensure_admin(&conn, admin)?;
    let uploads = data.join("uploads");
    let app = Arc::new(App {
        db: Mutex::new(conn),
        uploads: uploads.clone(),
        login_failures: Mutex::new(HashMap::new()),
    });
    let mut router = Router::new()
        .route(
            "/",
            get(|| async { axum::response::Html(include_str!("../index.html")) }),
        )
        .route("/api/catalog/{id}", get(catalog))
        .route("/api/activity/{id}", post(record))
        .route("/api/auth/signup", post(auth::signup))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/me", get(auth::me))
        .route("/api/admin/shops", get(admin::list_shops).post(admin::create_shop))
        .route("/api/admin/shops/{id}", put(admin::update_shop).delete(admin::delete_shop))
        .route("/api/admin/shops/{id}/products", get(admin::list_products).post(admin::create_product))
        .route("/api/admin/products/{id}", put(admin::update_product).delete(admin::delete_product))
        .route("/api/orders/mine/{shopper}", get(orders::mine))
        .route("/api/orders/lookup", post(orders::lookup))
        .route("/api/orders/{number}/cancel", post(orders::cancel))
        .route("/api/admin/orders", get(orders::admin_list))
        .route("/api/admin/orders/{id}", get(orders::admin_get).put(orders::admin_update))
        .route("/api/admin/users", get(admin::list_users))
        .route("/api/admin/users/{id}", put(admin::update_user))
        .route(
            "/api/admin/uploads",
            post(admin::upload).layer(DefaultBodyLimit::max(5 * 1024 * 1024)),
        )
        .route("/login", get(|| async { Redirect::to("/auth.html") }))
        .route("/signup", get(|| async { Redirect::to("/auth.html?mode=signup") }))
        .route("/admin", get(|| async { Redirect::to("/admin.html") }))
        .nest_service("/assets", ServeDir::new(root.join("assets")))
        .nest_service("/uploads", ServeDir::new(uploads));
    // Every page file is listed here and in android/app/build.gradle (packageShowroom).
    for file in ["style.css", "app.js", "api.js", "auth.html", "auth.js", "admin.html", "admin.js", "pages.css"] {
        router = router.route_service(&format!("/{file}"), ServeFile::new(root.join(file)));
    }
    Ok(router.with_state(app))
}

fn router(root: PathBuf, legacy_json: PathBuf) -> Result<Router, Box<dyn std::error::Error>> {
    let admin = match (
        std::env::var("CUSTOMIZE_ADMIN_EMAIL"),
        std::env::var("CUSTOMIZE_ADMIN_PASSWORD"),
    ) {
        (Ok(email), Ok(password)) if !email.is_empty() && !password.is_empty() => Some((email, password)),
        _ => None,
    };
    let database_url = std::env::var("CUSTOMIZE_DATABASE_URL").ok();
    router_with_database(root, legacy_json, admin, database_url.as_deref())
}

pub async fn run(
    root: PathBuf,
    database: PathBuf,
    port: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    let router = router(root, database)?;
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}")).await?;
    println!("Customize is running at http://{}", listener.local_addr()?);
    axum::serve(listener, router).await?;
    Ok(())
}


#[cfg(target_os = "android")]
mod android {
    use super::*;
    use jni::{
        JNIEnv,
        objects::{JClass, JString},
    };
    use std::sync::OnceLock;

    // One server per Android process, retained across Activity recreation.
    static STARTED: OnceLock<Mutex<bool>> = OnceLock::new();

    fn start(root: PathBuf, database: PathBuf) -> Result<(), String> {
        let mut started = STARTED
            .get_or_init(|| Mutex::new(false))
            .lock()
            .map_err(|e| e.to_string())?;
        if *started {
            return Ok(());
        }
        let app = router(root, database).map_err(|e| e.to_string())?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        let socket = std::net::TcpListener::bind(("127.0.0.1", 4175)).map_err(|e| e.to_string())?;
        socket.set_nonblocking(true).map_err(|e| e.to_string())?;
        let listener = {
            let _guard = runtime.enter();
            tokio::net::TcpListener::from_std(socket).map_err(|e| e.to_string())?
        };
        std::thread::Builder::new()
            .name("customize-server".into())
            .spawn(move || {
                if let Err(error) = runtime.block_on(async { axum::serve(listener, app).await }) {
                    eprintln!("Customize server stopped: {error}");
                }
            })
            .map_err(|e| e.to_string())?;
        *started = true;
        Ok(())
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_com_casini_customize_LocalServer_startNative(
        mut env: JNIEnv,
        _class: JClass,
        root: JString,
        database: JString,
    ) {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let root: String = env.get_string(&root).map_err(|e| e.to_string())?.into();
            let database: String = env.get_string(&database).map_err(|e| e.to_string())?.into();
            start(PathBuf::from(root), PathBuf::from(database))
        }))
        .unwrap_or_else(|_| Err("Local server initialization failed".into()));
        if let Err(message) = result {
            let _ = env.throw_new("java/lang/IllegalStateException", message);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_app() -> Vec<Product> {
        serde_json::from_str(include_str!("catalog.json")).expect("catalog")
    }

    fn interaction(value: Value) -> Interaction {
        serde_json::from_value(value).expect("interaction")
    }

    fn ids(view: &Value) -> Vec<String> {
        view["products"]
            .as_array()
            .expect("products")
            .iter()
            .map(|product| product["id"].as_str().expect("id").to_string())
            .collect()
    }

    #[test]
    fn every_product_has_a_real_height() {
        let app = test_app();
        assert!(app.iter().all(|product| (5..=300).contains(&product.height_cm)));
    }

    #[test]
    fn new_shopper_sees_catalog_order() {
        let app = test_app();
        let view = catalog_view(&app, &Shopper::default()).0;
        let expected_ids: Vec<String> = app.iter().map(|p| p.id.clone()).collect();
        assert_eq!(ids(&view), expected_ids);
        assert_eq!(view["personalized"], false);
        assert!(view["top_tag"].is_null());
    }

    #[test]
    fn saving_a_product_moves_similar_items_first() {
        let app = test_app();
        let mut shopper = Shopper::default();
        apply(&app, &mut shopper, interaction(json!({"kind": "save", "product_id": "calla", "saved": true}))).ok().expect("save");
        let view = catalog_view(&app, &shopper).0;
        let order = ids(&view);
        assert_eq!(order[0], "calla");
        // Orchid shares the "sculptural" tag, so it follows the callas.
        assert_eq!(order[1], "orchid");
        assert_eq!(view["personalized"], true);
        assert!(view["top_tag"].is_string());
    }

    #[test]
    fn unsaving_removes_the_product() {
        let app = test_app();
        let mut shopper = Shopper::default();
        apply(&app, &mut shopper, interaction(json!({"kind": "save", "product_id": "fern", "saved": true}))).ok().expect("save");
        apply(&app, &mut shopper, interaction(json!({"kind": "save", "product_id": "fern", "saved": false}))).ok().expect("unsave");
        assert!(shopper.saved.is_empty());
    }

    #[test]
    fn repeating_an_order_reference_is_idempotent_for_the_same_product() {
        let app = test_app();
        let mut shopper = Shopper::default();
        let order = json!({"kind": "demo_order", "product_id": "tulips", "order_id": "order-0001-aaaa"});
        apply(&app, &mut shopper, interaction(order.clone())).ok().expect("first");
        apply(&app, &mut shopper, interaction(order)).ok().expect("repeat");
        assert_eq!(shopper.orders.len(), 1);
    }

    #[test]
    fn an_order_reference_cannot_be_reused_for_another_product() {
        let app = test_app();
        let mut shopper = Shopper::default();
        apply(&app, &mut shopper, interaction(json!({"kind": "demo_order", "product_id": "tulips", "order_id": "order-0001-aaaa"}))).ok().expect("first");
        let clash = apply(&app, &mut shopper, interaction(json!({"kind": "demo_order", "product_id": "fern", "order_id": "order-0001-aaaa"})));
        assert_eq!(clash.err().expect("conflict").0, StatusCode::CONFLICT);
        assert_eq!(shopper.orders.len(), 1);
    }

    #[test]
    fn cart_order_totals_every_line() {
        let app = test_app();
        let mut shopper = Shopper::default();
        let order = json!({"kind": "cart_order", "order_id": "order-0002-bbbb", "items": [
            {"product_id": "orchid", "quantity": 1},
            {"product_id": "calla", "quantity": 2},
            {"product_id": "orchid", "quantity": 1}
        ]});
        apply(&app, &mut shopper, interaction(order)).ok().expect("cart order");
        assert_eq!(shopper.orders.len(), 1);
        assert_eq!(shopper.orders[0].amount, 4200 * 2 + 3600 * 2);
        assert_eq!(shopper.orders[0].items.len(), 2);
    }

    #[test]
    fn cart_order_rejects_empty_unknown_and_bad_quantities() {
        let app = test_app();
        let mut shopper = Shopper::default();
        for items in [json!([]), json!([{"product_id": "nope", "quantity": 1}]), json!([{"product_id": "fern", "quantity": 0}])] {
            let result = apply(&app, &mut shopper, interaction(json!({"kind": "cart_order", "order_id": "order-0003-cccc", "items": items})));
            assert!(result.is_err());
        }
        assert!(shopper.orders.is_empty());
    }

    #[test]
    fn cart_order_purchases_outweigh_previews() {
        let app = test_app();
        let mut shopper = Shopper::default();
        apply(&app, &mut shopper, interaction(json!({"kind": "cart_order", "order_id": "order-0004-dddd", "items": [{"product_id": "fern", "quantity": 1}]}))).ok().expect("order");
        assert_eq!(ids(&catalog_view(&app, &shopper).0)[0], "fern");
    }

    #[test]
    fn old_orders_without_items_still_load() {
        let order: Order = serde_json::from_str(r#"{"id":"x","product_id":"tulips","amount":3100}"#).expect("old order");
        assert!(order.items.is_empty());
    }

    /* ---------- HTTP: accounts, admin, shops ---------- */

    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    struct Server {
        router: Router,
        dir: PathBuf,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn server(name: &str) -> Server {
        let dir = std::env::temp_dir().join(format!("customize-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let router = router_with(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            dir.join("shoppers.json"),
            Some(("admin@example.com".into(), "admin-password".into())),
        )
        .expect("router");
        Server { router, dir }
    }

    async fn call(server: &Server, method: &str, path: &str, cookie: Option<&str>, body: Option<Value>) -> (StatusCode, Option<String>, Value) {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        let request = match body {
            Some(body) => request.header("content-type", "application/json").body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        }
        .expect("request");
        let response = server.router.clone().oneshot(request).await.expect("response");
        let status = response.status();
        let cookie = response
            .headers()
            .get("set-cookie")
            .map(|value| value.to_str().expect("cookie").split(';').next().expect("pair").to_string());
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20).await.expect("body");
        (status, cookie, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn login(server: &Server, email: &str, password: &str) -> String {
        let (status, cookie, _) = call(server, "POST", "/api/auth/login", None, Some(json!({"email": email, "password": password}))).await;
        assert_eq!(status, StatusCode::OK);
        cookie.expect("session cookie")
    }

    #[tokio::test]
    async fn signup_me_logout_and_login() {
        let server = server("signup");
        let (status, cookie, body) = call(&server, "POST", "/api/auth/signup", None, Some(json!({"name": "Amani", "email": "Amani@Example.com", "password": "green-leaves"}))).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["user"]["email"], "amani@example.com");
        assert_eq!(body["user"]["role"], "shopper");
        assert!(body["user"].get("password_hash").is_none());
        let cookie = cookie.expect("cookie");

        let (_, _, me) = call(&server, "GET", "/api/auth/me", Some(&cookie), None).await;
        assert_eq!(me["user"]["name"], "Amani");

        let (status, _, _) = call(&server, "POST", "/api/auth/signup", None, Some(json!({"name": "Again", "email": "amani@example.com", "password": "another-pass"}))).await;
        assert_eq!(status, StatusCode::CONFLICT);

        let (status, cleared, _) = call(&server, "POST", "/api/auth/logout", Some(&cookie), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(cleared.as_deref(), Some("customize_session="));
        let (_, _, me) = call(&server, "GET", "/api/auth/me", Some(&cookie), None).await;
        assert!(me["user"].is_null(), "old session no longer works");

        login(&server, "amani@example.com", "green-leaves").await;
    }

    #[tokio::test]
    async fn signup_rejects_bad_input() {
        let server = server("bad-input");
        for body in [
            json!({"name": "", "email": "a@b.co", "password": "long-enough"}),
            json!({"name": "A", "email": "not-an-email", "password": "long-enough"}),
            json!({"name": "A", "email": "a@b.co", "password": "short"}),
        ] {
            let (status, cookie, _) = call(&server, "POST", "/api/auth/signup", None, Some(body)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert!(cookie.is_none());
        }
    }

    #[tokio::test]
    async fn wrong_password_is_generic_and_rate_limited() {
        let server = server("wrong-password");
        call(&server, "POST", "/api/auth/signup", None, Some(json!({"name": "Wanjiru", "email": "w@example.com", "password": "right-password"}))).await;
        let (status, cookie, wrong) = call(&server, "POST", "/api/auth/login", None, Some(json!({"email": "w@example.com", "password": "wrong-password"}))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(cookie.is_none());
        let (_, _, unknown) = call(&server, "POST", "/api/auth/login", None, Some(json!({"email": "nobody@example.com", "password": "wrong-password"}))).await;
        assert_eq!(wrong["error"], unknown["error"], "same message for unknown email and wrong password");
        for _ in 0..4 {
            call(&server, "POST", "/api/auth/login", None, Some(json!({"email": "w@example.com", "password": "nope-nope"}))).await;
        }
        let (status, _, _) = call(&server, "POST", "/api/auth/login", None, Some(json!({"email": "w@example.com", "password": "right-password"}))).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn admin_api_needs_an_admin() {
        let server = server("admin-only");
        let (status, _, _) = call(&server, "GET", "/api/admin/shops", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (_, shopper, _) = call(&server, "POST", "/api/auth/signup", None, Some(json!({"name": "Shopper", "email": "s@example.com", "password": "shopper-pass"}))).await;
        let shopper = shopper.expect("cookie");
        for (method, path, body) in [
            ("GET", "/api/admin/shops", None),
            ("POST", "/api/admin/shops", Some(json!({"name": "Sneaky"}))),
            ("GET", "/api/admin/users", None),
            ("PUT", "/api/admin/users/2", Some(json!({"role": "admin"}))),
        ] {
            let (status, _, _) = call(&server, method, path, Some(&shopper), body).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
        }
        let admin = login(&server, "admin@example.com", "admin-password").await;
        let (status, _, body) = call(&server, "GET", "/api/admin/shops", Some(&admin), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["shops"][0]["slug"], "casini", "the original catalog lives in the CASINI shop");
        // The only admin cannot demote themselves.
        let (status, _, _) = call(&server, "PUT", "/api/admin/users/1", Some(&admin), Some(json!({"role": "shopper"}))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn shop_and_product_crud_reaches_the_catalog() {
        let server = server("shop-crud");
        let admin = login(&server, "admin@example.com", "admin-password").await;
        let shopper_id = "shopper-test-0001";
        let catalog_ids = |view: &Value| ids(view);

        let (_, owner, me) = call(&server, "POST", "/api/auth/signup", None, Some(json!({"name": "Owner", "email": "owner@example.com", "password": "owner-pass"}))).await;
        drop(owner);
        let owner_id = me["user"]["id"].as_i64().expect("id");

        let (status, _, shop) = call(&server, "POST", "/api/admin/shops", Some(&admin), Some(json!({"name": "Nairobi Greens", "description": "Ferns and palms", "owner_id": owner_id}))).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(shop["slug"], "nairobi-greens");
        assert_eq!(shop["owner"]["email"], "owner@example.com");
        let shop_id = shop["id"].as_i64().expect("shop id");
        let (status, _, _) = call(&server, "POST", "/api/admin/shops", Some(&admin), Some(json!({"name": "Nairobi Greens"}))).await;
        assert_eq!(status, StatusCode::CONFLICT, "slug must be unique");

        let (_, _, users) = call(&server, "GET", "/api/admin/users?q=owner", Some(&admin), None).await;
        assert_eq!(users["users"][0]["role"], "shop_owner", "assigned owners become shop owners");

        let (status, _, product) = call(&server, "POST", &format!("/api/admin/shops/{shop_id}/products"), Some(&admin), Some(json!({
            "name": "Kentia Palm", "type": "Plants", "price": 5400, "height_cm": 80, "tags": ["Green", "palm"], "image": "assets/parlor_palm.webp"
        }))).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(product["id"], "kentia_palm");
        assert_eq!(product["size"], "80 cm tall");
        assert_eq!(product["tags"], json!(["green", "palm"]));

        let (status, _, _) = call(&server, "POST", &format!("/api/admin/shops/{shop_id}/products"), Some(&admin), Some(json!({"name": "Bad", "type": "Plants", "price": 0, "height_cm": 80}))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let (_, _, view) = call(&server, "GET", &format!("/api/catalog/{shopper_id}"), None, None).await;
        assert!(catalog_ids(&view).contains(&"kentia_palm".to_string()));
        assert!(catalog_ids(&view).contains(&"orchid".to_string()));

        let (status, _, edited) = call(&server, "PUT", "/api/admin/products/kentia_palm", Some(&admin), Some(json!({"name": "Kentia Palm", "type": "Plants", "price": 4900, "height_cm": 80}))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(edited["price"], 4900);

        // A shopper can save and order the new product.
        let (status, _, _) = call(&server, "POST", &format!("/api/activity/{shopper_id}"), None, Some(json!({"kind": "save", "product_id": "kentia_palm", "saved": true}))).await;
        assert_eq!(status, StatusCode::OK);

        // Suspending hides the shop's products.
        let (status, _, _) = call(&server, "PUT", &format!("/api/admin/shops/{shop_id}"), Some(&admin), Some(json!({"name": "Nairobi Greens", "slug": "nairobi-greens", "owner_id": owner_id, "status": "suspended"}))).await;
        assert_eq!(status, StatusCode::OK);
        let (_, _, view) = call(&server, "GET", &format!("/api/catalog/{shopper_id}"), None, None).await;
        assert!(!catalog_ids(&view).contains(&"kentia_palm".to_string()));

        let (status, _, _) = call(&server, "DELETE", "/api/admin/products/kentia_palm", Some(&admin), None).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, _) = call(&server, "DELETE", &format!("/api/admin/shops/{shop_id}"), Some(&admin), None).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, _) = call(&server, "DELETE", &format!("/api/admin/shops/{shop_id}"), Some(&admin), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn signing_in_keeps_device_activity() {
        let server = server("adopt");
        let device = "device-test-0001";
        call(&server, "POST", &format!("/api/activity/{device}"), None, Some(json!({"kind": "save", "product_id": "fern", "saved": true}))).await;
        let (_, cookie, _) = call(&server, "POST", "/api/auth/signup", None, Some(json!({"name": "Baraka", "email": "b@example.com", "password": "baraka-pass", "shopper": device}))).await;
        let cookie = cookie.expect("cookie");
        // Any device id now shows the account's saves while signed in.
        let (_, _, view) = call(&server, "GET", "/api/catalog/other-device-0002", Some(&cookie), None).await;
        assert_eq!(view["saved"], json!(["fern"]));
        let (_, _, anonymous) = call(&server, "GET", &format!("/api/catalog/{device}"), None, None).await;
        assert_eq!(anonymous["saved"], json!([]));
    }

    #[test]
    fn old_shoppers_json_is_imported_once() {
        let dir = std::env::temp_dir().join(format!("customize-test-{}-import", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let legacy = dir.join("shoppers.json");
        std::fs::write(&legacy, r#"{"legacy-shopper-01":{"previews":{},"saved":["calla"],"orders":[]}}"#).expect("write");
        let conn = store::open(&dir.join("customize.db"), &legacy).expect("open");
        assert!(store::load_shopper(&conn, "legacy-shopper-01").expect("load").saved.contains("calla"));
        assert!(!legacy.exists(), "old file is renamed after import");
        assert!(dir.join("shoppers.json.migrated").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ---------- orders ---------- */

    fn delivery() -> Value {
        json!({"name": "Amani", "phone": "0712 345 678", "address": "Westlands, Nairobi", "note": "Gate B"})
    }

    async fn place(server: &Server, shopper: &str, cookie: Option<&str>, order_ref: &str) -> (StatusCode, Value) {
        let (status, _, body) = call(server, "POST", &format!("/api/activity/{shopper}"), cookie, Some(json!({
            "kind": "cart_order", "order_id": order_ref,
            "items": [{"product_id": "orchid", "quantity": 2}, {"product_id": "fern", "quantity": 1}],
            "delivery": delivery()
        }))).await;
        (status, body)
    }

    #[tokio::test]
    async fn checkout_creates_a_tracked_order() {
        let server = server("orders-create");
        let shopper = "device-order-0001";
        let (status, _) = place(&server, shopper, None, "order-ref-0001").await;
        assert_eq!(status, StatusCode::OK);
        // Repeating the same checkout does not create a second order.
        place(&server, shopper, None, "order-ref-0001").await;
        let (_, _, mine) = call(&server, "GET", &format!("/api/orders/mine/{shopper}"), None, None).await;
        let orders = mine["orders"].as_array().expect("orders");
        assert_eq!(orders.len(), 1);
        let order = &orders[0];
        assert_eq!(order["number"], "CU-000001");
        assert_eq!(order["status"], "placed");
        assert_eq!(order["total"], 4200 * 2 + 2800);
        assert_eq!(order["customer"]["address"], "Westlands, Nairobi");
        assert_eq!(order["items"][0]["shop_name"], "CASINI");
        assert_eq!(order["events"][0]["status"], "placed");
        // Another device does not see it.
        let (_, _, other) = call(&server, "GET", "/api/orders/mine/device-order-0002", None, None).await;
        assert_eq!(other["orders"], json!([]));
    }

    #[tokio::test]
    async fn checkout_rejects_bad_delivery_details() {
        let server = server("orders-bad");
        for (field, value) in [("name", ""), ("phone", "12"), ("address", "")] {
            let mut details = delivery();
            details[field] = json!(value);
            let (status, _, _) = call(&server, "POST", "/api/activity/device-order-0003", None, Some(json!({
                "kind": "cart_order", "order_id": "order-ref-0003", "items": [{"product_id": "fern", "quantity": 1}], "delivery": details
            }))).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{field}");
        }
        let (_, _, mine) = call(&server, "GET", "/api/orders/mine/device-order-0003", None, None).await;
        assert_eq!(mine["orders"], json!([]), "nothing is saved when details are invalid");
    }

    #[tokio::test]
    async fn guests_look_up_orders_by_number_and_phone() {
        let server = server("orders-lookup");
        place(&server, "device-order-0004", None, "order-ref-0004").await;
        let (status, _, order) = call(&server, "POST", "/api/orders/lookup", None, Some(json!({"number": "cu-000001", "phone": "+254 712 345678"}))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(order["number"], "CU-000001");
        let (status, _, _) = call(&server, "POST", "/api/orders/lookup", None, Some(json!({"number": "CU-000001", "phone": "0799 999 999"}))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn shoppers_cancel_only_while_placed_and_only_their_own() {
        let server = server("orders-cancel");
        place(&server, "device-order-0005", None, "order-ref-0005").await;
        place(&server, "device-order-0005", None, "order-ref-0006").await;
        let (status, _, _) = call(&server, "POST", "/api/orders/CU-000001/cancel", None, Some(json!({"shopper": "device-order-9999"}))).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "someone else's order");
        let (status, _, order) = call(&server, "POST", "/api/orders/CU-000001/cancel", None, Some(json!({"shopper": "device-order-0005"}))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(order["status"], "cancelled");
        let admin = login(&server, "admin@example.com", "admin-password").await;
        call(&server, "PUT", "/api/admin/orders/2", Some(&admin), Some(json!({"status": "confirmed"}))).await;
        let (status, _, _) = call(&server, "POST", "/api/orders/CU-000002/cancel", None, Some(json!({"shopper": "device-order-0005"}))).await;
        assert_eq!(status, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn admins_move_orders_through_each_status() {
        let server = server("orders-admin");
        place(&server, "device-order-0007", None, "order-ref-0007").await;
        let (status, _, _) = call(&server, "GET", "/api/admin/orders", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let admin = login(&server, "admin@example.com", "admin-password").await;
        let (_, _, list) = call(&server, "GET", "/api/admin/orders?status=placed", Some(&admin), None).await;
        assert_eq!(list["counts"]["new"], 1);
        assert_eq!(list["orders"][0]["customer"]["phone"], "0712 345 678");
        // Skipping a step is refused.
        let (status, _, _) = call(&server, "PUT", "/api/admin/orders/1", Some(&admin), Some(json!({"status": "delivered"}))).await;
        assert_eq!(status, StatusCode::CONFLICT);
        for next in ["confirmed", "preparing", "out_for_delivery", "delivered"] {
            let (status, _, order) = call(&server, "PUT", "/api/admin/orders/1", Some(&admin), Some(json!({"status": next, "note": "ok"}))).await;
            assert_eq!(status, StatusCode::OK, "{next}");
            assert_eq!(order["status"], next);
        }
        let (status, _, _) = call(&server, "PUT", "/api/admin/orders/1", Some(&admin), Some(json!({"status": "cancelled"}))).await;
        assert_eq!(status, StatusCode::CONFLICT, "delivered orders are final");
        let (_, _, order) = call(&server, "GET", "/api/admin/orders/1", Some(&admin), None).await;
        assert_eq!(order["events"].as_array().expect("events").len(), 5);
        assert_eq!(order["events"][4]["actor"], "admin:admin@example.com");
        let (_, _, found) = call(&server, "GET", "/api/admin/orders?q=0712345678", Some(&admin), None).await;
        assert_eq!(found["orders"].as_array().expect("orders").len(), 1, "search by phone");
        let (_, _, filtered) = call(&server, "GET", "/api/admin/orders?shop=999", Some(&admin), None).await;
        assert_eq!(filtered["orders"], json!([]));
    }

    #[tokio::test]
    async fn signed_in_orders_follow_the_account() {
        let server = server("orders-account");
        place(&server, "device-order-0008", None, "order-ref-0008").await;
        let (_, cookie, _) = call(&server, "POST", "/api/auth/signup", None, Some(json!({"name": "Baraka", "email": "b@example.com", "password": "baraka-pass", "shopper": "device-order-0008"}))).await;
        let cookie = cookie.expect("cookie");
        place(&server, "device-order-0009", Some(&cookie), "order-ref-0009").await;
        let (_, _, mine) = call(&server, "GET", "/api/orders/mine/device-order-0009", Some(&cookie), None).await;
        assert_eq!(mine["orders"].as_array().expect("orders").len(), 2, "device order moved into the account, new one added");
    }

    #[test]
    fn old_demo_orders_are_moved_into_tracking() {
        let dir = std::env::temp_dir().join(format!("customize-test-{}-orders-import", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let legacy = dir.join("shoppers.json");
        std::fs::write(&legacy, r#"{"legacy-shopper-02":{"previews":{},"saved":[],"orders":[{"id":"old-order-0001","product_id":"tulips","amount":3100}]}}"#).expect("write");
        let conn = store::open(&dir.join("customize.db"), &legacy).expect("open");
        let (status, total, item): (String, i64, String) = conn
            .query_row("SELECT o.status, o.total, i.name FROM orders o JOIN order_items i ON i.order_id = o.id", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .expect("migrated order");
        assert_eq!((status.as_str(), total, item.as_str()), ("placed", 3100, "Apricot Tulips"));
        drop(conn);
        // Opening again does not duplicate it.
        let conn = store::open(&dir.join("customize.db"), &legacy).expect("reopen");
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0)).expect("count");
        assert_eq!(count, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
    /// Run only against a disposable database with the migration installed and empty tables.
    #[cfg(not(target_os = "android"))]
    #[tokio::test]
    #[ignore = "requires CUSTOMIZE_TEST_DATABASE_URL pointing to an empty disposable PostgreSQL database"]
    async fn postgres_central_database_roundtrip() {
        let url = std::env::var("CUSTOMIZE_TEST_DATABASE_URL").expect("test database URL");
        let dir = std::env::temp_dir().join(format!("customize-pg-http-{}", std::process::id()));
        let make = || router_with_database(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")), dir.join("shoppers.json"),
            Some(("admin@example.com".into(), "admin-password".into())), Some(&url),
        ).expect("PostgreSQL router");
        let server = Server { router: make(), dir: dir.clone() };
        let device = "postgres-device-0001";
        let (status, _, _) = call(&server, "POST", &format!("/api/activity/{device}"), None,
            Some(json!({"kind":"save","product_id":"fern","saved":true}))).await;
        assert_eq!(status, StatusCode::OK);
        let (status, cookie, _) = call(&server, "POST", "/api/auth/signup", None,
            Some(json!({"name":"Amani","email":"PG@Example.com","password":"postgres-test-password","shopper":device}))).await;
        assert_eq!(status, StatusCode::CREATED);
        let cookie = cookie.unwrap();
        let (status, _, _) = call(&server, "POST", "/api/auth/signup", None,
            Some(json!({"name":"Again","email":"pg@example.com","password":"postgres-test-password"}))).await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, _, _) = call(&server, "GET", "/api/admin/users", Some(&cookie), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = place(&server, device, Some(&cookie), "postgres-order-0001").await;
        assert_eq!(status, StatusCode::OK);
        place(&server, device, Some(&cookie), "postgres-order-0001").await;
        // A second independent application connection sees the same sessions, saves and orders.
        let other = Server { router: make(), dir: dir.clone() };
        let (_, _, catalog) = call(&other, "GET", "/api/catalog/another-device-0001", Some(&cookie), None).await;
        assert_eq!(catalog["saved"], json!(["fern"]));
        let (_, _, mine) = call(&other, "GET", &format!("/api/orders/mine/{device}"), Some(&cookie), None).await;
        assert_eq!(mine["orders"].as_array().unwrap().len(), 1);
        let admin = login(&other, "admin@example.com", "admin-password").await;
        let (status, _, orders) = call(&other, "GET", "/api/admin/orders?status=placed&q=Amani", Some(&admin), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(orders["orders"].as_array().unwrap().len(), 1);
        let id = mine["orders"][0]["id"].as_i64().unwrap();
        let (status, _, _) = call(&other, "PUT", &format!("/api/admin/orders/{id}"), Some(&admin), Some(json!({"status":"confirmed"}))).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, _) = call(&other, "GET", "/api/admin/shops", Some(&admin), None).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, _) = call(&other, "POST", "/api/auth/logout", Some(&cookie), None).await;
        assert_eq!(status, StatusCode::OK);
        let (_, _, me) = call(&server, "GET", "/api/auth/me", Some(&cookie), None).await;
        assert!(me["user"].is_null());
    }

}
