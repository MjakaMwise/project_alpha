'use strict';

const get = (id) => document.getElementById(id);
const workspace = get('workspace');
const room = get('room');
const stage = get('stage');
const pan = get('pan');
const placement = get('placement');
const modal = get('modal');
const content = get('modal-content');
const itemSheet = get('item-sheet');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
// Shops can give a product its own image (an upload or URL); otherwise it is assets/<id>.webp.
const productImage = (id) => productById(id)?.image || 'assets/' + id + '.webp';
const money = (amount) => 'KSh ' + new Intl.NumberFormat('en-KE').format(amount);
const scenes = [
  { label: 'Living room', src: 'assets/room.webp' },
  { label: 'Home office', src: 'assets/office.webp' },
];
function currentScene() {
  const label = localStorage.getItem('customize-current-room');
  return scenes.find((scene) => scene.label === label) || scenes[0];
}
const defaultAngleNames = ['Front wall', 'Right wall', 'Back wall', 'Left wall'];
const anglePrompts = [
  'Photo 1: face the main wall and take a photo.',
  'Photo 2: turn about a quarter turn to the right.',
  'Photo 3: turn another quarter turn.',
  'Photo 4: turn the last quarter turn.',
];
const heartIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>';

const shopper = localStorage.getItem('customize-shopper') || crypto.randomUUID();
localStorage.setItem('customize-shopper', shopper);

let profile;
let scene;
let points = [];
let activePoint;
let noticeTimer;
const roomLayouts = new Map();
try {
  for (const [key, layout] of JSON.parse(localStorage.getItem('customize-room-layouts') || '[]')) {
    roomLayouts.set(key, layout);
  }
} catch {}
let placementMode = false;
let productToPlace;
let roomVisit;
let requests = Promise.resolve();

function announce(message) {
  get('notice').textContent = message;
  get('notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { get('notice').hidden = true; }, 2000);
}

async function request(path, activity) {
  return window.customizeApi(path, shopper, activity);
}

function record(activity) {
  const update = requests.then(async () => {
    profile = await request('activity', activity);

    return profile;
  });
  requests = update.catch(() => {});
  return update;
}

function element(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text) result.textContent = text;
  return result;
}

function button(text, className, action) {
  const result = element('button', className, text);
  result.type = 'button';
  result.addEventListener('click', action);
  return result;
}

function dialog(title, ...children) {
  get('modal-title').textContent = title;
  content.replaceChildren(...children);
  if (!modal.open) modal.showModal();
}

const productById = (id) => profile?.products.find((product) => product.id === id);
const isSaved = (id) => Boolean(profile?.saved.includes(id));

/* ---------- saving ---------- */

function setHeart(control) {
  const saved = isSaved(control.dataset.heart);
  control.setAttribute('aria-pressed', String(saved));
  const name = productById(control.dataset.heart)?.name || 'product';
  control.setAttribute('aria-label', (saved ? 'Remove from saved: ' : 'Save ') + name);
}

function refreshHearts() {
  for (const control of document.querySelectorAll('[data-heart]')) setHeart(control);
}

async function toggleSave(product) {
  const saved = !isSaved(product.id);
  try {
    await record({ kind: 'save', product_id: product.id, saved });
    refreshHearts();
    announce(saved ? product.name + ' saved.' : product.name + ' removed from saved.');
    if (currentPage === 'user') renderAccount();
  } catch (error) {
    announce(error.message);
  }
}

function heartButton(product, className = 'heart') {
  const control = element('button', className);
  control.type = 'button';
  control.dataset.heart = product.id;
  control.innerHTML = heartIcon;
  control.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleSave(product);
  });
  setHeart(control);
  return control;
}

/* ---------- checkout and activity ---------- */

function cartLines() {
  return profile.products
    .filter((product) => shoppingCart.get(product.id))
    .map((product) => ({ product, quantity: shoppingCart.get(product.id) }));
}

let cartRooms = {};
try { cartRooms = JSON.parse(localStorage.getItem('customize-cart-rooms') || '{}'); } catch {}
function noteCartRoom(product) {
  const name = activeRoom?.name || activeRoom?.label;
  if (!name) return;
  cartRooms[product.id] = name;
  try { localStorage.setItem('customize-cart-rooms', JSON.stringify(cartRooms)); } catch {}
}

function clearCart() {
  cartRooms = {};
  try { localStorage.setItem('customize-cart-rooms', '{}'); } catch {}
  shoppingCart.clear();
  localStorage.setItem('customize-cart', '{}');
  updateCartCount();
}

const orderStatuses = ['placed', 'confirmed', 'preparing', 'out_for_delivery', 'delivered'];
const statusLabel = { placed: 'Placed', confirmed: 'Confirmed', preparing: 'Preparing', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled' };
const when = (seconds) => new Date(seconds * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function orderApi(path, body) {
  const response = await fetch('api/orders/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not reach Customize. Try again.');
  return data;
}

function field(labelText, input, hint) {
  const label = element('label', 'checkout-field');
  label.append(element('span', '', labelText), input);
  if (hint) label.append(element('small', '', hint));
  return label;
}

function openCheckout() {
  const lines = cartLines();
  if (!lines.length) return;
  const orderId = crypto.randomUUID();
  const total = lines.reduce((sum, line) => sum + line.product.price * line.quantity, 0);
  const summary = element('div', 'order-lines');
  for (const { product, quantity } of lines) {
    const row = element('div', 'order-product');
    const image = new Image();
    image.src = productImage(product.id);
    image.alt = '';
    const detail = element('div');
    detail.append(element('h3', '', product.name), element('p', '', quantity + ' × ' + money(product.price)),
      element('strong', '', money(product.price * quantity)));
    row.append(image, detail);
    summary.append(row);
  }

  // Delivery details, remembered on this device for next time.
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('customize-delivery') || '{}'); } catch {}
  if (wtState.on && !saved.phone) saved = { name: 'Demo shopper', phone: '0700 000 000', address: 'Demo street, Nairobi' };
  const input = (name, type, value, attrs = {}) => {
    const control = element(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') control.type = type;
    control.name = name;
    control.value = value || '';
    Object.assign(control, attrs);
    return control;
  };
  const name = input('name', 'text', saved.name || localStorage.getItem('customize-account-name') || '', { autocomplete: 'name', maxLength: 80, required: true });
  const phone = input('phone', 'tel', saved.phone, { autocomplete: 'tel', maxLength: 20, required: true, placeholder: '0712 345 678' });
  const address = input('address', 'text', saved.address, { autocomplete: 'street-address', maxLength: 200, required: true, placeholder: 'Estate, street, building' });
  const note = input('note', 'textarea', '', { maxLength: 300, rows: 2, placeholder: 'Gate code, landmark, best time to call' });
  const form = element('form', 'checkout-form');
  form.noValidate = true;
  form.append(element('h3', '', 'Delivery details'), field('Name', name), field('Phone', phone),
    field('Delivery address or area', address), field('Note for the rider (optional)', note));

  const feedback = element('p');
  feedback.setAttribute('role', 'status');
  const confirm = button('Place demo order · ' + money(total), 'primary', async () => {
    const delivery = { name: name.value.trim(), phone: phone.value.trim(), address: address.value.trim(), note: note.value.trim() };
    const digits = delivery.phone.replace(/\D/g, '').length;
    const problem = !delivery.name ? [name, 'Enter the name for the delivery.']
      : digits < 9 || digits > 15 ? [phone, 'Enter a phone number, for example 0712 345 678.']
      : !delivery.address ? [address, 'Enter the delivery address or area.'] : null;
    if (problem) {
      feedback.textContent = problem[1];
      problem[0].focus();
      return;
    }
    confirm.disabled = true;
    feedback.textContent = 'Placing your order…';
    try {
      await record({
        kind: 'cart_order', order_id: orderId, delivery,
        items: lines.map(({ product, quantity }) => ({ product_id: product.id, quantity })),
      });
      try { localStorage.setItem('customize-delivery', JSON.stringify({ name: delivery.name, phone: delivery.phone, address: delivery.address })); } catch {}
      clearCart();
      let placed = null;
      if (window.customizeServer) {
        try { placed = (await orderApi('mine/' + shopper)).orders.find((order) => order.ref === orderId) || null; } catch {}
      }
      dialog(
        'Order placed',
        element('p', 'order-number', placed ? placed.number : 'Reference ' + orderId.slice(0, 8).toUpperCase()),
        element('p', '', lines.length + (lines.length === 1 ? ' item' : ' items') + ' · ' + money(total) + ' · delivery to ' + delivery.address),
        element('p', 'checkout-note', placed ? 'Track it any time under Account › My orders. This is a demo: no payment is taken.' : 'This is a demo: no payment is taken.'),
        ...(activeRoom ? [button('Back to your space', 'primary', () => {
          modal.close();
          openRoom(activeRoom, null, angleIndex, true);
        })] : []),
        ...(placed ? [button('Track this order', activeRoom ? 'quiet' : 'primary', () => openOrder(placed))] : []),
        button('Continue exploring', 'quiet', () => {
          modal.close();
          showPage('shop');
        }),
      );
      content.querySelector('button').focus();
    } catch (error) {
      feedback.textContent = error.message;
      confirm.disabled = false;
    }
  });
  form.addEventListener('submit', (event) => { event.preventDefault(); confirm.click(); });
  dialog('Checkout', summary, form, element('p', 'checkout-note', 'Demo checkout: no payment is taken.'), confirm, feedback);
}

/* ---------- order tracking ---------- */

function orderTimeline(order) {
  const list = element('ol', 'order-timeline');
  const reached = new Map(order.events.map((event) => [event.status, event]));
  const steps = order.status === 'cancelled'
    ? [...orderStatuses.filter((status) => reached.has(status)), 'cancelled']
    : orderStatuses;
  const currentIndex = steps.indexOf(order.status);
  steps.forEach((status, index) => {
    const event = reached.get(status);
    const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo';
    const item = element('li', 'order-step ' + state + (status === 'cancelled' ? ' cancelled' : ''));
    const text = element('div');
    text.append(element('strong', '', statusLabel[status]));
    if (event) text.append(element('small', '', when(event.at) + (event.note ? ' · ' + event.note : '')));
    item.append(element('span', 'order-dot'), text);
    list.append(item);
  });
  return list;
}

function openOrder(order) {
  const items = element('div', 'order-lines');
  for (const line of order.items) {
    const row = element('div', 'order-product');
    row.append(shopImage(line.image || productImage(line.product_id), ''));
    const detail = element('div');
    detail.append(element('h3', '', line.name), element('p', '', line.quantity + ' × ' + money(line.price) + (line.shop_name ? ' · ' + line.shop_name : '')));
    row.append(detail);
    items.append(row);
  }
  const head = element('div', 'order-head');
  head.append(element('span', 'order-badge ' + order.status, statusLabel[order.status]), element('span', '', 'Placed ' + when(order.created_at) + ' · ' + money(order.total)));
  const parts = [head, orderTimeline(order), items];
  if (order.customer.address) {
    const where = element('div', 'order-delivery');
    where.append(element('strong', '', 'Delivery'), element('p', '', order.customer.name + ' · ' + order.customer.phone),
      element('p', '', order.customer.address + (order.customer.note ? ' · ' + order.customer.note : '')));
    parts.push(where);
  }
  const feedback = element('p');
  feedback.setAttribute('role', 'status');
  if (order.status === 'placed' && order.mine !== false) {
    const cancel = button('Cancel order', 'quiet order-cancel', async () => {
      if (cancel.dataset.sure !== '1') {
        cancel.dataset.sure = '1';
        cancel.textContent = 'Tap again to cancel ' + order.number;
        return;
      }
      cancel.disabled = true;
      try {
        const updated = await orderApi(order.number + '/cancel', { shopper });
        openOrder(updated);
        renderAccountOrders();
      } catch (error) {
        feedback.textContent = error.message;
        cancel.disabled = false;
      }
    });
    parts.push(cancel);
  }
  parts.push(feedback);
  dialog('Order ' + order.number, ...parts);
}

async function renderAccountOrders() {
  const box = get('account-orders');
  if (!window.customizeServer) {
    const count = profile?.orders.length || 0;
    box.replaceChildren(element('p', 'empty-state', count
      ? count + (count === 1 ? ' demo order' : ' demo orders') + ' on this device. Order tracking needs the Customize server (log in or open with ?backend=server).'
      : 'Orders you place appear here.'));
    return;
  }
  let orders;
  try { orders = (await orderApi('mine/' + shopper)).orders; } catch (error) {
    box.replaceChildren(element('p', 'empty-state', error.message));
    return;
  }
  if (!orders.length) {
    box.replaceChildren(element('p', 'empty-state', 'Orders you place appear here, with their delivery status.'));
    return;
  }
  box.replaceChildren(...orders.slice(0, 20).map((order) => {
    const row = button('', 'order-row', () => openOrder(order));
    const count = order.items.reduce((sum, line) => sum + line.quantity, 0);
    const text = element('span', 'order-row-text');
    text.append(element('strong', '', order.number), element('small', '', when(order.created_at) + ' · ' + count + (count === 1 ? ' item' : ' items') + ' · ' + money(order.total)));
    row.append(text, element('span', 'order-badge ' + order.status, statusLabel[order.status]), element('span', 'room-row-go', '›'));
    return row;
  }));
}

get('track-order').addEventListener('click', () => {
  const form = element('form', 'checkout-form');
  form.noValidate = true;
  const number = element('input');
  number.placeholder = 'CU-000123';
  number.autocomplete = 'off';
  number.maxLength = 20;
  const phone = element('input');
  phone.type = 'tel';
  phone.placeholder = '0712 345 678';
  phone.maxLength = 20;
  const feedback = element('p');
  feedback.setAttribute('role', 'status');
  const find = element('button', 'primary', 'Find my order');
  form.append(field('Order number', number), field('Phone used at checkout', phone), find, feedback);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!number.value.trim() || !phone.value.trim()) { feedback.textContent = 'Enter the order number and phone.'; return; }
    find.disabled = true;
    try {
      const order = await orderApi('lookup', { number: number.value, phone: phone.value });
      order.mine = false;
      openOrder(order);
    } catch (error) {
      feedback.textContent = window.customizeServer || error.message !== 'Could not reach Customize. Try again.' ? error.message : 'Order tracking needs the Customize server.';
      find.disabled = false;
    }
  });
  dialog('Track an order', element('p', '', 'Enter your order number and the phone number you used at checkout.'), form);
  number.focus();
});

