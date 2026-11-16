'use strict';
// Shop admin: shops, their products, and user roles. Uses the Rust server's /api/admin endpoints (admins only).
(function () {
  const $ = (id) => document.getElementById(id);
  const money = (amount) => 'KSh ' + new Intl.NumberFormat('en-KE').format(amount);
  const date = (seconds) => new Date(seconds * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const roleNames = { shopper: 'Shopper', shop_owner: 'Shop owner', admin: 'Admin' };
  let me = null;
  let shops = [];
  let users = [];
  let selectedShop = null;
  let editingShop = null;
  let editingProduct = null;
  let toastTimer;

  async function api(path, options = {}) {
    const init = { ...options, headers: { ...(options.headers || {}) } };
    if (options.json !== undefined) {
      init.body = JSON.stringify(options.json);
      init.headers['Content-Type'] = 'application/json';
    }
    const response = await fetch('api/' + path, init);
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) { showGate('login'); throw new Error(body.error || 'Please log in.'); }
    if (!response.ok) throw new Error(body.error || 'Something went wrong. Try again.');
    return body;
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    node.append(...children.filter((child) => child !== null && child !== undefined));
    return node;
  }

  function toast(text) {
    const box = $('toast');
    box.textContent = text;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 2600);
  }

  function formError(form, text) {
    const box = form.querySelector('.message');
    box.textContent = text;
    box.hidden = !text;
  }

  function confirmAction(title, text, yes = 'Delete') {
    return new Promise((resolve) => {
      const dialog = $('confirm-dialog');
      $('confirm-title').textContent = title;
      $('confirm-text').textContent = text;
      $('confirm-yes').textContent = yes;
      dialog.returnValue = '';
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true });
      dialog.showModal();
    });
  }

  function showGate(kind) {
    $('console').hidden = true;
    $('gate').hidden = false;
    $('logout').hidden = kind === 'login' || kind === 'offline';
    const link = $('gate-link');
    if (kind === 'login') {
      $('gate-title').textContent = 'Admins only';
      $('gate-text').textContent = 'Log in with an admin account to manage shops.';
      link.textContent = 'Log in';
      link.href = 'auth.html?next=admin';
    } else if (kind === 'forbidden') {
      $('gate-title').textContent = 'Admins only';
      $('gate-text').textContent = 'You are signed in as ' + me.email + ', which is not an admin account.';
      link.textContent = 'Back to the shop';
      link.href = './';
    } else {
      $('gate-title').textContent = 'Server not reachable';
      $('gate-text').textContent = 'The admin page needs the Customize server. Start it with ./dev.sh -w and reload.';
      link.textContent = 'Reload';
      link.href = 'admin.html';
    }
  }

  /* ---------- shops ---------- */

  function renderShops() {
    const rows = $('shop-rows');
    if (!shops.length) {
      rows.replaceChildren(el('tr', {}, el('td', { colspan: 6, class: 'empty', text: $('shop-search').value ? 'No shops match.' : 'No shops yet. Create one.' })));
      return;
    }
    rows.replaceChildren(...shops.map((shop) => {
      const suspended = shop.status === 'suspended';
      return el('tr', { 'aria-selected': String(selectedShop?.id === shop.id) },
        el('td', {}, el('strong', { text: shop.name }), el('span', { class: 'sub', text: '/' + shop.slug })),
        el('td', { class: 'hide-narrow' }, shop.owner ? el('span', { text: shop.owner.name }) : el('span', { class: 'sub', text: 'No owner' }), shop.owner ? el('span', { class: 'sub', text: shop.owner.email }) : null),
        el('td', { text: String(shop.product_count) }),
        el('td', {}, el('span', { class: 'badge ' + shop.status, text: suspended ? 'Suspended' : 'Active' })),
        el('td', { class: 'hide-narrow', text: date(shop.created_at) }),
        el('td', { class: 'actions' },
          el('button', { class: 'small', type: 'button', text: 'Products', onclick: () => selectShop(shop) }),
          el('button', { class: 'small', type: 'button', text: 'Edit', onclick: () => openShop(shop) }),
          el('button', { class: 'small', type: 'button', text: suspended ? 'Activate' : 'Suspend', onclick: () => toggleShop(shop) }),
          el('button', { class: 'small danger', type: 'button', text: 'Delete', onclick: () => deleteShop(shop) }),
        ),
      );
    }));
  }

  async function loadShops() {
    const q = $('shop-search').value.trim();
    shops = (await api('admin/shops' + (q ? '?q=' + encodeURIComponent(q) : ''))).shops;
    if (selectedShop) selectedShop = shops.find((shop) => shop.id === selectedShop.id) || selectedShop;
    renderShops();
  }

  function shopBody(form) {
    const data = Object.fromEntries(new FormData(form));
    return {
      name: data.name,
      slug: data.slug,
      description: data.description,
      owner_id: data.owner_id ? Number(data.owner_id) : null,
      status: data.status,
    };
  }

  async function openShop(shop) {
    editingShop = shop || null;
    const form = $('shop-form');
    form.reset();
    formError(form, '');
    $('shop-dialog-title').textContent = shop ? 'Edit ' + shop.name : 'New shop';
    try { users = (await api('admin/users')).users; } catch {}
    const select = form.elements.owner_id;
    select.replaceChildren(el('option', { value: '', text: 'No owner' }), ...users.map((user) => el('option', { value: String(user.id), text: user.name + ' · ' + user.email })));
    if (shop) {
      form.elements.name.value = shop.name;
      form.elements.slug.value = shop.slug;
      form.elements.description.value = shop.description;
      select.value = shop.owner ? String(shop.owner.id) : '';
      form.elements.status.value = shop.status;
    }
    $('shop-dialog').showModal();
    form.elements.name.focus();
  }

  $('shop-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    if (!form.elements.name.value.trim()) return formError(form, 'Give the shop a name.');
    const send = form.querySelector('[type="submit"]');
    send.disabled = true;
    try {
      const saved = editingShop
        ? await api('admin/shops/' + editingShop.id, { method: 'PUT', json: shopBody(form) })
        : await api('admin/shops', { method: 'POST', json: shopBody(form) });
      $('shop-dialog').close();
      toast(editingShop ? 'Shop saved.' : saved.name + ' created.');
      await loadShops();
      if (!editingShop) selectShop(shops.find((shop) => shop.id === saved.id) || saved);
    } catch (error) {
      formError(form, error.message);
    } finally {
      send.disabled = false;
    }
  });

  async function toggleShop(shop) {
    const suspend = shop.status !== 'suspended';
    if (suspend && !(await confirmAction('Suspend ' + shop.name + '?', 'Its products disappear from the shop until you activate it again.', 'Suspend'))) return;
    try {
      await api('admin/shops/' + shop.id, { method: 'PUT', json: { name: shop.name, slug: shop.slug, description: shop.description, owner_id: shop.owner?.id ?? null, status: suspend ? 'suspended' : 'active' } });
      toast(shop.name + (suspend ? ' suspended.' : ' is active again.'));
      await loadShops();
    } catch (error) { toast(error.message); }
  }

  async function deleteShop(shop) {
    const products = shop.product_count === 1 ? '1 product' : shop.product_count + ' products';
    if (!(await confirmAction('Delete ' + shop.name + '?', 'This permanently deletes the shop and its ' + products + '. It cannot be undone.'))) return;
    try {
      await api('admin/shops/' + shop.id, { method: 'DELETE' });
      if (selectedShop?.id === shop.id) { selectedShop = null; $('products-panel').hidden = true; }
      toast(shop.name + ' deleted.');
      await loadShops();
    } catch (error) { toast(error.message); }
  }

  /* ---------- products ---------- */

  async function selectShop(shop) {
    selectedShop = shop;
    renderShops();
    $('products-panel').hidden = false;
    $('products-title').textContent = 'Products · ' + shop.name;
    await loadProducts();
    $('products-panel').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  let products = [];
  async function loadProducts() {
    try {
      products = (await api('admin/shops/' + selectedShop.id + '/products')).products;
    } catch (error) { toast(error.message); products = []; }
    const rows = $('product-rows');
    if (!products.length) {
      rows.replaceChildren(el('tr', {}, el('td', { colspan: 6, class: 'empty', text: 'No products in this shop yet.' })));
      return;
    }
    rows.replaceChildren(...products.map((product) => el('tr', {},
      el('td', {}, el('img', { class: 'thumb', alt: '', src: product.image || 'assets/' + product.id + '.webp', loading: 'lazy' })),
      el('td', {}, el('strong', { text: product.name }), el('span', { class: 'sub', text: product.id })),
      el('td', { class: 'hide-narrow', text: product.type }),
      el('td', { text: money(product.price) }),
      el('td', { class: 'hide-narrow', text: product.height_cm + ' cm' }),
      el('td', { class: 'actions' },
        el('button', { class: 'small', type: 'button', text: 'Edit', onclick: () => openProduct(product) }),
        el('button', { class: 'small danger', type: 'button', text: 'Remove', onclick: () => removeProduct(product) }),
      ),
    )));
  }

  function openProduct(product) {
    editingProduct = product || null;
    const form = $('product-form');
    form.reset();
    formError(form, '');
    $('product-dialog-title').textContent = product ? 'Edit ' + product.name : 'Add product to ' + selectedShop.name;
    if (product) {
      for (const name of ['name', 'type', 'price', 'height_cm', 'vessel', 'size', 'light', 'scale', 'description']) form.elements[name].value = product[name] ?? '';
      form.elements.tags.value = product.tags.join(', ');
      form.elements.image.value = product.image || '';
    }
    $('product-dialog').showModal();
    form.elements.name.focus();
  }

  $('product-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const f = form.elements;
    if (!f.name.value.trim() || !f.type.value.trim() || !f.price.value || !f.height_cm.value) return formError(form, 'Name, category, price and height are required.');
    const send = form.querySelector('[type="submit"]');
    send.disabled = true;
    try {
      const file = f.file.files[0];
      if (file) {
        if (file.size > 5 * 1024 * 1024) throw new Error('That image is larger than 5 MB.');
        const uploaded = await api('admin/uploads', { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
        f.image.value = uploaded.url;
      }
      const body = {
        name: f.name.value, type: f.type.value, vessel: f.vessel.value, description: f.description.value,
        price: Number(f.price.value), height_cm: Number(f.height_cm.value), size: f.size.value, light: f.light.value,
        scale: f.scale.value ? Number(f.scale.value) : null,
        tags: f.tags.value.split(',').map((tag) => tag.trim()).filter(Boolean),
        image: f.image.value || null,
      };
      if (editingProduct) await api('admin/products/' + encodeURIComponent(editingProduct.id), { method: 'PUT', json: body });
      else await api('admin/shops/' + selectedShop.id + '/products', { method: 'POST', json: body });
      $('product-dialog').close();
      toast(editingProduct ? 'Product saved.' : body.name + ' added.');
      await Promise.all([loadProducts(), loadShops()]);
    } catch (error) {
      formError(form, error.message);
    } finally {
      send.disabled = false;
    }
  });

  async function removeProduct(product) {
    if (!(await confirmAction('Remove ' + product.name + '?', 'It is permanently removed from ' + selectedShop.name + ' and the shop. It cannot be undone.', 'Remove'))) return;
    try {
      await api('admin/products/' + encodeURIComponent(product.id), { method: 'DELETE' });
      toast(product.name + ' removed.');
      await Promise.all([loadProducts(), loadShops()]);
    } catch (error) { toast(error.message); }
  }

  /* ---------- users ---------- */

  async function loadUsers() {
    const q = $('user-search').value.trim();
    try { users = (await api('admin/users' + (q ? '?q=' + encodeURIComponent(q) : ''))).users; } catch (error) { return toast(error.message); }
    const rows = $('user-rows');
    if (!users.length) {
      rows.replaceChildren(el('tr', {}, el('td', { colspan: 4, class: 'empty', text: 'No users match.' })));
      return;
    }
    rows.replaceChildren(...users.map((user) => {
      const select = el('select', { 'aria-label': 'Role for ' + user.email });
      for (const [value, label] of Object.entries(roleNames)) select.append(el('option', { value, text: label }));
      select.value = user.role;
      select.addEventListener('change', async () => {
        try {
          await api('admin/users/' + user.id, { method: 'PUT', json: { role: select.value } });
          user.role = select.value;
          toast(user.name + ' is now ' + roleNames[select.value].toLowerCase() + '.');
        } catch (error) {
          select.value = user.role;
          toast(error.message);
        }
      });
      return el('tr', {},
        el('td', {}, el('strong', { text: user.name }), user.id === me.id ? el('span', { class: 'sub', text: 'You' }) : null),
        el('td', { text: user.email }),
        el('td', {}, select),
        el('td', { class: 'hide-narrow', text: date(user.created_at) }),
      );
    }));
  }

  /* ---------- orders ---------- */

  const statusNames = { placed: 'Placed', confirmed: 'Confirmed', preparing: 'Preparing', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled' };
  const stamp = (seconds) => new Date(seconds * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const dayStart = (value, plusDays = 0) => {
    if (!value) return '';
    const [y, m, d] = value.split('-').map(Number);
    return String(Math.floor(new Date(y, m - 1, d + plusDays).getTime() / 1000));
  };
  let openOrderId = null;

  async function loadOrders() {
    const params = new URLSearchParams();
    const q = $('order-search').value.trim();
    if (q) params.set('q', q);
    if ($('order-status').value) params.set('status', $('order-status').value);
    if ($('order-shop').value) params.set('shop', $('order-shop').value);
    if ($('order-from').value) params.set('from', dayStart($('order-from').value));
    if ($('order-to').value) params.set('to', dayStart($('order-to').value, 1));
    params.set('today', dayStart(new Date().toLocaleDateString('en-CA')));
    let data;
    try { data = await api('admin/orders?' + params); } catch (error) { return toast(error.message); }
    const c = data.counts;
    const count = (value, label, status) => el('button', { type: 'button', onclick: () => { $('order-status').value = status; loadOrders(); } }, el('strong', { text: String(value) }), el('span', { text: label }));
    $('order-counts').replaceChildren(count(c.new, 'New (placed)', 'placed'), count(c.in_progress, 'In progress', 'active'), count(c.delivered_today, 'Delivered today', 'delivered'), count(c.total, 'All orders', ''));
    const rows = $('order-rows');
    if (!data.orders.length) {
      rows.replaceChildren(el('tr', {}, el('td', { colspan: 6, class: 'empty', text: 'No orders match.' })));
      return;
    }
    rows.replaceChildren(...data.orders.map((order) => {
      const items = order.items.reduce((sum, line) => sum + line.quantity, 0);
      return el('tr', { class: 'clickable', tabindex: '0', onclick: () => openOrder(order.id), onkeydown: (event) => { if (event.key === 'Enter') openOrder(order.id); } },
        el('td', {}, el('strong', { text: order.number })),
        el('td', { class: 'hide-narrow', text: stamp(order.created_at) }),
        el('td', {}, el('span', { text: order.customer.name || 'Demo shopper' }), el('span', { class: 'sub', text: order.customer.phone || 'no phone (older demo order)' })),
        el('td', { class: 'hide-narrow', text: items + (items === 1 ? ' item' : ' items') }),
        el('td', { text: money(order.total) }),
        el('td', {}, el('span', { class: 'status ' + order.status, text: statusNames[order.status] })),
      );
    }));
  }

  async function openOrder(id) {
    let order;
    try { order = await api('admin/orders/' + id); } catch (error) { return toast(error.message); }
    openOrderId = id;
    $('order-dialog-title').textContent = 'Order ' + order.number;
    const customer = el('div', {}, el('h3', { text: 'Customer' }),
      el('p', { text: order.customer.name || 'Not given (older demo order)' }), el('p', { text: order.customer.phone || '' }),
      el('p', { class: 'sub', text: order.account ? 'Signed-in account' : 'Guest' }));
    const delivery = el('div', {}, el('h3', { text: 'Delivery' }), el('p', { text: order.customer.address || 'Not given' }), order.customer.note ? el('p', { class: 'sub', text: 'Note: ' + order.customer.note }) : null);
    const summary = el('div', {}, el('h3', { text: 'Status' }), el('p', {}, el('span', { class: 'status ' + order.status, text: statusNames[order.status] })),
      el('p', { class: 'sub', text: 'Placed ' + stamp(order.created_at) }), el('p', {}, el('strong', { text: money(order.total) })));
    const items = el('table', {}, el('thead', {}, el('tr', {}, el('th', { text: 'Product' }), el('th', { text: 'Shop' }), el('th', { text: 'Qty' }), el('th', { text: 'Price' }))),
      el('tbody', {}, ...order.items.map((line) => el('tr', {},
        el('td', {}, el('strong', { text: line.name }), el('span', { class: 'sub', text: line.product_id })),
        el('td', { text: line.shop_name || '—' }), el('td', { text: String(line.quantity) }), el('td', { text: money(line.price * line.quantity) })))));
    const history = el('ul', { class: 'history' }, ...order.events.map((event) => el('li', {},
      el('span', { class: 'status ' + event.status, text: statusNames[event.status] }),
      el('span', {}, el('span', { text: stamp(event.at) + ' · ' + (event.actor.startsWith('admin:') ? event.actor.slice(6) : event.actor) }), event.note ? el('small', { text: ' — ' + event.note }) : null))));
    $('order-detail').replaceChildren(el('div', { class: 'detail-grid' }, summary, customer, delivery), el('div', { class: 'table-wrap' }, items), el('h3', { text: 'History' }), history);
    const form = $('order-form');
    formError(form, '');
    $('order-note').value = '';
    const finished = order.status === 'delivered' || order.status === 'cancelled';
    $('order-actions').hidden = finished;
    $('order-next').hidden = !order.next_status;
    if (order.next_status) {
      $('order-next').textContent = 'Mark as ' + statusNames[order.next_status].toLowerCase();
      $('order-next').dataset.status = order.next_status;
    }
    if (!$('order-dialog').open) $('order-dialog').showModal();
  }

  async function setOrderStatus(status) {
    const number = $('order-dialog-title').textContent.replace('Order ', '');
    const cancelling = status === 'cancelled';
    const ok = await confirmAction(cancelling ? 'Cancel ' + number + '?' : 'Mark ' + number + ' as ' + statusNames[status].toLowerCase() + '?',
      cancelling ? 'The customer will see the order as cancelled. This cannot be undone.' : 'The customer sees this status on their order straight away.',
      cancelling ? 'Cancel order' : 'Mark as ' + statusNames[status].toLowerCase());
    if (!ok) return;
    try {
      await api('admin/orders/' + openOrderId, { method: 'PUT', json: { status, note: $('order-note').value } });
      toast(number + ': ' + statusNames[status] + '.');
      await openOrder(openOrderId);
      loadOrders();
    } catch (error) {
      formError($('order-form'), error.message);
    }
  }
  $('order-next').addEventListener('click', () => setOrderStatus($('order-next').dataset.status));
  $('order-cancel').addEventListener('click', () => setOrderStatus('cancelled'));
  $('order-search').addEventListener('input', debounce(loadOrders));
  for (const id of ['order-status', 'order-shop', 'order-from', 'order-to']) $(id).addEventListener('change', loadOrders);
  $('order-clear').addEventListener('click', () => {
    for (const id of ['order-search', 'order-status', 'order-shop', 'order-from', 'order-to']) $(id).value = '';
    loadOrders();
  });

  async function loadOrderShops() {
    try {
      const all = (await api('admin/shops')).shops;
      const select = $('order-shop');
      const chosen = select.value;
      select.replaceChildren(el('option', { value: '', text: 'All shops' }), ...all.map((shop) => el('option', { value: String(shop.id), text: shop.name })));
      select.value = chosen;
    } catch {}
  }

  /* ---------- page ---------- */

  function showTab(name) {
    for (const tab of ['shops', 'orders', 'users']) {
      $('tab-' + tab).setAttribute('aria-selected', String(tab === name));
      $(tab + '-view').hidden = tab !== name;
    }
    if (name === 'users') loadUsers();
    if (name === 'orders') { loadOrderShops(); loadOrders(); }
  }
  $('tab-shops').addEventListener('click', () => showTab('shops'));
  $('tab-orders').addEventListener('click', () => showTab('orders'));
  $('tab-users').addEventListener('click', () => showTab('users'));
  $('new-shop').addEventListener('click', () => openShop(null));
  $('new-product').addEventListener('click', () => openProduct(null));
  for (const close of document.querySelectorAll('[data-close]')) close.addEventListener('click', () => close.closest('dialog').close());

  function debounce(action) {
    let timer;
    return () => { clearTimeout(timer); timer = setTimeout(action, 220); };
  }
  $('shop-search').addEventListener('input', debounce(() => loadShops().catch((error) => toast(error.message))));
  $('user-search').addEventListener('input', debounce(loadUsers));

  $('logout').addEventListener('click', async () => {
    try { await fetch('api/auth/logout', { method: 'POST' }); } catch {}
    try { localStorage.removeItem('customize-session'); } catch {}
    location.href = 'auth.html?next=admin';
  });

  (async function start() {
    try {
      const response = await fetch('api/auth/me');
      if (!response.ok) throw new Error();
      me = (await response.json()).user;
    } catch {
      return showGate('offline');
    }
    if (!me) return showGate('login');
    $('who').textContent = me.name;
    $('logout').hidden = false;
    if (me.role !== 'admin') return showGate('forbidden');
    $('gate').hidden = true;
    $('console').hidden = false;
    try { await loadShops(); } catch (error) { toast(error.message); }
  })();
})();
