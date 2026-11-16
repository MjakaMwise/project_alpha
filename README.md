# Customize

Customize is a local, interactive showroom mockup for flowers and indoor plants. The frontend uses plain HTML, CSS, and JavaScript. The Rust service serves the catalog, stores interactions and demo orders, and ranks catalog items using that history.

## Run

From this folder, run `cargo run` and open http://127.0.0.1:4173. Set `PORT` if you need a different port.

## Accounts and shop admin

The Rust server now has accounts, sessions and a shop admin. The Rust server supports the Casini central PostgreSQL database when `CUSTOMIZE_DATABASE_URL` is set (the desktop binary loads `.env`). Without it, data lives in SQLite at `data/customize.db` (set `CUSTOMIZE_DATA` to use another folder). See [central database rollout](supabase/README.md) before importing data or switching the server. On first start the server imports the old `data/shoppers.json` into the database and renames it to `shoppers.json.migrated`. The original catalog in `src/catalog.json` becomes the default shop **CASINI**.

**Create the first admin.** No password is built in. Start the server once with both variables set:

```sh
CUSTOMIZE_ADMIN_EMAIL=you@example.com CUSTOMIZE_ADMIN_PASSWORD='a long password' ./dev.sh -w
```

If no admin exists, this creates one (or makes an existing account with that email an admin, keeping its password). Once an admin exists the variables are ignored, so you can drop them afterwards. The password must be 8–128 characters.

- **Log in / sign up:** http://localhost:4173/auth.html (also `/login`, `/signup`). The **Account** screen links here. New accounts are shoppers. After signing in, the Account screen shows your name and a **Log out** button, and the shop uses the server so saves and orders follow your account. Saves and orders made on the device before signing in move into the account.
- **Shop admin:** http://localhost:4173/admin.html (also `/admin`), admins only. Search, create, edit, suspend and delete shops; assign an owner (a shopper assigned as owner becomes a shop owner); add, edit and remove each shop's products, including uploading a product image (PNG, JPEG or WebP up to 5 MB, stored in `data/uploads/`); list users and change roles. Suspended shops' products are hidden from the shop. You cannot remove your own admin role or the last admin.
- Roles: `shopper`, `shop_owner`, `admin`. Shop owners do not have their own management page yet; admins manage every shop.
- Sessions are random tokens in an httpOnly, SameSite=Lax cookie that lasts 30 days; only a SHA-256 of the token is stored. Passwords are hashed with Argon2. Five failed logins for one email lock it for 15 minutes. The cookie is not marked `Secure` because the app is served over plain http on localhost; add HTTPS and `Secure` before exposing it on a network.

API: `POST /api/auth/signup|login|logout`, `GET /api/auth/me`; admin: `GET/POST /api/admin/shops`, `PUT/DELETE /api/admin/shops/{id}`, `GET/POST /api/admin/shops/{id}/products`, `PUT/DELETE /api/admin/products/{id}`, `GET /api/admin/users`, `PUT /api/admin/users/{id}`, `POST /api/admin/uploads`.

### Orders

Checkout asks for delivery details (name, phone, delivery address or area, optional note) and records an order with a readable number such as `CU-000012`. Payment stays a demo: nothing is charged and no SMS or email is sent.

- **Shoppers:** Account › **My orders** lists their orders; each opens a tracking timeline (Placed → Confirmed → Preparing → Out for delivery → Delivered, or Cancelled) with times and any note from the shop. They can cancel while an order is still Placed. **Track an order** finds any order by its number plus the phone used at checkout (five wrong tries lock that number for 15 minutes). Orders placed before signing in move into the account.
- **Admins:** the **Orders** tab in `admin.html` shows counts (new, in progress, delivered today, all), search by order number, name or phone, and filters by status, shop and date. Opening an order shows items, customer, delivery details and history; **Mark as …** moves it one step forward and **Cancel order** cancels it, both with a confirmation and an optional note recorded in the history. Delivered and cancelled orders are final.
- Demo orders made before order tracking existed are moved in automatically on first start, without delivery details.