function orderSummary(order) {
  const name = (id) => productById(id)?.name || id;
  const what = order.items?.length
    ? order.items.map((item) => item.quantity + ' × ' + name(item.product_id)).join(', ')
    : name(order.product_id);
  return what + ' · ' + money(order.amount) + ' · ' + order.id.slice(0, 8).toUpperCase();
}

function openHistory() {
  if (!profile) return;
  const saved = element('ul', 'activity-list');
  const orders = element('ul', 'activity-list');
  for (const id of profile.saved) saved.append(element('li', '', productById(id)?.name || id));
  for (const order of [...profile.orders].reverse()) orders.append(element('li', '', orderSummary(order)));
  dialog(
    'Your activity',
    element('h3', '', 'Saved products'),
    saved.childElementCount ? saved : element('p', '', 'Tap the heart on a product to save it.'),
    element('h3', '', 'Demo orders'),
    orders.childElementCount ? orders : element('p', '', 'Your completed demo orders appear here.'),
    button('Refresh recommendations', 'primary', () => {
      renderShop();
      modal.close();
    }),
  );
}

function renderAccountName() {
  const name = get('user-page').classList.contains('is-guest') ? '' : localStorage.getItem('customize-account-name') || '';
  get('user-title').textContent = name ? 'Hello, ' + name + '!' : 'Your account';
  const avatar = get('account-avatar');
  avatar.textContent = [...name][0]?.toLocaleUpperCase() || '';
  avatar.hidden = !name;
  get('edit-account-name').textContent = name ? 'Edit name' : 'Add name';
}

async function renderAccount() {
  if (!profile) return;
  const stats = get('account-stats');
  const saved = get('account-saved');
  const items = profile.saved.map(productById).filter(Boolean);
  if (!items.length) {
    saved.replaceChildren(element('p', 'empty-state', 'Tap the heart on a product to keep it here.'));
  } else saved.replaceChildren(...items.map((product) => {
    const card = button('', 'saved-chip', () => openProduct(product));
    card.append(shopImage(productImage(product.id), 'saved-photo'), element('span', '', product.name));
    return card;
  }));
  if (!accountUser) return;
  const stat = (value, label) => {
    const box = element('div');
    box.append(element('strong', '', String(value)), element('span', '', label));
    return box;
  };
  let savedRooms = [];
  try { savedRooms = (await savedRoomStore('readonly', (store) => store.getAll())) || []; } catch {}
  const roomCount = savedRooms.length;
  for (const url of accountThumbnails) URL.revokeObjectURL(url);
  accountThumbnails = [];
  const roomsBox = get('account-rooms');
  if (!savedRooms.length) {
    roomsBox.replaceChildren(element('p', 'empty-state', 'Record a space to see it here.'));
  } else {
    roomsBox.replaceChildren(...savedRooms.map((entry) => {
      const url = URL.createObjectURL(entry.photos[0]);
      accountThumbnails.push(url);
      const placed = entry.photos.reduce((sum, _, index) => sum + placedCount(entry, index), 0);
      const detail = (entry.kind === 'panorama' ? 'Panorama' : entry.photos.length + (entry.photos.length === 1 ? ' angle' : ' angles')) +
        ' · ' + placed + (placed === 1 ? ' piece placed' : ' pieces placed');
      const item = button('', 'room-row', () => openRoom(entry));
      const text = element('span', 'room-row-text');
      text.append(element('strong', '', entry.name), element('small', '', detail));
      item.append(shopImage(url, 'room-row-photo'), text, element('span', 'room-row-go', '›'));
      return item;
    }));
  }
  renderAccountOrders();
  stats.replaceChildren(stat(profile.saved.length, 'Saved'), stat(roomCount, roomCount === 1 ? 'Space' : 'Spaces'), stat(profile.orders.length, profile.orders.length === 1 ? 'Order' : 'Orders'));

}

get('edit-account-name').addEventListener('click', () => {
  const form = element('form', 'room-form');
  const label = element('label', '', 'Name');
  const input = element('input');
  input.id = 'account-name-input';
  input.autocomplete = 'name';
  input.maxLength = 80;
  input.required = true;
  input.value = localStorage.getItem('customize-account-name') || '';
  label.htmlFor = input.id;
  form.append(label, input, element('button', 'primary', 'Save name'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) return input.focus();
    localStorage.setItem('customize-account-name', name);
    renderAccountName();
    modal.close();
  });
  dialog('Your name', form);
  input.focus();
});
renderAccountName();

/* ---------- sign in (auth.html, admin.html; needs the Rust server) ---------- */

let accountUser = null;
async function renderAuth() {
  const box = get('account-auth');
  const link = (text, href, className) => {
    const a = element('a', className, text);
    a.href = href;
    return a;
  };
  try {
    const response = await fetch('api/auth/me');
    if (!response.ok) throw new Error();
    accountUser = (await response.json()).user;
  } catch {
    accountUser = null;
  }
  get('user-page').classList.toggle('is-guest', !accountUser);
  renderAccountName();
  if (currentPage === 'user') renderAccount();
  if (!accountUser) {
    // The server forgot the session (logged out elsewhere or expired): go back to this device's activity.
    if (localStorage.getItem('customize-session') === '1') {
      localStorage.removeItem('customize-session');
      location.reload();
      return;
    }
    box.replaceChildren(
      link('Create an account', 'auth.html?mode=signup', 'account-auth-link primary'),
    );
    return;
  }
  if (localStorage.getItem('customize-account-name') !== accountUser.name) {
    localStorage.setItem('customize-account-name', accountUser.name);
    renderAccountName();
  }
  const text = element('p', 'account-auth-text');
  text.append('Signed in as ', element('strong', '', accountUser.email));
  const out = button('Log out', 'account-auth-link', async () => {
    out.disabled = true;
    try { await fetch('api/auth/logout', { method: 'POST' }); } catch {}
    localStorage.removeItem('customize-session');
    localStorage.removeItem('customize-account-name');
    location.reload();
  });
  box.replaceChildren(text, ...(accountUser.role === 'admin' ? [link('Manage shops', 'admin.html', 'account-auth-link primary')] : []), out);
}
renderAuth();

get('account-cart').addEventListener('click', () => showPage('cart'));
get('history').addEventListener('click', openHistory);
get('close').addEventListener('click', () => modal.close());

let shopCategory = 'All';
let preferredProduct;
let activeRoom;
let angleIndex = 0;
let roomDatabase;
let roomThumbnails = [];
let angleThumbnails = [];
let accountThumbnails = [];
const shoppingCart = new Map(Object.entries(JSON.parse(localStorage.getItem('customize-cart') || '{}')));

const mainPages = ['shop', 'discover', 'rooms', 'cart', 'user'];
let currentPage;
let discoverProductId;
let discoverReturnPage = 'shop';
let tryingFromDiscover = false;
let roomReturnPage = 'rooms';
let pageAnimation;
const navigationOrder = ['shop', 'discover', 'rooms', 'cart', 'user'];

function showPage(page) {
  const previousPage = currentPage;
  pageAnimation?.cancel();
  const discovering = page === 'discover';
  if (discovering && currentPage !== 'discover' && !(currentPage === 'preview' && roomReturnPage === 'discover')) {
    discoverReturnPage = mainPages.includes(currentPage) ? currentPage : 'shop';
  }
  currentPage = page;
  get('discover-back').hidden = !discovering;
  get('open-search').hidden = discovering;
  const immersive = discovering || page === 'preview';
  document.querySelector('.shop-nav').hidden = immersive;
  document.querySelector('.shop-shell').classList.toggle('immersive', immersive);
  document.body.classList.toggle('immersive', immersive);
  if (carousel.open) carousel.close();
  for (const name of [...mainPages, 'product']) {
    get(name + '-page').hidden = name !== page;
    const nav = get('nav-' + name);
    const active = name === page || (name === 'shop' && page === 'product') ||
      (page === 'preview' && name === (tryingFromDiscover ? 'shop' : 'rooms'));
    if (active) nav?.setAttribute('aria-current', 'page');
    else nav?.removeAttribute('aria-current');
  }
  workspace.hidden = page !== 'preview';
  document.body.classList.toggle('room-fullscreen', page === 'preview');
  window.CustomizeRoomDisplay?.setFullscreen(page === 'preview');
  if (page === 'shop') { renderShop(); requestAnimationFrame(updateFilterFade); }
  if (page === 'rooms') renderRooms();
  if (page === 'cart') renderCart();
  if (page === 'user') renderAccount();
  if (page === 'discover') {
    tryingFromDiscover = false;
    get('discover-page').append(carouselLayout);
    carouselSearch.value = '';
    setSearchMode(false);
    filterCarousel(discoverProductId);
  }
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  if (!previousPage || previousPage === page || reduceMotion.matches) return;

  const screen = page === 'preview' ? workspace : get(page + '-page');
  const from = navigationOrder.indexOf(previousPage);
  const to = navigationOrder.indexOf(page);
  const movement = from >= 0 && to >= 0
    ? 'translateX(' + (to > from ? 24 : -24) + 'px)'
    : 'translateY(16px)';
  pageAnimation = screen.animate(
    [{ opacity: 0, transform: movement }, { opacity: 1, transform: 'none' }],
    { duration: 300, easing: 'cubic-bezier(.22, 1, .36, 1)' },
  );
}

