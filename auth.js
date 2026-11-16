'use strict';
// Log in / create account. Talks to the Rust server's /api/auth endpoints; the session is an httpOnly cookie.
(function () {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const message = $('auth-message');
  const next = params.get('next') === 'admin' ? 'admin.html' : './';

  function show(mode) {
    const signup = mode === 'signup';
    $('tab-login').setAttribute('aria-selected', String(!signup));
    $('tab-signup').setAttribute('aria-selected', String(signup));
    $('login-form').hidden = signup;
    $('signup-form').hidden = !signup;
    $('auth-title').textContent = signup ? 'Create your account' : 'Welcome back';
    document.title = (signup ? 'Create account' : 'Log in') + ' · Customize';
    message.hidden = true;
    history.replaceState(null, '', signup ? '?mode=signup' + (params.get('next') ? '&next=' + params.get('next') : '') : location.pathname + (params.get('next') ? '?next=' + params.get('next') : ''));
  }
  $('tab-login').addEventListener('click', () => show('login'));
  $('tab-signup').addEventListener('click', () => show('signup'));
  show(params.get('mode') === 'signup' ? 'signup' : 'login');

  function fail(text) {
    message.textContent = text;
    message.className = 'message';
    message.hidden = false;
  }

  async function submit(form, path) {
    message.hidden = true;
    const data = Object.fromEntries(new FormData(form));
    for (const input of form.querySelectorAll('input')) {
      if (!input.value.trim()) { input.focus(); return fail('Fill in every field.'); }
    }
    if (path === 'signup' && data.password.length < 8) return fail('Use a password of at least 8 characters.');
    const shopper = localStorage.getItem('customize-shopper');
    if (shopper) data.shopper = shopper;
    const send = form.querySelector('button[type="submit"]');
    send.disabled = true;
    try {
      const response = await fetch('api/auth/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return fail(body.error || 'Something went wrong. Try again.');
      try {
        localStorage.setItem('customize-account-name', body.user.name);
        // While signed in, the shop uses the server so saves and orders follow the account.
        localStorage.setItem('customize-session', '1');
      } catch {}
      location.href = next;
    } catch {
      fail('Could not reach the Customize server. Accounts need the server running (./dev.sh -w).');
    } finally {
      send.disabled = false;
    }
  }
  $('login-form').addEventListener('submit', (event) => { event.preventDefault(); submit(event.target, 'login'); });
  $('signup-form').addEventListener('submit', (event) => { event.preventDefault(); submit(event.target, 'signup'); });
})();
