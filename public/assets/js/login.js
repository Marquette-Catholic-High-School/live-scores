// Scorekeeper / admin sign-in (route "/login"): POST /api/auth/login with
// client "web" sets the session cookie, then we go to ?next or /keeper.

import { api, fetchConfig, fetchSession } from './api.js';
import { $, el, fillSchoolName, setBusy } from './ui.js';

const form = $('[data-login-form]');
const username = $('#username');
const password = $('#password');
const submit = $('[data-submit]');
const error = $('[data-error]');
const signedIn = $('[data-signed-in]');

// Only same-origin page paths are allowed as a redirect target. The absolute
// URL is returned: a path alone can normalize to "//host/…" ("/.//host"),
// which the browser would follow to another site.
function safeNext(value) {
  if (!value) return null;
  try {
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin) return null;
    if (url.pathname === '/login' || url.pathname.startsWith('/api/')) return null;
    return url.href;
  } catch {
    return null;
  }
}

const next = safeNext(new URLSearchParams(location.search).get('next'));

function showError(message) {
  error.textContent = message;
  error.hidden = false;
}

function showSignedIn(user) {
  form.hidden = true;
  const actions = el(
    'div',
    { class: 'stack' },
    el('a', { class: 'btn btn--primary btn--lg btn--block', href: next ?? '/keeper', text: next ? 'Continue' : 'Open the scorekeeper console' }),
    user.role === 'admin' ? el('a', { class: 'btn btn--lg btn--block', href: '/admin', text: 'Open admin' }) : null,
    el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--block',
      text: 'Sign in as someone else',
      on: {
        click: async (event) => {
          setBusy(event.currentTarget, true);
          try {
            await api('/api/auth/logout', { method: 'POST' });
          } catch {
            // Signing in again replaces the session cookie anyway.
          }
          signedIn.hidden = true;
          form.hidden = false;
          username.focus();
        },
      },
    }),
  );
  signedIn.replaceChildren(el('p', { class: 'auth__signed-in' }, 'Signed in as ', el('strong', { text: user.displayName }), '.'), actions);
  signedIn.hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;
  if (!form.reportValidity()) return;
  setBusy(submit, true);
  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: { username: username.value.trim(), password: password.value, client: 'web' },
    });
    location.assign(next ?? '/keeper');
  } catch (err) {
    setBusy(submit, false);
    if (err.status === 401) {
      showError('That username and password don’t match. Try again.');
      password.select();
      password.focus();
    } else {
      showError(err.message);
    }
  }
});

fetchConfig()
  .then((config) => {
    fillSchoolName(config.schoolName);
    document.title = `Sign in · ${config.schoolName} Live Scores`;
  })
  .catch(() => {});

fetchSession()
  .then((user) => {
    if (user) showSignedIn(user);
    else username.focus();
  })
  .catch(() => username.focus());