function shopImage(source, className) {
  const image = element('img', className);
  image.src = source;
  image.alt = '';
  return image;
}

function renderShop() {
  if (!profile) return;
  const products = profile.products.filter((product) => {
    if (shopCategory === 'Saved') return isSaved(product.id);
    return shopCategory === 'All' || product.type === shopCategory;
  });
  const hour = new Date().getHours();
  const name = localStorage.getItem('customize-account-name');
  get('shop-title').textContent = (hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening') + (name ? ', ' + name : '');
  get('shop-sub').textContent = profile.personalized
    ? 'Pieces that suit the spaces you’ve tried'
    : 'Preview plants and flowers in your space before you buy.';
  const picks = get('shop-picks');
  picks.hidden = !(profile.personalized && shopCategory === 'All');
  if (!picks.hidden) {
    get('shop-picks-why').textContent = profile.top_tag ? 'Leaning ' + profile.top_tag : 'Based on your activity';
  }
  if (!products.length) {
    get('shop-grid').replaceChildren(element('p', 'empty-state',
      shopCategory === 'Saved' ? 'Nothing saved yet. Tap the heart on a product to keep it here.' : 'No products in this category.'));
    return;
  }
  get('shop-grid').replaceChildren(...products.map((product, index) => {
    const item = productItem(product);
    if (!picks.hidden && index === 0) item.append(element('span', 'for-you', 'For you'));
    return item;
  }));
}

// One catalog card: used by the Shop grid and by Discover search results.
function productItem(product) {
  const item = element('div', 'shop-item');
  const card = button('', 'shop-card', () => openProduct(product));
  card.append(
    shopImage(productImage(product.id), 'shop-photo'),
    element('strong', 'shop-name', product.name),
    element('span', 'shop-meta', product.vessel),
    element('span', 'shop-price', money(product.price)),
  );
  item.append(card, heartButton(product), button('Try in space', 'try-in-room', () => openRoom(currentScene(), product)));
  return item;
}

function openProduct(product) {
  const actions = element('div', 'sheet-actions');
  actions.append(
    button('See it in your space', 'primary', () => openRoom(currentScene(), product)),
    button('Add to cart', 'quiet', () => {
      addToCart(product);
    }),
  );
  const facts = element('ul', 'product-facts');
  for (const fact of [product.vessel, product.size, product.light]) {
    facts.append(element('li', '', fact));
  }
  const hero = element('div', 'detail-hero');
  hero.append(shopImage(productImage(product.id), 'detail-product'), heartButton(product, 'heart heart-large'));
  const details = element('div', 'detail-body');
  const related = profile.products
    .filter((other) => other.id !== product.id && other.tags.some((tag) => product.tags.includes(tag)))
    .slice(0, 3);
  details.append(element('h1', '', product.name), element('strong', 'shop-price', money(product.price)),
    element('p', 'product-description', product.description), facts);
  if (related.length) {
    const head = element('div', 'row-head');
    head.append(element('b', '', 'Goes well with'), element('span', '', 'Similar style'));
    const tray = element('div', 'account-saved');
    for (const other of related) {
      const chip = button('', 'saved-chip', () => openProduct(other));
      chip.append(shopImage(productImage(other.id), 'saved-photo'), element('span', '', other.name));
      tray.append(chip);
    }
    details.append(head, tray);
  }
  details.append(actions);
  const back = button('', 'quiet detail-back icon-back', () => showPage('shop'));
  back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5m7-7-7 7 7 7"/></svg>';
  back.setAttribute('aria-label', 'Back to shop');
  get('product-page').replaceChildren(back, hero, details);
  showPage('product');
}

function updateCartCount() {
  const count = [...shoppingCart.values()].reduce((sum, quantity) => sum + quantity, 0);
  get('cart-count').textContent = count > 99 ? '99+' : count;
  get('nav-cart').setAttribute('aria-label', count ? 'Cart, ' + count + (count === 1 ? ' item' : ' items') : 'Cart');
  get('cart-count').hidden = count === 0;
  get('account-cart').textContent = count ? 'View cart · ' + count + (count === 1 ? ' item' : ' items') : 'View cart · Empty';
}

function changeQuantity(product, delta) {
  const quantity = (shoppingCart.get(product.id) || 0) + delta;
  if (quantity > 0) shoppingCart.set(product.id, quantity);
  else shoppingCart.delete(product.id);
  localStorage.setItem('customize-cart', JSON.stringify(Object.fromEntries(shoppingCart)));
  updateCartCount();
  if (!get('cart-page').hidden) renderCart();
}

function addToCart(product) {
  changeQuantity(product, 1);
  announce(product.name + ' added to cart.');
}

function renderCart() {
  const rows = [];
  let total = 0;
  for (const { product, quantity } of cartLines()) {
    total += product.price * quantity;
    const row = element('article', 'cart-line');
    const details = element('div', 'cart-details');
    const controls = element('div', 'cart-controls');
    const decrease = button('−', 'quiet', () => changeQuantity(product, -1));
    decrease.setAttribute('aria-label', 'Remove one ' + product.name);
    const increase = button('+', 'quiet', () => changeQuantity(product, 1));
    increase.setAttribute('aria-label', 'Add one ' + product.name);
    controls.append(decrease, element('span', '', String(quantity)), increase);
    details.append(element('h2', '', product.name), element('span', 'shop-price', money(product.price * quantity)));
    if (cartRooms[product.id]) details.append(element('span', 'cart-note', 'Placed in ' + cartRooms[product.id]));
    details.append(controls);
    row.append(shopImage(productImage(product.id), 'cart-photo'), details);
    rows.push(row);
  }
  if (rows.length) {
    const summary = element('div', 'cart-summary');
    const line = (label, value, className) => {
      const item = element('div', className);
      item.append(element('span', '', label), element('span', '', value));
      return item;
    };
    summary.append(line('Subtotal', money(total)), line('Delivery', 'Demo'), line('Total', money(total), 'cart-total-line'));
    rows.push(summary);
    rows.push(button('Check out · ' + money(total), 'primary cart-checkout', openCheckout));
  } else {
    rows.push(element('p', 'empty-state', 'Your cart is empty.'), button('Browse shop', 'primary', () => showPage('shop')));
  }
  get('cart-items').replaceChildren(...rows);
}

function savedRoomStore(mode, operation) {
  if (!roomDatabase) {
    roomDatabase = new Promise((resolve, reject) => {
      const opening = indexedDB.open('customize-rooms', 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('rooms', { keyPath: 'id' });
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    }).catch((error) => {
      roomDatabase = undefined;
      throw error;
    });
  }
  return roomDatabase.then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction('rooms', mode);
    const request = operation(transaction.objectStore('rooms'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
  }));
}

/* ---------- room view: angles, panorama, products ---------- */

const angleName = (saved, index) => saved.angleNames?.[index] || defaultAngleNames[index] || 'Angle ' + (index + 1);
const isPanorama = () => activeRoom?.kind === 'panorama';
const layoutKey = (saved, index) => (saved.id || saved.src) + ':' + index;
let panOffset = null;
let panMax = 0;

function layoutPan() {
  if (workspace.hidden) return;
  const height = stage.clientHeight;
  const width = stage.clientWidth;
  if (isPanorama() && room.naturalWidth && height) {
    const full = Math.max(width, height * room.naturalWidth / room.naturalHeight);
    pan.style.width = full + 'px';
    panMax = Math.max(0, full - width);
    panOffset = Math.min(panMax, panOffset ?? panMax / 2);
  } else {
    pan.style.width = '100%';
    panMax = 0;
    panOffset = 0;
  }
  applyPan();
}

function applyPan() {
  pan.style.transform = panOffset ? 'translateX(' + -panOffset + 'px)' : '';
}

function nudgePan(delta) {
  if (!panMax) return;
  panOffset = Math.max(0, Math.min(panMax, (panOffset ?? 0) + delta));
  applyPan();
}

room.addEventListener('load', layoutPan);
addEventListener('resize', () => {
  if (currentPage !== 'preview') return;
  layoutPan();
  renderPoints();
});
addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && scaleTaps && !modal.open) stopScale();
  if (currentPage !== 'preview' || !panMax || modal.open || itemSheet.open || carousel.open) return;
  if (event.target.closest?.('input, textarea')) return;
  if (event.key === 'ArrowLeft') nudgePan(-80);
  if (event.key === 'ArrowRight') nudgePan(80);
});

function openRoom(saved, product, index = 0, resume = false) {
  if (!resume && currentPage !== 'preview') roomReturnPage = currentPage;
  tryingFromDiscover = Boolean(product);
  preferredProduct = product;
  const sameRoom = activeRoom === saved;
  activeRoom = saved;
  angleIndex = index;
  if (scene?.uploaded) URL.revokeObjectURL(scene.src);
  const photo = saved.photos?.[index];
  scene = photo ? { label: saved.name, src: URL.createObjectURL(photo), uploaded: true } : saved;
  if (!sameRoom || !isPanorama()) panOffset = null;
  room.src = scene.src;
  room.alt = scene.label;
  const layout = roomLayouts.get(layoutKey(saved, index));
  points = layout?.points || [];
  productToPlace = product;
  placementMode = Boolean(product) && !resume;
  showPage('preview');
  modal.close();
  const label = get('room-label');
  label.hidden = !(saved.photos?.length > 1 || isPanorama());
  label.textContent = isPanorama() ? 'Drag to look around'
    : saved.photos?.length > 1 ? angleName(saved, index) + ' · ' + (index + 1) + '/' + saved.photos.length : '';
  scaleTaps = null;
  stage.classList.remove('scaling');
  drawScaleOverlay();
  updateScaleButton();
  renderAngleStrip();
  get('close-room').focus({ preventScroll: true });
  layoutPan();
  renderPoints();
}

function placedCount(saved, index) {
  const layout = roomLayouts.get(layoutKey(saved, index));
  return layout?.points.filter((point) => point.product).length || 0;
}

function renderAngleStrip() {
  const strip = get('angle-strip');
  for (const url of angleThumbnails) URL.revokeObjectURL(url);
  angleThumbnails = [];
  const photos = activeRoom?.photos;
  strip.hidden = !(photos?.length > 1) || isPanorama();
  if (strip.hidden) return strip.replaceChildren();
  strip.replaceChildren(...photos.map((photo, index) => {
    const url = URL.createObjectURL(photo);
    angleThumbnails.push(url);
    const thumb = button('', 'angle-thumb', () => {
      if (index !== angleIndex) openRoom(activeRoom, preferredProduct, index, true);
    });
    const count = placedCount(activeRoom, index);
    thumb.setAttribute('aria-label', angleName(activeRoom, index) + (count ? ', ' + count + ' placed' : ''));
    if (index === angleIndex) thumb.setAttribute('aria-current', 'true');
    thumb.append(shopImage(url, 'angle-photo'), element('span', 'angle-name', angleName(activeRoom, index)));
    if (count) thumb.append(element('span', 'angle-count', String(count)));
    return thumb;
  }));
}

function switchAngle(direction) {
  const count = activeRoom?.photos?.length || 0;
  if (count < 2 || isPanorama()) return;
  openRoom(activeRoom, preferredProduct, (angleIndex + direction + count) % count, true);
}

