// Customize works without a server. This file does what the Rust backend did, in the browser:
// it ranks products for "Picked for you" and remembers saves, previews and demo orders on this device.
// To use the Rust server instead, open the page with ?backend=server (or run
// localStorage.setItem('customize-backend','server') once). Both give the same answers.
(function () {
  const CATALOG = [{"id":"orchid","name":"White Orchid","type":"Plants","vessel":"Charcoal stoneware","description":"Arching white blooms and glossy leaves in a dark, textured pot.","price":4200,"height_cm":48,"size":"48 cm tall","light":"Bright indirect light","tags":["white","sculptural","stoneware"],"scale":0.35},{"id":"tulips","name":"Apricot Tulips","type":"Flowers","vessel":"Fluted ivory vase","description":"Soft apricot stems arranged in a low, fluted ceramic vase.","price":3100,"height_cm":32,"size":"32 cm tall","light":"Keep in a cool spot","tags":["peach","soft","ceramic"],"scale":0.28},{"id":"fern","name":"Boston Fern","type":"Plants","vessel":"Matte terracotta pot","description":"Feathery green fronds spill over a low terracotta pot.","price":2800,"height_cm":30,"size":"38 cm wide","light":"Indirect light","tags":["green","soft","terracotta"],"scale":0.25},{"id":"calla","name":"Burgundy Callas","type":"Flowers","vessel":"Tall bone ceramic vase","description":"Wine-dark calla lilies with clean stems and a tall ceramic vase.","price":3600,"height_cm":42,"size":"42 cm tall","light":"Keep in a cool spot","tags":["burgundy","sculptural","ceramic"],"scale":0.32}];
  const KEY = 'customize-shopper-state';
  const validId = (id) => /^[A-Za-z0-9-]{12,64}$/.test(id);
  const fail = (status, message) => Object.assign(new Error(message), { status });

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
  }
  function blank(state) {
    return { previews: state.previews || {}, saved: state.saved || [], orders: state.orders || [] };
  }
  function product(id) {
    const found = CATALOG.find((p) => p.id === id);
    if (!found) throw fail(404, 'Product unavailable.');
    return found;
  }
  function view(s) {
    const weights = {};
    for (const p of CATALOG) {
      const previews = Math.min(s.previews[p.id] || 0, 3);
      const saved = s.saved.includes(p.id) ? 1 : 0;
      let purchases = 0;
      for (const o of s.orders) {
        if (!o.items || !o.items.length) purchases += o.product_id === p.id ? 1 : 0;
        else for (const it of o.items) if (it.product_id === p.id) purchases += Math.min(it.quantity, 3);
      }
      const weight = previews + 4 * saved + 12 * purchases;
      for (const t of p.tags) weights[t] = (weights[t] || 0) + weight;
    }
    const score = (p) => p.tags.reduce((a, t) => a + weights[t], 0);
    const products = CATALOG.map((p, i) => [p, i]).sort((a, b) => score(b[0]) - score(a[0]) || a[1] - b[1]).map((x) => x[0]);
    const personalized = s.saved.length > 0 || s.orders.length > 0 || Object.keys(s.previews).length >= 2;
    let top = null;
    if (personalized) {
      for (const [tag, w] of Object.entries(weights)) {
        if (w > 0 && (top === null || w > weights[top] || (w === weights[top] && tag < top))) top = tag;
      }
    }
    return { products, saved: s.saved, orders: s.orders, personalized, top_tag: top };
  }
  function apply(s, a) {
    if (a.kind === 'preview') {
      product(a.product_id);
      s.previews[a.product_id] = Math.min((s.previews[a.product_id] || 0) + 1, 3);
    } else if (a.kind === 'save') {
      product(a.product_id);
      s.saved = s.saved.filter((id) => id !== a.product_id);
      if (a.saved) s.saved.push(a.product_id);
    } else if (a.kind === 'demo_order') {
      const price = product(a.product_id).price;
      if (!validId(a.order_id)) throw fail(400, 'Invalid order reference.');
      const old = s.orders.find((o) => o.id === a.order_id);
      if (old) { if (old.product_id !== a.product_id || (old.items && old.items.length)) throw fail(409, 'Order reference already used.'); }
      else s.orders.push({ id: a.order_id, product_id: a.product_id, amount: price });
    } else if (a.kind === 'cart_order') {
      if (!validId(a.order_id)) throw fail(400, 'Invalid order reference.');
      if (!a.items || !a.items.length || a.items.length > 20) throw fail(400, 'Your cart is empty.');
      const merged = [];
      for (const it of a.items) {
        if (!Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > 99) throw fail(400, 'Invalid quantity.');
        product(it.product_id);
        const line = merged.find((l) => l.product_id === it.product_id);
        if (line) line.quantity += it.quantity; else merged.push({ product_id: it.product_id, quantity: it.quantity });
      }
      const old = s.orders.find((o) => o.id === a.order_id);
      if (old) { if (JSON.stringify(old.items) !== JSON.stringify(merged)) throw fail(409, 'Order reference already used.'); }
      else s.orders.push({ id: a.order_id, product_id: merged[0].product_id, amount: merged.reduce((t, l) => t + product(l.product_id).price * l.quantity, 0), items: merged });
    } else throw fail(400, 'Unknown activity.');
  }

  // Signing in (auth.html) also switches to the server, so saves and orders follow the account.
  let stored = {};
  try { stored = { backend: localStorage.getItem('customize-backend'), session: localStorage.getItem('customize-session') }; } catch {}
  const useServer = /[?&]backend=server/.test(location.search) || stored.backend === 'server' || stored.session === '1';

  // Order tracking and accounts need the server; pages check this before calling them.
  window.customizeServer = useServer;

  window.customizeApi = async function (path, shopper, activity) {
    if (useServer) {
      const r = await fetch('api/' + path + '/' + shopper, activity && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(activity) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not reach Customize. Try again.');
      return r.json();
    }
    const s = blank(load());
    if (activity) {
      apply(s, activity);
      try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { throw new Error('Could not save your activity. Try again.'); }
    }
    return view(s);
  };
})();
