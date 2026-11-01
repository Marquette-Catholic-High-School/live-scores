// Account menu for signed-in pages (scorekeeper console, admin): navigation,
// change password (POST /api/auth/password) and sign out.

import { api } from './api.js';
import { el, initials, openDialog, setBusy, toast } from './ui.js';

const MIN_PASSWORD_LENGTH = 8;

function passwordField(label, { name, autocomplete, autofocus = false, hint } = {}) {
  const input = el('input', {
    class: 'input',
    type: 'password',
    name,
    autocomplete,
    required: true,
    autofocus,
    minLength: autocomplete === 'new-password' ? MIN_PASSWORD_LENGTH : null,
    maxLength: 1024,
  });
  const field = el('label', { class: 'field' }, el('span', { class: 'field__label', text: label }), input, hint ? el('span', { class: 'field__hint', text: hint }) : null);
  return { field, input };
}

export function changePasswordDialog() {
  return openDialog({
    title: 'Change password',
    closeOnBackdrop: false,
    build(body, actions, close) {
      const current = passwordField('Current password', { name: 'current', autocomplete: 'current-password', autofocus: true });
      const next = passwordField('New password', { name: 'new', autocomplete: 'new-password', hint: `At least ${MIN_PASSWORD_LENGTH} characters.` });
      const repeat = passwordField('Repeat new password', { name: 'repeat', autocomplete: 'new-password' });
      const error = el('p', { class: 'form-error', role: 'alert', hidden: true });
      const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--lg', text: 'Change password' });
      const form = el('form', { class: 'stack', novalidate: true }, current.field, next.field, repeat.field, error);
      form.id = 'change-password-form';
      submit.setAttribute('form', form.id);

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        error.hidden = true;
        repeat.input.setCustomValidity(repeat.input.value === next.input.value ? '' : 'The passwords don’t match.');
        if (!form.reportValidity()) return;
        setBusy(submit, true);
        try {
          await api('/api/auth/password', { method: 'POST', body: { currentPassword: current.input.value, newPassword: next.input.value } });
          close(true);
          toast('Password changed. Your other devices were signed out.', { tone: 'success' });
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          if (err.status === 403) current.input.select();
        } finally {
          setBusy(submit, false);
        }
      });
      repeat.input.addEventListener('input', () => repeat.input.setCustomValidity(''));

      body.append(form);
      actions.append(el('button', { type: 'button', class: 'btn btn--lg', text: 'Cancel', on: { click: () => close(false) } }), submit);
    },
  });
}

// `beforeSignOut()` may return false to keep the user signed in (e.g. when
// scoring actions are still waiting to be sent).
export function mountAccountMenu(slot, user, { current, beforeSignOut } = {}) {
  const details = el('details', { class: 'menu' });
  const summary = el(
    'summary',
    { class: 'menu__button', 'aria-label': `Account menu for ${user.displayName}` },
    el('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(user.displayName) }),
    el('span', { class: 'menu__name', text: user.displayName }),
  );

  const link = (href, label, page) =>
    el('a', { class: 'menu__item', href, text: label, 'aria-current': page === current ? 'page' : null });

  const signOut = async () => {
    details.open = false;
    if (beforeSignOut && (await beforeSignOut()) === false) return;
    try {
      await api('/api/auth/logout', { method: 'POST' });
      location.assign('/login');
    } catch (err) {
      toast(`Couldn’t sign out: ${err.message}`, { tone: 'error' });
    }
  };

  const panel = el(
    'div',
    { class: 'menu__panel' },
    el(
      'div',
      { class: 'menu__meta' },
      el('strong', { text: user.displayName }),
      el('span', { text: `${user.username} · ${user.role === 'admin' ? 'Admin' : 'Scorekeeper'}` }),
    ),
    link('/', 'Public scoreboard', 'board'),
    link('/keeper', 'Scorekeeper console', 'keeper'),
    user.role === 'admin' ? link('/admin', 'Admin', 'admin') : null,
    el('hr', { class: 'menu__sep' }),
    el('button', {
      type: 'button',
      class: 'menu__item',
      text: 'Change password',
      on: {
        click: () => {
          details.open = false;
          changePasswordDialog();
        },
      },
    }),
    el('button', { type: 'button', class: 'menu__item menu__item--danger', text: 'Sign out', on: { click: signOut } }),
  );

  details.append(summary, panel);
  document.addEventListener('click', (event) => {
    if (details.open && !details.contains(event.target)) details.open = false;
  });
  details.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && details.open) {
      details.open = false;
      summary.focus();
    }
  });
  slot.replaceChildren(details);
}