async function renderRooms() {
  const grid = get('rooms-grid');
  try {
    const saved = await savedRoomStore('readonly', (store) => store.getAll());
    for (const url of roomThumbnails) URL.revokeObjectURL(url);
    roomThumbnails = [];
    const samples = scenes.map((sample) => {
      const card = button('', 'shop-card', () => openRoom(sample));
      card.append(shopImage(sample.src, 'shop-photo room-photo'), element('strong', 'shop-name', sample.label));
      const item = element('div', 'shop-item');
      item.append(card);
      return item;
    });
    grid.replaceChildren(...samples, ...saved.map((entry) => {
      const item = element('div', 'shop-item');
      const card = button('', 'shop-card', () => openRoom(entry));
      const url = URL.createObjectURL(entry.photos[0]);
      roomThumbnails.push(url);
      const detail = entry.kind === 'panorama' ? 'Panorama'
        : entry.photos.length + (entry.photos.length === 1 ? ' angle' : ' angles');
      card.append(shopImage(url, 'shop-photo room-photo'), element('strong', 'shop-name', entry.name),
        element('span', 'shop-meta', detail));
      const menu = button('⋯', 'room-menu', () => openRoomMenu(entry));
      menu.setAttribute('aria-label', 'Options for ' + entry.name);
      item.append(card, menu);
      return item;
    }));

  } catch {
    grid.replaceChildren(element('p', 'empty-state', 'Your saved spaces could not be loaded.'));
  }
}

async function decodePhotos(files) {
  const accepted = [];
  let rejected = false;
  for (const file of files) {
    const url = URL.createObjectURL(file);
    try {
      await shopImage(url).decode();
      accepted.push(file);
    } catch {
      rejected = true;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return { accepted, rejected };
}

function openRoomMenu(entry) {
  const actions = element('div', 'room-item-actions');
  actions.append(
    button('Rename space and angles', 'quiet', () => openRoomRename(entry)),
  );
  if (entry.kind !== 'panorama' && entry.photos.length < 4) {
    actions.append(button('Add angles', 'quiet', () => addAngles(entry)));
  }
  actions.append(button('Delete space', 'quiet', () => confirmDeleteRoom(entry)));
  dialog(entry.name, actions);
}

function openRoomRename(entry) {
  const form = element('form', 'room-form');
  const field = (id, text, value) => {
    const label = element('label', '', text);
    const input = element('input');
    input.id = id;
    input.maxLength = 60;
    input.required = true;
    input.value = value;
    label.htmlFor = id;
    form.append(label, input);
    return input;
  };
  const name = field('rename-room', 'Space name', entry.name);
  const angles = entry.kind === 'panorama' ? [] : entry.photos.map((_, index) =>
    field('rename-angle-' + index, 'Angle ' + (index + 1), angleName(entry, index)));
  form.append(element('button', 'primary', 'Save'));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const next = { ...entry, name: name.value.trim() || entry.name };
    if (angles.length) next.angleNames = angles.map((input, index) => input.value.trim() || angleName(entry, index));
    try {
      await savedRoomStore('readwrite', (store) => store.put(next));
      if (activeRoom?.id === entry.id) activeRoom = next;
      modal.close();
      renderRooms();
      announce('Space updated.');
    } catch {
      announce('The space could not be updated. Try again.');
    }
  });
  dialog('Rename', form);
  name.focus();
}

function addAngles(entry) {
  modal.close();
  const input = element('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.addEventListener('change', async () => {
    const { accepted, rejected } = await decodePhotos([...input.files].slice(0, 4 - entry.photos.length));
    if (!accepted.length) return announce('Those photos could not be opened.');
    const next = { ...entry, photos: [...entry.photos, ...accepted] };
    next.angleNames = next.photos.map((_, index) => angleName(entry, index));
    try {
      await savedRoomStore('readwrite', (store) => store.put(next));
      renderRooms();
      announce(accepted.length + (accepted.length === 1 ? ' angle' : ' angles') + ' added.' + (rejected ? ' Some photos could not be opened.' : ''));
    } catch {
      announce('The photos could not be saved. Try again.');
    }
  });
  input.click();
}

function confirmDeleteRoom(entry) {
  const failure = element('p');
  failure.setAttribute('role', 'status');
  dialog('Delete ' + entry.name + '?',
    element('p', '', 'The photos and everything you placed in this space are removed from this device.'),
    button('Delete space', 'primary', async () => {
      try {
        await savedRoomStore('readwrite', (store) => store.delete(entry.id));
        for (const key of [...roomLayouts.keys()]) if (key.startsWith(entry.id + ':')) roomLayouts.delete(key);
        try { localStorage.setItem('customize-room-layouts', JSON.stringify([...roomLayouts])); } catch {}
        modal.close();
        renderRooms();
        announce(entry.name + ' deleted.');
      } catch {
        failure.textContent = 'The space could not be deleted. Try again.';
      }
    }),
    button('Keep space', 'quiet', () => modal.close()),
    failure,
  );
}

async function openRoomPicker(product) {
  const options = element('div', 'room-options');
  const recordRoom = button('Record a space', 'primary', () => openRoomRecorder(product));
  for (const sample of scenes) {
    const control = button('', '', () => openRoom(sample, product));
    control.append(shopImage(sample.src), element('span', '', sample.label));
    options.append(control);
  }
  const savedOptions = element('div', 'saved-room-options');
  dialog(currentPage === 'preview' ? 'Change space' : 'See it in your space', savedOptions, options, recordRoom);
  try {
    const rooms = await savedRoomStore('readonly', (store) => store.getAll());
    for (const entry of rooms) {
      savedOptions.append(button(entry.name, 'quiet', () => openRoom(entry, product)));
    }
  } catch {
    savedOptions.textContent = 'Saved spaces could not be loaded.';
  }
}

function openRoomRecorder(product) {
  let photos = [];
  let mode = 'angles';
  const form = element('form', 'room-form');
  const name = element('input');
  name.id = 'new-room-name';
  name.placeholder = 'e.g. Living room';
  name.maxLength = 60;
  name.required = true;
  const label = element('label', '', 'Space name');
  label.htmlFor = name.id;
  const modes = element('div', 'mode-switch');
  const anglesMode = button('Four angles', 'quiet', () => setMode('angles'));
  const panoramaMode = button('Panorama', 'quiet', () => setMode('panorama'));
  modes.append(anglesMode, panoramaMode);
  const camera = element('input');
  camera.type = 'file';
  camera.accept = 'image/*';
  camera.setAttribute('capture', 'environment');
  camera.hidden = true;
  const upload = element('input');
  upload.type = 'file';
  upload.accept = 'image/*';
  upload.multiple = true;
  upload.hidden = true;
  const status = element('p');
  status.setAttribute('role', 'status');
  const capture = button('Take a photo', 'quiet', () => camera.click());
  const choose = button('Choose photos', 'quiet', () => upload.click());
  const save = element('button', 'primary', product ? 'Save space and preview' : 'Save space');
  save.disabled = true;
  const limit = () => (mode === 'panorama' ? 1 : 4);
  function refresh(extra = '') {
    anglesMode.setAttribute('aria-pressed', String(mode === 'angles'));
    panoramaMode.setAttribute('aria-pressed', String(mode === 'panorama'));
    capture.textContent = mode === 'panorama' ? 'Take a panorama' : 'Take a photo';
    choose.textContent = mode === 'panorama' ? 'Choose a panorama' : 'Choose photos';
    upload.multiple = mode === 'angles';
    const done = photos.length >= limit();
    capture.disabled = choose.disabled = done;
    save.disabled = !photos.length;
    const guide = mode === 'panorama'
      ? (photos.length ? 'Panorama added. Drag across the space after saving to look around.'
        : 'Use your camera’s panorama mode and sweep slowly left to right, then add the wide photo.')
      : (photos.length >= 4 ? 'All four angles added.' : anglePrompts[photos.length]);
    status.textContent = [extra, guide].filter(Boolean).join(' ');
  }
  function setMode(next) {
    if (next === mode) return;
    mode = next;
    photos = [];
    refresh();
  }
  async function addPhotos(event) {
    const files = [...event.target.files].slice(0, limit() - photos.length);
    event.target.value = '';
    capture.disabled = choose.disabled = save.disabled = true;
    const { accepted, rejected } = await decodePhotos(files);
    photos.push(...accepted);
    refresh(photos.length + ' of ' + limit() + ' added.' + (rejected ? ' Some photos could not be opened.' : ''));
  }
  camera.addEventListener('change', addPhotos);
  upload.addEventListener('change', addPhotos);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!photos.length || !name.value.trim()) return;
    save.disabled = true;
    capture.disabled = choose.disabled = true;
    const entry = { id: crypto.randomUUID(), name: name.value.trim(), kind: mode, photos };
    if (mode === 'angles') entry.angleNames = photos.map((_, index) => defaultAngleNames[index]);
    try {
      await savedRoomStore('readwrite', (store) => store.add(entry));
      if (!form.isConnected || !modal.open) return;
      if (product) openRoom(entry, product);
      else {
        modal.close();
        showPage('rooms');
        announce(entry.name + ' saved.');
      }
    } catch {
      refresh('The space could not be saved. Try again.');
      save.disabled = false;
    }
  });
  form.append(label, name, modes, status, capture, choose, camera, upload, save);
  refresh();
  dialog('Record a space', form);
}

for (const page of mainPages) {
  get('nav-' + page).addEventListener('click', () => {
    tryingFromDiscover = false;
    showPage(page);
  });
}
get('open-search').addEventListener('click', () => {
  tryingFromDiscover = false;
  showPage('discover');
  carouselSearch.focus({ preventScroll: true });
});
// Category chips scroll sideways on narrow screens; the heart beside them toggles Saved on and off.
const shopFilters = get('shop-filters');
function updateFilterFade() {
  const end = shopFilters.scrollLeft + shopFilters.clientWidth >= shopFilters.scrollWidth - 4;
  shopFilters.classList.toggle('more-right', !end);
  shopFilters.classList.toggle('more-left', shopFilters.scrollLeft > 4);
}
shopFilters.addEventListener('scroll', updateFilterFade, { passive: true });
addEventListener('resize', updateFilterFade);
for (const category of document.querySelectorAll('[data-category]')) {
  category.addEventListener('click', () => {
    const chosen = category.dataset.category === 'Saved' && shopCategory === 'Saved' ? 'All' : category.dataset.category;
    shopCategory = chosen;
    for (const control of document.querySelectorAll('[data-category]')) {
      control.setAttribute('aria-pressed', String(control.dataset.category === chosen));
    }
    const chip = shopFilters.querySelector('[data-category="' + chosen + '"]');
    chip?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    renderShop();
  });
}
requestAnimationFrame(updateFilterFade);
get('record-room').addEventListener('click', () => openRoomRecorder());
updateCartCount();

const carousel = get('product-carousel');
const carouselLayout = carousel.querySelector('.carousel-layout');
const carouselDisplay = get('carousel-display');
const carouselSearch = get('carousel-search');
let carouselProducts = [];
let carouselIndex = 0;
let swipeStart;

function roomKey() {
  return layoutKey(activeRoom, angleIndex);
}

function saveRoomLayout() {
  roomLayouts.set(roomKey(), { ...roomLayouts.get(roomKey()), points });
  try { localStorage.setItem('customize-room-layouts', JSON.stringify([...roomLayouts])); } catch {}
  renderAngleStrip();
}

const hintForRoom = () => placementMode ? (productToPlace ? 'Tap the photo to place ' + productToPlace.name + '.' : 'Tap the photo to add a point.')
  : points.some((point) => point.product) ? 'Tap a product for options.'
  : points.length ? 'Tap an empty point to choose a product.'
  : 'Tap + to add a placement point.';

const depthFactor = (y) => 0.7 + 0.5 * y;

// Rendered pixels per natural photo pixel, so a saved scale survives resizing and rotating the phone.
function renderScale() {
  if (!room.naturalWidth) return 1;
  const height = stage.clientHeight / room.naturalHeight;
  return isPanorama() ? height : Math.max(stage.clientWidth / room.naturalWidth, height);
}

const calibration = () => (activeRoom ? roomLayouts.get(roomKey())?.scale : undefined);

// Calibrated rooms draw products at real centimetres. Others use a rough catalog guess.
// Both shrink a little higher in the photo and follow the size slider.
function productHeight(point, product) {
  const scale = calibration();
  if (scale && product.height_cm) {
    const fromReference = depthFactor(point.y) / depthFactor(scale.refY);
    return Math.max(24, product.height_cm * scale.pxPerCm * renderScale() * fromReference * (point.size || 1));
  }
  return Math.max(40, stage.clientHeight * (product.scale || 0.28) * 0.55 * depthFactor(point.y) * (point.size || 1));
}