API: `GET /api/orders/mine/{shopper}`, `POST /api/orders/lookup`, `POST /api/orders/{number}/cancel`; admin: `GET /api/admin/orders`, `GET/PUT /api/admin/orders/{id}`.

The built-in browser backend (`api.js`, used without `?backend=server`) still works with no login and shows the original four products. Accounts and admin-created products need the Rust server.

## Try the full flow

1. Open **Shop**. Tap the heart on products you like to save them. After a few saves or previews, a "Picked for you" note explains why items are ranked first.
2. Open a product and tap **See it in your room**. Choose a sample room, a saved room, or **Record a room**.
3. Recording has two modes. **Four angles** guides you through up to four photos, one per wall. **Panorama** takes one wide photo from your camera's panorama mode.
4. Tap the photo to place the product. Tap a placed product to open its sheet: change its size, swap it, move it, copy it, remove it, save it, or add it to the cart.
5. In a four-angle room, tap a thumbnail at the bottom or swipe the photo to change angle. The number on a thumbnail is how many products are placed there. In a panorama, drag (or use the arrow keys) to look around.
6. To see true sizes, tap **Set scale**, tap two ends of something in the photo whose length you know (a sofa, a door), and enter its length in cm. Products then draw at their real height from `height_cm` in `src/catalog.json`. Each room angle keeps its own scale. Tap **Scale set ✓** to measure again or clear it.
7. Open **Cart** and choose **Check out** to place one demo order for everything in it.
8. **Rooms** has a menu on each saved room to rename it and its angles, add angles, or delete it. **You** shows your saved items, rooms and orders.

Placement layouts, including each product's size, are saved on the device for each room angle.

Room photos and cart quantities stay on the device in IndexedDB and local storage. The Rust service stores product preview counts, saves, demo orders, accounts and shops in `data/customize.db` (SQLite). Checkout is simulated.

## Test

`cargo test` runs the ranking, save and order tests, plus signup/login/logout, wrong-password and rate-limit, admin-only access, shop and product CRUD, and the shoppers.json import.

## Run on Android

The APK includes the Rust backend, showroom HTML/CSS/JavaScript, and sample images. It runs independently on the device, including offline; no desktop server or ADB port forwarding is needed.

Open the `android` folder in Android Studio and select the **app** run configuration. The build currently uses the Linux x86_64 Android NDK toolchain. Install NDK **30.0.16248370** and Rust, then add the Android Rust targets once:

```sh
rustup target add aarch64-linux-android x86_64-linux-android
```

From the `android` folder, build the sample APK:

```sh
./gradlew :app:assembleDebug
```

The debug-signed APK is at `android/app/build/outputs/apk/debug/app-debug.apk`. It supports ARM64 phones and x86_64 emulators running Android 8.0 or later. Gradle builds the Rust shared libraries and packages the showroom assets automatically.

On launch, the app copies showroom assets into its private storage and starts one Rust server per app process on device loopback port 4175, off the main thread. The WebView loads that local showroom and uses Android's camera and photo picker for photo input. Saves and demo orders stay in the app's private `customize.db` (an older `shoppers.json` is imported on first start), survive app restarts and updates, and are removed when app storage is cleared or the app is uninstalled. Checkout remains a demo.

The desktop `cargo run` workflow above is still available.

## Run it with dev.sh

```sh
./dev.sh -w        # web: Rust server on http://localhost:4173 (uses the Rust backend)
./dev.sh -a        # Android: build, install and launch on an emulator or phone
./dev.sh -w -a     # both at once (also -wa)
```

The page also works without the server. `api.js` ranks products and saves activity in the browser, so `index.html` can be hosted as a static page on desktop or Android. Add `?backend=server` to the address to use the Rust backend instead, which is what `dev.sh -w` opens.
