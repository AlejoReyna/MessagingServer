import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import React from 'react';
import { startTestServer, TestClient } from '../../apps/api/test/integration/helpers.ts';
import { hashPassword } from '../../apps/api/src/auth/password.ts';

test('puerta PIN real: respuesta rechazada, corrección, alta, logout y segundo acceso contra PostgreSQL', { timeout: 30000 }, async () => {
  assert.ok(process.env.INTEGRATION_DATABASE_URL, 'Se requiere una base exclusiva de integración');
  const server = await startTestServer();
  const originalFetch = globalThis.fetch;
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: server.config.appOrigin });
  const previousGlobals = new Map();
  let cleanup;
  try {
    server.config.guestSetupSecret = `respuesta-QA-${randomUUID()}`;
    await server.db.user.update({ where: { id: server.users.adminId }, data: { pinHash: await hashPassword('1234'), mustChangePassword: false } });
    // El loader TSX de las pruebas Node usa JSX clásico; Vite usa react-jsx.
    for (const [key, value] of Object.entries({ React, window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
      previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    // Adaptación de origen y cookie jar del navegador; HTTP, CSRF, hashes y DB
    // son reales. No se mockean respuestas ni el contexto de sesión.
    const jar = new Map();
    let setupRequests = 0;
    globalThis.fetch = async (input, init = {}) => {
      if (typeof input !== 'string' || !input.startsWith('/api/')) return originalFetch(input, init);
      const headers = new Headers(init.headers);
      headers.set('Origin', server.config.appOrigin);
      headers.set('Cookie', [...jar].map(([key, value]) => `${key}=${value}`).join('; '));
      if (input === '/api/auth/pin-setup') setupRequests++;
      const response = await originalFetch(`${server.baseUrl}${input}`, { ...init, headers });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';')[0];
        const index = pair.indexOf('=');
        const name = pair.slice(0, index);
        const value = pair.slice(index + 1);
        if (value) jar.set(name, value);
        else jar.delete(name);
      }
      return response;
    };
    const { render, screen, fireEvent, waitFor, cleanup: clean } = await import('@testing-library/react');
    cleanup = clean;
    const { SessionProvider, useSession } = await import('../../apps/web/src/state/session.tsx');
    const { GateScreen } = await import('../../apps/web/src/components/GateScreen.tsx');
    function Access() {
      const session = useSession();
      if (session.status === 'ready') return React.createElement('div', null,
        React.createElement('p', { role: 'status' }, `Cuenta: ${session.user.username}`),
        React.createElement('button', { onClick: () => void session.logout() }, 'Cerrar sesión QA'));
      return session.status === 'anonymous' ? React.createElement(GateScreen) : null;
    }
    render(React.createElement(SessionProvider, null, React.createElement(Access)));
    function enterPin() {
      for (const digit of '5678') fireEvent.click(screen.getByRole('button', { name: `Dígito ${digit}` }));
    }
    async function createAndConfirm() {
      enterPin();
      await screen.findByText('Confirma tu código');
      enterPin();
    }
    fireEvent.change(await screen.findByLabelText(/código de invitación/i), { target: { value: 'respuesta equivocada QA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await createAndConfirm();
    const answer = await screen.findByLabelText(/código de invitación/i);
    assert.match(screen.getByRole('alert').textContent, /código de invitación.*no es correcto/i);
    assert.equal((await server.db.user.findUnique({ where: { id: server.users.memberId } })).pinHash, null);
    assert.equal(await server.db.session.count(), 0);
    assert.equal(setupRequests, 1);
    fireEvent.change(answer, { target: { value: server.config.guestSetupSecret } });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    assert.equal(screen.queryByRole('alert'), null);
    await createAndConfirm();
    await waitFor(() => assert.equal(screen.getByRole('status').textContent, 'Cuenta: member'));
    assert.equal(setupRequests, 2);
    const memberSessionCookie = jar.get('pc_session');
    assert.ok(memberSessionCookie);
    assert.equal((await (await globalThis.fetch('/api/conversation')).json()).partner.username, 'admin');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión QA' }));
    await screen.findByText('Ingresa tu código');
    assert.equal(screen.queryByLabelText(/código de invitación/i), null);
    assert.equal(await server.db.session.count({ where: { userId: server.users.memberId, revokedAt: { not: null } } }), 1);
    enterPin();
    await waitFor(() => assert.equal(screen.getByRole('status').textContent, 'Cuenta: member'));
    assert.notEqual(jar.get('pc_session'), memberSessionCookie);
    assert.equal(setupRequests, 2);
    const admin = new TestClient(server.baseUrl);
    await admin.session();
    const login = await admin.request('POST', '/api/auth/pin-login', { body: { pin: '1234' } });
    assert.equal(login.status, 200);
    admin.csrf = login.json.csrfToken;
    assert.equal((await admin.request('GET', '/api/conversation')).json.partner.username, 'member');
    assert.equal((await admin.request('GET', '/api/auth/session')).json.user.role, 'admin');
    assert.equal((await (await globalThis.fetch('/api/auth/session')).json()).user.role, 'member');
  } finally {
    cleanup?.();
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
    await server.close();
  }
});