/* ---------- set scale ---------- */

let scaleTaps = null;

function updateScaleButton() {
  const control = get('set-scale');
  control.textContent = calibration() ? 'Scale set ✓' : 'Set scale';
  control.classList.toggle('is-active', Boolean(scaleTaps));
}

function drawScaleOverlay() {
  const layer = get('scale-layer');
  if (!scaleTaps?.length) return layer.replaceChildren();
  const pct = (value) => value * 100 + '%';
  const [a, b] = scaleTaps;
  const dots = scaleTaps.map((tap) => '<circle cx="' + pct(tap.x) + '" cy="' + pct(tap.y) + '" r="7"/>').join('');
  const line = b ? '<line x1="' + pct(a.x) + '" y1="' + pct(a.y) + '" x2="' + pct(b.x) + '" y2="' + pct(b.y) + '"/>' : '';
  layer.innerHTML = '<svg width="100%" height="100%" aria-hidden="true">' + line + dots + '</svg>';
}

function startScale() {
  modal.close();
  scaleTaps = [];
  placementMode = false;
  stage.classList.remove('moving');
  stage.classList.add('scaling');
  get('room-step').textContent = 'Tap one end of something you know the size of, like a sofa or a door.';
  drawScaleOverlay();
  updateScaleButton();
}

function stopScale() {
  scaleTaps = null;
  stage.classList.remove('scaling');
  drawScaleOverlay();
  updateScaleButton();
  get('room-step').textContent = hintForRoom();
}

function scaleTap(x, y) {
  scaleTaps.push({ x, y });
  drawScaleOverlay();
  if (scaleTaps.length === 1) {
    get('room-step').textContent = 'Now tap the other end.';
    return;
  }
  const [a, b] = scaleTaps;
  const pixels = Math.hypot((b.x - a.x) * pan.clientWidth, (b.y - a.y) * stage.clientHeight);
  const refY = (a.y + b.y) / 2;
  const form = element('form', 'room-form');
  const label = element('label', '', 'How long is it in real life? (cm)');
  const input = element('input');
  input.id = 'scale-length';
  input.type = 'number';
  input.min = '5';
  input.max = '1000';
  input.step = 'any';
  input.inputMode = 'decimal';
  input.required = true;
  input.placeholder = 'e.g. 200';
  label.htmlFor = input.id;
  const note = element('p', '', 'Products will be drawn at their real height. A product placed much nearer or farther than this object will look a little off.');
  const status = element('p');
  status.setAttribute('role', 'status');
  form.append(label, input, note, element('button', 'primary', 'Save scale'), button('Measure again', 'quiet', startScale), status);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const centimetres = Number(input.value);
    if (!(centimetres >= 5 && centimetres <= 1000)) return (status.textContent = 'Enter a length between 5 and 1000 cm.');
    if (pixels < 24) return (status.textContent = 'Those two points are too close together. Measure again with points farther apart.');
    const layout = roomLayouts.get(roomKey()) || { points };
    roomLayouts.set(roomKey(), { ...layout, points, scale: { pxPerCm: pixels / renderScale() / centimetres, refY } });
    try { localStorage.setItem('customize-room-layouts', JSON.stringify([...roomLayouts])); } catch {}
    modal.close();
    stopScale();
    renderPoints();
    announce('Scale saved. Products now show at real size.');
  });
  dialog('Set scale', form);
  input.focus();
}

get('set-scale').addEventListener('click', () => {
  if (scaleTaps) return stopScale();
  if (!calibration()) return startScale();
  dialog('Scale',
    element('p', '', 'This space angle already has a scale.'),
    button('Measure again', 'primary', startScale),
    button('Clear scale', 'quiet', () => {
      const layout = roomLayouts.get(roomKey());
      roomLayouts.set(roomKey(), { ...layout, scale: undefined });
      try { localStorage.setItem('customize-room-layouts', JSON.stringify([...roomLayouts])); } catch {}
      modal.close();
      updateScaleButton();
      renderPoints();
    }),
  );
});

function updateRoomCart() {
  const bar = get('room-cart');
  const placed = points.filter((point) => point.product);
  bar.hidden = !placed.length;
  if (bar.hidden) return;
  const total = placed.reduce((sum, point) => sum + point.product.price, 0);
  get('room-cart-info').textContent = placed.length + (placed.length === 1 ? ' item · ' : ' items · ') + money(total);
}

get('room-cart-add').addEventListener('click', () => {
  const counts = new Map();
  for (const point of points) if (point.product) counts.set(point.product, (counts.get(point.product) || 0) + 1);
  for (const [product, count] of counts) {
    changeQuantity(product, count);
    noteCartRoom(product);
  }
  announce('Added to cart.');
  showPage('cart');
});

const placementCue = stage.querySelector('.placement-cue');
function moveCue(event) {
  if (!placementMode) return;
  const area = pan.getBoundingClientRect();
  const box = stage.getBoundingClientRect();
  // Same limits as markPoint, so the product lands exactly under the crosshair.
  const x = area.left + Math.min(.93, Math.max(.07, (event.clientX - area.left) / area.width)) * area.width;
  const y = area.top + Math.min(.88, Math.max(.22, (event.clientY - area.top) / area.height)) * area.height;
  placementCue.style.left = x - box.left + 'px';
  placementCue.style.top = y - box.top + 'px';
}
stage.addEventListener('pointermove', moveCue);
stage.addEventListener('pointerdown', moveCue);

function renderPoints() {
  updateRoomCart();
  if (placementMode && !stage.classList.contains('moving')) placementCue.style.left = placementCue.style.top = '';
  stage.classList.toggle('moving', placementMode);
  get('placement-cue-label').textContent = productToPlace ? 'Tap to place' : 'Tap to mark a point';
  get('room-step').textContent = hintForRoom();
  placement.replaceChildren(...points.map((point, index) => {
    const pin = button('', 'room-point', () => {
      if (point.product) openItemSheet(point);
      else openCarousel(index);
    });
    pin.style.left = point.x * 100 + '%';
    pin.style.top = point.y * 100 + '%';
    pin.setAttribute('aria-label', 'Point ' + (index + 1) + (point.product ? ': ' + point.product.name : ''));
    if (point.product) {
      attachMovableProduct(pin, point, point.product);
    } else {
      const marker = element('span', '', '+');
      marker.setAttribute('aria-hidden', 'true');
      pin.append(marker);
    }
    return pin;
  }));
}

function browseFromPoint(point, replacing = false) {
  roomVisit = { room: activeRoom, angle: angleIndex, point, product: preferredProduct, replacing };
  discoverProductId = point.product.id;
  showPage('discover');
  get('discover-back').focus({ preventScroll: true });
}

function resumeRoom(visit) {
  roomVisit = undefined;
  openRoom(visit.room, visit.product, visit.angle, true);
}

function startMove(point) {
  const target = placement.children[points.indexOf(point)];
  placement.querySelector('.is-moving')?.classList.remove('is-moving');
  target?.classList.add('is-moving');
  get('room-step').textContent = 'Drag the product to move it.';
}

// Replacing from Discover keeps the older choice dialog.
function showItemActions(point, nextProduct) {
  const actions = element('div', 'room-item-actions');
  actions.append(
    button('Move', 'quiet', () => {
      resumeRoom(roomVisit);
      modal.close();
      startMove(point);
    }),
    button('Replace', 'primary', () => {
      modal.close();
      const visit = roomVisit;
      point.product = nextProduct;
      resumeRoom(visit);
      saveRoomLayout();
      record({ kind: 'preview', product_id: nextProduct.id }).catch(() => {});
    }),
    button('Remove', 'quiet', () => {
      modal.close();
      point.product = undefined;
      resumeRoom(roomVisit);
      saveRoomLayout();
      renderPoints();
    }),
  );
  dialog(point.product.name, element('p', '', 'Replace with ' + nextProduct.name + ', or edit the current placement.'), actions);
}

function openItemSheet(point) {
  const product = productById(point.product.id) || point.product;
  const head = element('div', 'sheet-head');
  const info = element('div', 'sheet-info');
  const shownCm = () => Math.round(product.height_cm * (point.size || 1));
  const sizeNote = element('p', '', money(product.price) + ' · ' + (calibration() ? 'Shown at ' + shownCm() + ' cm tall' : product.size));
  info.append(element('h2', '', product.name), sizeNote);
  const close = button('×', 'quiet sheet-close', () => itemSheet.close());
  close.setAttribute('aria-label', 'Close');
  head.append(shopImage(productImage(product.id), 'sheet-photo'), info, heartButton(product, 'heart heart-inline'), close);

  const slider = element('input');
  slider.type = 'range';
  slider.id = 'item-size';
  slider.min = '50';
  slider.max = '160';
  slider.step = '5';
  slider.value = String(Math.round((point.size || 1) * 100));
  const sizeLabel = element('label', '', 'Size');
  sizeLabel.htmlFor = slider.id;
  const sizeValue = element('output', '', slider.value + '%');
  slider.addEventListener('input', () => {
    point.size = Number(slider.value) / 100;
    sizeValue.textContent = slider.value + '%';
    if (calibration()) sizeNote.textContent = money(product.price) + ' · Shown at ' + shownCm() + ' cm tall';
    const image = placement.children[points.indexOf(point)]?.querySelector('.point-product');
    if (image) image.style.height = productHeight(point, product) + 'px';
  });
  slider.addEventListener('change', saveRoomLayout);
  const size = element('div', 'size-control');
  size.append(sizeLabel, slider, sizeValue);

  const tool = (text, path, action) => {
    const control = button('', 'sheet-tool', action);
    control.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + path + '"/></svg>';
    control.append(element('span', '', text));
    return control;
  };
  const tools = element('div', 'sheet-tools');
  tools.append(
    tool('Swap', 'M4 7h13l-3-3m6 13H7l3 3', () => { itemSheet.close(); browseFromPoint(point, true); }),
    tool('Move', 'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3', () => { itemSheet.close(); startMove(point); }),
    tool('Copy', 'M8 8h12v12H8zM4 16V4h12', () => {
      itemSheet.close();
      points.push({ ...point, x: Math.min(0.93, point.x + 0.14), y: point.y });
      saveRoomLayout();
      renderPoints();
      announce('Copied. Drag it to a new spot.');
    }),
    tool('Remove', 'M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3', () => {
      itemSheet.close();
      point.product = undefined;
      saveRoomLayout();
      renderPoints();
    }),
  );
  const addCart = button('Add to cart', 'primary', () => {
    noteCartRoom(product);
    addToCart(product);
    itemSheet.close();
  });
  const tail = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  tail.setAttribute('class', 'sheet-tail');
  tail.setAttribute('viewBox', '0 0 72 34');
  tail.setAttribute('aria-hidden', 'true');
  tail.innerHTML = '<path d="M0 0C22 0 27 34 36 34S50 0 72 0Z"/>';
  itemSheet.replaceChildren(head, tools, size, addCart, tail);
  sheetPoint = point;
  if (!itemSheet.open) {
    itemSheet.showModal();
    sheetOpenedAt = performance.now();
  }
  positionItemSheet();
  addCart.focus({ preventScroll: true });
}

