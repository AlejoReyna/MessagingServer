import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { ChatPanel } from '../components/ChatPanel';
import type { Message, PublicUser } from '@private-chat/contracts';

afterEach(() => cleanup());

function user(over: Partial<PublicUser> = {}): PublicUser {
  return {
    id: over.id ?? '11111111-1111-4111-8111-111111111111',
    username: over.username ?? 'admin',
    displayName: over.displayName ?? 'Admin',
    role: over.role ?? 'admin',
    avatarUrl: null,
    avatarVersion: 0,
    mustChangePassword: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function baseProps(over: Partial<React.ComponentProps<typeof ChatPanel>> = {}) {
  const me = user();
  const partner = user({ id: '22222222-2222-4222-8222-222222222222', username: 'member', displayName: 'Pareja', role: 'member' });
  const message: Message = {
    id: '33333333-3333-4333-8333-333333333333',
    clientMessageId: '44444444-4444-4333-8333-444444444444',
    senderId: partner.id,
    sequence: 1,
    body: 'Hola',
    createdAt: '2026-01-01T12:00:00.000Z',
  };
  return {
    me,
    partner,
    messages: [message],
    pending: [],
    loading: false,
    loadingMore: false,
    hasMore: false,
    loadError: null,
    connected: true,
    partnerTyping: false,
    partnerOnline: true,
    readByPartner: 0,
    notice: null,
    showSidebarToggle: false,
    onOpenSettings: vi.fn(),
    onLoadMore: vi.fn(),
    onReload: vi.fn(),
    onSend: vi.fn(),
    onRetry: vi.fn(),
    onDiscardPending: vi.fn(),
    onTyping: vi.fn(),
    onDeleteMessage: vi.fn(),
    onClear: vi.fn(),
    isAdmin: true,
    clearArmed: false,
    ...over,
  } satisfies React.ComponentProps<typeof ChatPanel>;
}

describe('indicador de escritura tradicional', () => {
  it('muestra la burbuja clásica de tres puntos cuando la pareja escribe', () => {
    render(<ChatPanel {...baseProps({ partnerTyping: true })} />);
    // Cabecera con estado de escritura (más el texto sólo-lector de la burbuja).
    expect(screen.getAllByText('escribiendo…').length).toBeGreaterThanOrEqual(1);
    // Burbuja tradicional: región de estado con etiqueta accesible y tres puntos.
    const bubble = screen.getByRole('status', { name: /está escribiendo/i });
    expect(bubble).toBeInTheDocument();
    const dots = within(bubble).getAllByText('escribiendo…', { selector: 'span.sr-only' });
    expect(dots).toHaveLength(1);
    const indicators = bubble.querySelectorAll('.typing-dot');
    expect(indicators).toHaveLength(3);
  });

  it('oculta la burbuja cuando nadie escribe', () => {
    render(<ChatPanel {...baseProps({ partnerTyping: false })} />);
    expect(screen.queryByRole('status', { name: /está escribiendo/i })).not.toBeInTheDocument();
    expect(screen.getByText('En línea')).toBeInTheDocument();
  });
});