// The options bubble sits above the plant with its tail pointing at it, or below when there is no room.
let sheetPoint;
let sheetOpenedAt = 0;
function positionItemSheet() {
  const pin = placement.children[points.indexOf(sheetPoint)];
  const art = (pin?.querySelector('.point-product') || pin)?.getBoundingClientRect();
  if (!art || !itemSheet.open) return;
  const margin = 10;
  const tailHeight = 40;
  const width = itemSheet.offsetWidth;
  const height = itemSheet.offsetHeight;
  const centre = art.left + art.width / 2;
  const left = Math.min(innerWidth - width - margin, Math.max(margin, centre - width / 2));
  const roomAbove = art.top - tailHeight - margin;
  const roomBelow = innerHeight - art.bottom - tailHeight - margin;
  const below = height > roomAbove && roomBelow > roomAbove;
  const top = Math.min(innerHeight - height - margin, Math.max(margin, below ? art.bottom + tailHeight : art.top - tailHeight - height));
  itemSheet.style.left = left + 'px';
  itemSheet.style.top = top + 'px';
  itemSheet.dataset.side = below ? 'below' : 'above';
  itemSheet.style.setProperty('--tail-x', Math.min(width - 44, Math.max(44, centre - left)) + 'px');
}
addEventListener('resize', positionItemSheet);
itemSheet.addEventListener('click', (event) => {
  // Close only for clicks outside the bubble, and never for the click that belongs to the tap that opened it.
  if (event.target !== itemSheet || performance.now() - sheetOpenedAt < 350) return;
  const box = itemSheet.getBoundingClientRect();
  const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
  if (!inside) itemSheet.close();
});
itemSheet.addEventListener('close', saveRoomLayout);

function attachMovableProduct(pin, point, product) {
  const image = shopImage(productImage(product.id), 'point-product');
  image.draggable = false;
  image.style.height = productHeight(point, product) + 'px';
  pin.append(image);
  let gesture;

  const position = (x, y) => {
    point.x = x;
    point.y = y;
    pin.style.left = x * 100 + '%';
    pin.style.top = y * 100 + '%';
    image.style.height = productHeight(point, product) + 'px';
  };
  let draggedAt = 0;
  // Open the options on click, not pointerup: a touch tap's click would otherwise land on the
  // just-opened sheet's backdrop and close it again.
  image.addEventListener('click', (event) => {
    event.stopPropagation();
    if (performance.now() - draggedAt < 400) return;
    openItemSheet(point);
  });
  image.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    const bounds = pan.getBoundingClientRect();
    const art = image.getBoundingClientRect();
    gesture = {
      id: event.pointerId, bounds, x: point.x, y: point.y,
      startX: event.clientX, startY: event.clientY,
      topOffset: point.y - (art.top - bounds.top) / bounds.height,
      halfWidth: art.width / bounds.width / 2,
      moved: false,
    };
    image.setPointerCapture(event.pointerId);
  });
  image.addEventListener('pointermove', (event) => {
    if (gesture?.id !== event.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.moved && Math.hypot(dx, dy) < 7) return;
    if (!gesture.moved) pin.classList.add('is-moving');
    gesture.moved = true;
    const { bounds, x, y, halfWidth, topOffset } = gesture;
    position(
      Math.max(halfWidth, Math.min(1 - halfWidth, x + dx / bounds.width)),
      Math.max(topOffset, Math.min(.95, y + dy / bounds.height)),
    );
  });
  const finish = (event) => {
    if (gesture?.id !== event.pointerId) return;
    const { x, y, moved } = gesture;
    gesture = undefined;
    if (event.type !== 'pointerup') {
      if (moved) position(x, y);
      pin.classList.remove('is-moving');
    } else if (moved) {
      draggedAt = performance.now();
      pin.classList.remove('is-moving');
      saveRoomLayout();
      get('room-step').textContent = hintForRoom();
    } else {
      pin.classList.remove('is-moving');
      get('room-step').textContent = hintForRoom();
    }
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    image.addEventListener(type, finish);
  }
}

function markPoint(x, y) {
  if (!placementMode) return;
  points.push({ x, y, product: productToPlace });
  if (productToPlace) record({ kind: 'preview', product_id: productToPlace.id }).catch(() => {});
  placementMode = false;
  saveRoomLayout();
  renderPoints();
}

get('add-room-point').addEventListener('click', () => {
  function startPlacement(product) {
    productToPlace = product;
    placementMode = true;
    modal.close();
    renderPoints();
  }

  const actions = element('div', 'room-item-actions');
  if (preferredProduct) {
    actions.append(button('Place ' + preferredProduct.name, 'primary', () => startPlacement(preferredProduct)));
  }
  actions.append(button('Mark an empty point', preferredProduct ? 'quiet' : 'primary', () => startPlacement()));
  dialog('Add placement point', actions);
});

// Dragging the photo pans a panorama or swipes between angles. A short tap still places a point.
let stageDrag;
let lastDragEnd = -Infinity;
stage.addEventListener('pointerdown', (event) => {
  if (!event.isPrimary || event.button !== 0 || event.target.closest('button, .point-product')) return;
  stageDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, offset: panOffset ?? 0, moved: false };
});
stage.addEventListener('pointermove', (event) => {
  if (stageDrag?.id !== event.pointerId) return;
  const dx = event.clientX - stageDrag.x;
  if (!stageDrag.moved && Math.hypot(dx, event.clientY - stageDrag.y) < 8) return;
  if (!stageDrag.moved) stage.setPointerCapture(event.pointerId);
  stageDrag.moved = true;
  if (panMax) {
    panOffset = Math.max(0, Math.min(panMax, stageDrag.offset - dx));
    applyPan();
  }
});
const endStageDrag = (event) => {
  if (stageDrag?.id !== event.pointerId) return;
  const { x, y, moved } = stageDrag;
  stageDrag = undefined;
  if (!moved) return;
  lastDragEnd = performance.now();
  const dx = event.clientX - x;
  const dy = event.clientY - y;
  if (event.type === 'pointerup' && !panMax && !placementMode && Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy) * 1.4) {
    switchAngle(dx < 0 ? 1 : -1);
  }
};
stage.addEventListener('pointerup', endStageDrag);
stage.addEventListener('pointercancel', endStageDrag);

stage.addEventListener('click', (event) => {
  if (event.target.closest('button')) return;
  if (performance.now() - lastDragEnd < 350) return;
  const bounds = pan.getBoundingClientRect();
  if (scaleTaps) {
    if (scaleTaps.length >= 2) return;
    return scaleTap(
      Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    );
  }
  markPoint(
    Math.min(.93, Math.max(.07, (event.clientX - bounds.left) / bounds.width)),
    Math.min(.88, Math.max(.22, (event.clientY - bounds.top) / bounds.height)),
  );
});
get('change-space').addEventListener('click', () => {
  if (tryingFromDiscover) openRoomPicker(preferredProduct);
  else showPage('rooms');
});

function openCarousel(index) {
  activePoint = index;
  carousel.append(carouselLayout);
  carouselSearch.value = '';
  setSearchMode(false);
  filterCarousel(preferredProduct?.id);
  carousel.showModal();
  placement.hidden = true;
}

function filterCarousel(preferred) {
  const terms = carouselSearch.value.trim().toLowerCase().split(/\s+/);
  carouselProducts = profile.products.filter((product) => {
    const searchable = [product.name, product.vessel, product.description, ...product.tags].join(' ').toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
  carouselIndex = Math.max(0, carouselProducts.findIndex((product) => product.id === preferred));
  renderCarousel();
}

function renderCarousel(direction = 0) {
  const product = carouselProducts[carouselIndex];
  const count = carouselProducts.length;
  const images = [];
  if (product) {
    for (const [offset, position] of [[-1, 'previous'], [1, 'next'], [0, 'current']]) {
      if (offset && count < 2) continue;
      const item = carouselProducts[(carouselIndex + offset + count) % count];
      const image = shopImage(productImage(item.id), 'carousel-image carousel-' + position);
      image.draggable = false;
      images.push(image);
    }
  }
  const previousLayer = carouselDisplay.lastElementChild;
  const layer = element('div', 'carousel-layer');
  layer.append(...images);
  carouselDisplay.replaceChildren(layer);
  if (previousLayer && direction && !reduceMotion.matches) {
    for (const animation of previousLayer.getAnimations()) animation.cancel();
    carouselDisplay.prepend(previousLayer);
    const options = { duration: 340, easing: 'cubic-bezier(.2,.72,.24,1)' };
    const outgoing = previousLayer.animate([
      { transform: 'translateX(0)', opacity: 1 },
      { transform: 'translateX(' + direction * -18 + '%)', opacity: 0 },
    ], options);
    outgoing.onfinish = () => previousLayer.remove();
    layer.animate([
      { transform: 'translateX(' + direction * 18 + '%)', opacity: 0 },
      { transform: 'translateX(0)', opacity: 1 },
    ], options);
  }
  get('carousel-name').textContent = product?.name || 'No matching products';
  get('carousel-price').textContent = product ? money(product.price) : '';
  get('carousel-cart').setAttribute('aria-label', product ? 'Add ' + product.name + ' to cart' : 'Add to cart');
  const save = get('carousel-save');
  if (product) { save.dataset.heart = product.id; setHeart(save); } else { delete save.dataset.heart; save.setAttribute('aria-pressed', 'false'); }
  const discovering = currentPage === 'discover';
  if (discovering && product) discoverProductId = product.id;
  get('carousel-close').hidden = discovering;
  get('carousel-try').hidden = !discovering;
  get('carousel-try').textContent = roomVisit?.replacing ? 'Choose replacement' : 'Try it';
  get('carousel-place').hidden = discovering;
  get('carousel-cart').disabled = get('carousel-place').disabled = get('carousel-try').disabled = save.disabled = !product;
  get('carousel-previous').disabled = get('carousel-next').disabled = count < 2;
  get('carousel-feedback').textContent = '';
}

function stepCarousel(direction) {
  if (carouselProducts.length < 2) return;
  carouselIndex = (carouselIndex + direction + carouselProducts.length) % carouselProducts.length;
  renderCarousel(direction);
}

// On Discover, tapping search swaps the slideshow for a catalog grid. Only the back arrow brings the slideshow back.
const carouselResults = get('carousel-results');
let searchMode = false;
function setSearchMode(on) {
  searchMode = on;
  carouselLayout.classList.toggle('searching', on);
  carouselResults.hidden = !on;
  if (on) renderResults();
}
function renderResults() {
  if (!carouselProducts.length) {
    carouselResults.replaceChildren(element('p', 'empty-state', 'No products match “' + carouselSearch.value.trim() + '”.'));
    return;
  }
  carouselResults.replaceChildren(...carouselProducts.map(productItem));
}
carouselSearch.addEventListener('focus', () => {
  if (currentPage === 'discover' && !searchMode) setSearchMode(true);
});
carouselSearch.addEventListener('input', () => {
  filterCarousel(carouselProducts[carouselIndex]?.id);
  if (searchMode) renderResults();
});
get('discover-back').addEventListener('click', () => {
  if (searchMode) {
    carouselSearch.value = '';
    carouselSearch.blur();
    setSearchMode(false);
    filterCarousel(discoverProductId);
    window.scrollTo({ top: 0, behavior: 'instant' });
    return;
  }
  if (roomVisit) return resumeRoom(roomVisit);
  showPage(discoverReturnPage);
  get('nav-' + discoverReturnPage)?.focus({ preventScroll: true });
});
get('close-room').addEventListener('click', () => {
  showPage(roomReturnPage);
  const backTarget = { discover: 'discover-back', rooms: 'nav-rooms', product: 'product-page' };
  const target = get(backTarget[roomReturnPage]);
  (roomReturnPage === 'product' ? target?.querySelector('.detail-back') : target)?.focus({ preventScroll: true });
});
get('carousel-try').addEventListener('click', () => {
  const product = carouselProducts[carouselIndex];
  discoverProductId = product.id;
  if (roomVisit?.point.product) {
    showItemActions(roomVisit.point, product);
  } else openRoomPicker(product);
});
get('carousel-close').addEventListener('click', () => carousel.close());
get('carousel-previous').addEventListener('click', () => stepCarousel(-1));
get('carousel-next').addEventListener('click', () => stepCarousel(1));
get('carousel-save').addEventListener('click', () => {
  const product = carouselProducts[carouselIndex];
  if (product) toggleSave(product);
});
get('carousel-place').addEventListener('click', () => {
  const product = carouselProducts[carouselIndex];
  points[activePoint].product = product;
  saveRoomLayout();
  renderPoints();
  carousel.close();
  placement.hidden = false;
  record({ kind: 'preview', product_id: product.id }).catch(() => {});
});
get('carousel-cart').addEventListener('click', () => {
  const product = carouselProducts[carouselIndex];
  addToCart(product);
  get('carousel-feedback').textContent = 'Added to cart.';
});
carousel.addEventListener('close', () => {
  swipeStart = undefined;
  placement.hidden = false;
  placement.children[activePoint]?.focus({ preventScroll: true });
});
carouselLayout.addEventListener('keydown', (event) => {
  if (event.target === carouselSearch || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  stepCarousel(event.key === 'ArrowLeft' ? -1 : 1);
});
carouselDisplay.addEventListener('pointerdown', (event) => {
  if (!event.isPrimary || event.button !== 0) return;
  swipeStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
  carouselDisplay.setPointerCapture(event.pointerId);
});
carouselDisplay.addEventListener('pointerup', (event) => {
  if (swipeStart?.id !== event.pointerId) return;
  const dx = event.clientX - swipeStart.x;
  const dy = event.clientY - swipeStart.y;
  swipeStart = undefined;
  if (Math.abs(dx) >= 32 && Math.abs(dx) > Math.abs(dy)) stepCarousel(dx > 0 ? -1 : 1);
});
carouselDisplay.addEventListener('pointercancel', () => { swipeStart = undefined; });

// A short first-run tour. It points at real controls on the Shop page, one at a time.
const tourSteps = [
  { target: () => document.querySelector('#shop-grid .try-in-room'), title: 'Try before you buy',
    text: 'Tap Try in space on any plant. It opens your space with that plant ready to place.' },
  { target: () => document.querySelector('#shop-grid .heart'), title: 'Save what you like',
    text: 'Tap the heart to keep a plant. Saved plants also shape what we pick for you.' },
  { target: () => get('nav-rooms'), title: 'Your spaces',
    text: 'Choose a sample space or record your own. Tap your space to place plants, then drag to move or resize them.' },
  { target: () => get('nav-cart'), title: 'Add the whole space at once',
    text: 'In a space, Add all to cart puts everything you placed into the cart. Checkout is a demo.' },
];
let tourEl;
function endTour() {
  tourEl?.remove();
  tourEl = null;
  window.removeEventListener('resize', drawTour);
  try { localStorage.setItem('customize-tour-done', '1'); } catch {}
}
let tourIndex = 0;
function drawTour() {
  if (!tourEl) return;
  const step = tourSteps[tourIndex];
  const target = step.target();
  const rect = target?.getBoundingClientRect();
  const hole = tourEl.querySelector('.tour-hole');
  const card = tourEl.querySelector('.tour-card');
  if (rect && rect.width) {
    Object.assign(hole.style, { display: 'block', left: rect.left - 6 + 'px', top: rect.top - 6 + 'px',
      width: rect.width + 12 + 'px', height: rect.height + 12 + 'px' });
  } else hole.style.display = 'none';
  tourEl.querySelector('.tour-count').textContent = (tourIndex + 1) + ' of ' + tourSteps.length;
  tourEl.querySelector('.tour-title').textContent = step.title;
  tourEl.querySelector('.tour-text').textContent = step.text;
  tourEl.querySelector('.tour-next').textContent = tourIndex === tourSteps.length - 1 ? 'Try it hands-on' : 'Next';
  const below = !rect || rect.top < innerHeight / 2;
  const width = Math.min(320, innerWidth - 24);
  card.style.width = width + 'px';
  card.style.left = Math.max(12, Math.min(innerWidth - width - 12, rect ? rect.left + rect.width / 2 - width / 2 : 12)) + 'px';
  card.style.top = below ? (rect ? rect.bottom + 16 : 80) + 'px' : 'auto';
  card.style.bottom = below ? 'auto' : innerHeight - rect.top + 16 + 'px';
}
function startTour() {
  if (tourEl) return;
  showPage('shop');
  tourIndex = 0;
  tourEl = element('div', 'tour');
  tourEl.setAttribute('role', 'dialog');
  tourEl.setAttribute('aria-label', 'Quick tour');
  tourEl.innerHTML = '<div class="tour-hole"></div><div class="tour-card"><span class="tour-count"></span>' +
    '<h2 class="tour-title"></h2><p class="tour-text"></p><div class="tour-actions">' +
    '<button type="button" class="quiet tour-skip">Skip tour</button><button type="button" class="primary tour-next"></button></div></div>';
  tourEl.querySelector('.tour-skip').addEventListener('click', endTour);
  tourEl.querySelector('.tour-next').addEventListener('click', () => {
    if (tourIndex === tourSteps.length - 1) { endTour(); startWalkthrough(); }
    else { tourIndex += 1; drawTour(); }
  });
  document.body.append(tourEl);
  window.addEventListener('resize', drawTour);
  drawTour();
  tourEl.querySelector('.tour-next').focus();
}

// Hands-on walkthrough. Everything except the control the shopper must use is blurred and blocked.
// Each step waits for the shopper to really do the thing, then moves on by itself.
const wtState = { on: false, i: 0, base: {}, root: null, frame: 0, ticks: 0, advancing: false };
const wtPlaced = () => points.filter((point) => point.product);
const wtPins = () => [...placement.querySelectorAll('.room-point')].filter((pin) => pin.querySelector('.point-product'));
const wtByText = (selector, text) => [...document.querySelectorAll(selector)].find((node) => node.textContent.trim().startsWith(text));
const wtSteps = [
  { title: 'Pick a plant', text: 'Tap Try in space on the first plant.',
    enter: () => showPage('shop'), target: () => document.querySelector('#shop-grid .try-in-room'), done: () => currentPage === 'preview' },
  { title: 'Place it', text: 'Tap the photo where the plant should stand.',
    enter: () => { wtState.base.n = wtPlaced().length; }, target: () => stage, done: () => wtPlaced().length > wtState.base.n },
  { title: 'Open its options', text: 'Tap the plant you just placed.',
    target: () => wtPins().at(-1)?.querySelector('.point-product'), done: () => itemSheet.open },
  { title: 'Change its size', text: 'Drag the Size slider to make the plant bigger or smaller.', delay: 900,
    enter: () => { wtState.base.pt = wtPlaced().at(-1); wtState.base.size = wtState.base.pt?.size || 1; },
    target: () => get('item-size'), done: () => (wtState.base.pt?.size || 1) !== wtState.base.size },
  { title: 'Copy it', text: 'Tap Copy to place a second one.',
    enter: () => { wtState.base.n = wtPlaced().length; }, target: () => wtByText('.sheet-tool', 'Copy'), done: () => wtPlaced().length > wtState.base.n },
  { title: 'Open options again', text: 'Tap the first plant.',
    target: () => wtPins().at(0)?.querySelector('.point-product'), done: () => itemSheet.open },
  { title: 'Move it', text: 'Tap Move.',
    target: () => wtByText('.sheet-tool', 'Move'), done: () => Boolean(placement.querySelector('.is-moving')) },
  { title: 'Drag it', text: 'Drag the plant to a new spot.', free: true, delay: 500,
    enter: () => {
      const index = [...placement.children].indexOf(placement.querySelector('.is-moving'));
      wtState.base.pt = points[index];
      wtState.base.x = wtState.base.pt?.x; wtState.base.y = wtState.base.pt?.y;
    },
    target: () => placement.querySelector('.is-moving .point-product'),
    done: () => Boolean(wtState.base.pt) && Math.abs(wtState.base.pt.x - wtState.base.x) + Math.abs(wtState.base.pt.y - wtState.base.y) > 0.03 },
  { title: 'Swap for another plant', text: 'Tap a plant to open its options.',
    target: () => wtPins().at(0)?.querySelector('.point-product'), done: () => itemSheet.open },
  { title: 'Swap', text: 'Tap Swap.',
    target: () => wtByText('.sheet-tool', 'Swap'), done: () => currentPage === 'discover' },
  { title: 'Choose another plant', text: 'Swipe or use the arrows to look at other plants, then tap Choose replacement.', free: true,
    target: () => get('discover-page'), done: () => modal.open,
    avoid: () => [carouselDisplay.querySelector('.carousel-current'), carouselLayout.querySelector('.carousel-caption'), carouselLayout.querySelector('.carousel-actions')],
    soft: () => [carouselLayout.querySelector('.carousel-search'), carouselDisplay.querySelector('.carousel-previous'), carouselDisplay.querySelector('.carousel-next')] },
  { title: 'Replace it', text: 'Tap Replace.',
    target: () => wtByText('#modal button', 'Replace'), done: () => currentPage === 'preview' && !modal.open },
  { title: 'Open options once more', text: 'Tap a plant, then you will remove one.',
    target: () => wtPins().at(-1)?.querySelector('.point-product'), done: () => itemSheet.open },
  { title: 'Remove it', text: 'Tap Remove.',
    enter: () => { wtState.base.n = wtPlaced().length; }, target: () => wtByText('.sheet-tool', 'Remove'), done: () => wtPlaced().length < wtState.base.n },
  { title: 'Add the space to your cart', text: 'Tap Add all to cart. Everything you placed goes in.',
    target: () => get('room-cart-add'), done: () => currentPage === 'cart' },
  { title: 'Check out', text: 'Tap Check out.',
    target: () => document.querySelector('.cart-checkout'), done: () => modal.open },
  { title: 'Place the demo order', text: 'Tap Place demo order. No payment is taken.',
    enter: () => { wtState.base.orders = profile.orders.length; },
    target: () => wtByText('#modal button', 'Place demo order'), done: () => profile.orders.length > wtState.base.orders },
  { title: 'Back to your space', text: 'Tap Back to your space to see where it all ended up.',
    target: () => wtByText('#modal button', 'Back to your space'), done: () => currentPage === 'preview' && !modal.open },
  { title: 'You can do it all', text: 'You picked a plant, placed it, resized, copied, moved, swapped and removed plants, and ordered. You are ready to shop.', final: true },
];

function endWalkthrough() {
  wtState.on = false;
  cancelAnimationFrame(wtState.frame);
  wtState.root?.remove();
  wtState.root = null;
  try { localStorage.setItem('customize-walkthrough-done', '1'); } catch {}
}

function wtEnter(index) {
  wtState.i = index;
  wtState.advancing = false;
  wtSteps[index].enter?.();
  const card = wtState.root.querySelector('.wt-card');
  const step = wtSteps[index];
  card.querySelector('.wt-count').textContent = 'Step ' + (index + 1) + ' of ' + wtSteps.length;
  card.querySelector('.wt-title').textContent = step.title;
  card.querySelector('.wt-text').textContent = step.text;
  card.querySelector('.wt-finish').hidden = !step.final;
}

function wtLayout() {
  if (!wtState.on) return;
  const step = wtSteps[wtState.i];
  const root = wtState.root;
  // Dialogs make the rest of the page inert, so the overlay lives inside whichever one is open.
  const dialogOpen = [itemSheet, modal, carousel].find((item) => item.open);
  const parent = dialogOpen || document.body;
  if (root.parentNode !== parent) parent.append(root);
  const target = step.target?.();
  const rect = target?.getBoundingClientRect();
  const has = rect && rect.width > 0 && rect.height > 0;
  const pad = 6;
  const hole = has ? { l: Math.max(0, rect.left - pad), t: Math.max(0, rect.top - pad), r: Math.min(innerWidth, rect.right + pad), b: Math.min(innerHeight, rect.bottom + pad) }
    : { l: 0, t: 0, r: 0, b: 0 };
  const panels = root.querySelectorAll('.wt-panel');
  const boxes = has ? [
    [0, 0, innerWidth, hole.t], [0, hole.b, innerWidth, innerHeight - hole.b],
    [0, hole.t, hole.l, hole.b - hole.t], [hole.r, hole.t, innerWidth - hole.r, hole.b - hole.t],
  ] : [[0, 0, innerWidth, innerHeight], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  panels.forEach((panel, n) => {
    const [x, y, w, h] = boxes[n];
    Object.assign(panel.style, { left: x + 'px', top: y + 'px', width: Math.max(0, w) + 'px', height: Math.max(0, h) + 'px',
      pointerEvents: step.free ? 'none' : 'auto' });
  });
  const ring = root.querySelector('.wt-ring');
  ring.style.display = has ? 'block' : 'none';
  if (has) Object.assign(ring.style, { left: hole.l + 'px', top: hole.t + 'px', width: hole.r - hole.l + 'px', height: hole.b - hole.t + 'px' });
  placeWalkthroughCard(root.querySelector('.wt-card'), step, has ? rect : null);
}

// Put the walkthrough card where it covers nothing the shopper needs: the target, the open options
// bubble or dialog, the plant being edited and any controls the step lists. Tries edges, corners and
// the sides of the target, and keeps the position with the least overlap.
function placeWalkthroughCard(card, step, rect) {
  const width = Math.min(320, innerWidth - 24);
  card.style.width = width + 'px';
  card.style.transform = 'none';
  card.style.bottom = 'auto';
  const height = card.offsetHeight;
  const margin = 12;
  const avoid = [];
  // weight < 1 marks controls the step does not need: covered only when nothing better exists.
  const keep = (node, pad = 8, weight = 1) => {
    const box = node?.getBoundingClientRect?.();
    if (box && box.width && box.height) avoid.push({ l: box.left - pad, t: box.top - pad, r: box.right + pad, b: box.bottom + pad, weight });
  };
  const big = rect && (rect.height > innerHeight * 0.55 || rect.width * rect.height > innerWidth * innerHeight * 0.5);
  // The target matters most; covering it is never acceptable if any other spot exists.
  if (rect && !big) avoid.push({ l: rect.left - 12, t: rect.top - 12, r: rect.right + 12, b: rect.bottom + 12, weight: 20 });
  for (const node of step.avoid?.() || []) keep(node);
  for (const node of step.soft?.() || []) keep(node, 8, 0.05);
  if (itemSheet.open) {
    keep(itemSheet, 12);
    keep(placement.children[points.indexOf(sheetPoint)]?.querySelector('.point-product'));
  }
  // A tall dialog (like checkout on a phone) may be partly covered, but never its target.
  if (modal.open) keep(modal, 12, 0.5);
  if (step.free && rect && !big) keep(stage.querySelector('.is-moving .point-product'), 40);

  const nav = document.querySelector('.shop-nav');
  const navTop = nav && !nav.hidden && nav.offsetParent ? nav.getBoundingClientRect().top : innerHeight;
  const xs = [margin, (innerWidth - width) / 2, innerWidth - width - margin];
  const ys = [72, navTop - height - margin, (innerHeight - height) / 2];
  const candidates = [];
  if (rect && !big) {
    const cx = Math.max(margin, Math.min(innerWidth - width - margin, rect.left + rect.width / 2 - width / 2));
    candidates.push([cx, rect.bottom + 16], [cx, rect.top - height - 16],
      [rect.right + 16, Math.max(72, rect.top + rect.height / 2 - height / 2)], [rect.left - width - 16, Math.max(72, rect.top + rect.height / 2 - height / 2)]);
  }
  for (const y of ys) for (const x of xs) candidates.push([x, y]);
  let best;
  for (const [x0, y0] of candidates) {
    const x = Math.max(margin, Math.min(innerWidth - width - margin, x0));
    const y = Math.max(margin, Math.min(innerHeight - height - margin, y0));
    let overlap = 0;
    for (const box of avoid) {
      overlap += (box.weight ?? 1) * Math.max(0, Math.min(x + width, box.r) - Math.max(x, box.l)) * Math.max(0, Math.min(y + height, box.b) - Math.max(y, box.t));
    }
    if (!best || overlap < best.overlap) best = { x, y, overlap };
    if (overlap === 0) break;
  }
  card.style.left = best.x + 'px';
  card.style.top = best.y + 'px';
  card.dataset.overlap = String(Math.round(best.overlap));
}

function wtTick() {
  if (!wtState.on) return;
  wtLayout();
  wtState.ticks += 1;
  const step = wtSteps[wtState.i];
  if (!wtState.advancing && wtState.ticks % 6 === 0 && step.done?.()) {
    wtState.advancing = true;
    setTimeout(() => {
      if (!wtState.on) return;
      if (wtState.i < wtSteps.length - 1) wtEnter(wtState.i + 1);
    }, step.delay || 350);
  }
  wtState.frame = requestAnimationFrame(wtTick);
}

function startWalkthrough() {
  if (wtState.on) return;
  wtState.on = true;
  const root = element('div', 'wt');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Hands-on walkthrough');
  root.innerHTML = '<div class="wt-panel"></div><div class="wt-panel"></div><div class="wt-panel"></div><div class="wt-panel"></div><div class="wt-ring"></div>' +
    '<div class="wt-card"><span class="wt-count"></span><h2 class="wt-title"></h2><p class="wt-text"></p>' +
    '<div class="wt-actions"><button type="button" class="quiet wt-skip">Skip walkthrough</button><button type="button" class="primary wt-finish" hidden>Finish</button></div></div>';
  root.querySelector('.wt-skip').addEventListener('click', endWalkthrough);
  root.querySelector('.wt-finish').addEventListener('click', endWalkthrough);
  wtState.root = root;
  document.body.append(root);
  wtState.ticks = 0;
  wtEnter(0);
  wtState.frame = requestAnimationFrame(wtTick);
}
get('replay-tour').addEventListener('click', () => { showPage('shop'); setTimeout(startTour, 50); });

function openFirstRun() {
  try { localStorage.setItem('customize-room-chosen', '1'); } catch {}
  const options = element('div', 'room-options');
  for (const sample of scenes) {
    const control = button('', '', () => {
      try { localStorage.setItem('customize-current-room', sample.label); } catch {}
      modal.close();
      startTour();
    });
    control.append(shopImage(sample.src), element('span', '', sample.label));
    options.append(control);
  }
  const ownPhoto = button('', 'own-photo', () => openRoomRecorder());
  ownPhoto.setAttribute('aria-label', 'Use my own photo');
  ownPhoto.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4.5 3.5 3 2.5-2 5 4"/></svg>';
  ownPhoto.append(element('span', '', 'Use my own photo'));
  options.append(ownPhoto);
  dialog('Which space are you decorating?', element('p', '', 'You can change this any time from the space view.'), options);
}

/* ---------- intro: how Customize works ---------- */
// First launch plays the whole walkthrough, then shows the arrow. Later launches add a Skip button.
const introSeenKey = 'customize-intro-seen';
let introFinished;

function playIntro() {
  const intro = get('intro');
  let seen = false;
  try { seen = localStorage.getItem(introSeenKey) === '1'; } catch {}
  const pointer = intro.querySelector('.intro-pointer');
  const blocked = [document.querySelector('.masthead'), document.querySelector('.shop-shell')];
  const timers = [];
  let done = false;
  const wait = (ms) => new Promise((resolve) => timers.push(setTimeout(resolve, ms)));
  const step = (name) => { intro.dataset.step = name; };
  const center = (node) => {
    const box = node.getBoundingClientRect();
    return [box.left + box.width / 2, box.top + box.height / 2];
  };
  const pointAt = ([x, y]) => {
    pointer.style.setProperty('--px', x + 'px');
    pointer.style.setProperty('--py', y + 'px');
  };
  const tap = async (target) => {
    pointer.classList.remove('tap');
    void pointer.offsetWidth;
    pointer.classList.add('tap');
    target?.classList.add('pressed');
    await wait(240);
    target?.classList.remove('pressed');
    await wait(220);
  };
  // Where the sideboard top sits in assets/room.webp (shown with background-size: cover).
  const roomSpot = () => {
    const scale = Math.max(innerWidth / 1536, innerHeight / 1024);
    const left = (innerWidth - 1536 * scale) / 2;
    const top = (innerHeight - 1024 * scale) / 2;
    intro.style.setProperty('--sx', left + 0.42 * 1536 * scale + 'px');
    intro.style.setProperty('--sy', top + 0.54 * 1024 * scale + 'px');
    intro.style.setProperty('--ph', 0.19 * 1024 * scale + 'px');
    return [left + 0.42 * 1536 * scale, top + 0.5 * 1024 * scale];
  };
  const showEnd = () => {
    pointer.classList.remove('on');
    roomSpot();
    intro.querySelector('.intro-placed').classList.add('on');
    step('done');
    get('intro-go').focus({ preventScroll: true });
  };

  return new Promise((resolve) => {
    const finish = () => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      try { localStorage.setItem(introSeenKey, '1'); } catch {}
      for (const node of blocked) node.inert = false;
      intro.classList.add('leaving');
      setTimeout(() => { intro.hidden = true; intro.classList.remove('leaving'); }, reduceMotion.matches ? 0 : 420);
      resolve();
    };
    get('intro-go').addEventListener('click', finish);
    get('intro-skip').addEventListener('click', finish);
    get('intro-skip').hidden = !seen;
    for (const node of blocked) node.inert = true;
    intro.hidden = false;
    if (reduceMotion.matches) return showEnd();

    (async () => {
      step('start');
      await wait(300);
      step('home');
      await wait(1100);
      const app = intro.querySelector('.intro-app');
      pointer.classList.add('on');
      pointAt(center(app.querySelector('.intro-app-icon')));
      await wait(950);
      await tap(app);
      step('open');
      await wait(1000);
      const shutter = intro.querySelector('.intro-shutter');
      pointAt(center(shutter));
      await wait(900);
      await tap(shutter);
      const flash = intro.querySelector('.intro-flash');
      flash.classList.add('on');
      step('shot');
      await wait(750);
      flash.classList.remove('on');
      pointer.classList.remove('on');
      step('zoom');
      await wait(1500);
      step('place');
      await wait(750);
      const thumb = intro.querySelector('[data-product="orchid"]');
      pointer.classList.add('on');
      pointAt(center(thumb));
      await wait(900);
      await tap(thumb);
      thumb.classList.add('selected');
      await wait(300);
      pointAt(roomSpot());
      await wait(950);
      await tap();
      intro.querySelector('.intro-spot').classList.add('on');
      intro.querySelector('.intro-placed').classList.add('on');
      thumb.classList.remove('selected');
      await wait(1300);
      if (!done) showEnd();
    })();
  });
}

async function start() {
  introFinished ||= playIntro();
  const loading = get('catalog-loading');
  const message = get('loading-message');
  const retry = get('retry-catalog');
  loading.hidden = false;
  loading.dataset.state = 'loading';
  message.textContent = 'Loading the catalog…';
  retry.hidden = true;
  workspace.setAttribute('aria-busy', 'true');
  get('rooms-page').inert = true;
  document.querySelector('.shop-nav').inert = true;
  // The mark only needs to show long enough not to flash.
  const animationTime = reduceMotion.matches ? 0 : 400;
  const animationFinished = new Promise((resolve) => setTimeout(resolve, animationTime));
  try {
    [profile] = await Promise.all([request('catalog'), animationFinished]);
    showPage('shop');
    if (!localStorage.getItem('customize-room-chosen')) introFinished.then(openFirstRun);
    loading.hidden = true;
    get('rooms-page').inert = false;
    document.querySelector('.shop-nav').inert = false;
  } catch {
    loading.dataset.state = 'error';
    message.textContent = 'The catalog could not load.';
    retry.hidden = false;
  } finally {
    workspace.removeAttribute('aria-busy');
  }
}
get('retry-catalog').addEventListener('click', start);
start();
