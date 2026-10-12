import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    body: 'Hola, ¿cómo estás?',
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

describe('permisos de borrado en el cliente (el servidor es la autoridad)', () => {
  it('el admin ve controles de borrado por mensaje y vaciado', () => {
    render(<ChatPanel {...baseProps({ isAdmin: true })} />);
    // WhatsApp Web/móvil: las acciones viven en el menú de la burbuja.
    fireEvent.click(screen.getByRole('button', { name: /opciones del mensaje/i }));
    expect(screen.getByRole('button', { name: /borrar mensaje/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /vaciar conversación/i })).toBeInTheDocument();
  });

  it('el member no puede borrar mensajes ajenos ni vaciar el chat', () => {
    render(<ChatPanel {...baseProps({ isAdmin: false, me: user({ role: 'member' }) })} />);
    fireEvent.click(screen.getByRole('button', { name: /opciones del mensaje/i }));
    expect(screen.queryByRole('button', { name: /borrar mensaje/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /vaciar conversación/i })).not.toBeInTheDocument();
    // El historial sigue visible para el miembro.
    expect(screen.getByText('Hola, ¿cómo estás?')).toBeInTheDocument();
  });

  it('el member puede seleccionar sólo su mensaje para borrarlo individualmente', () => {
    const props = baseProps({ isAdmin: false, me: user({ role: 'member' }) });
    const ownMessage: Message = {
      ...props.messages[0]!,
      id: '55555555-5555-4555-8555-555555555555',
      clientMessageId: '66666666-6666-4666-8666-666666666666',
      senderId: props.me.id,
      sequence: 2,
      body: 'Mi mensaje',
    };
    render(<ChatPanel {...props} messages={[...props.messages, ownMessage]} />);
    const triggers = screen.getAllByRole('button', { name: /opciones del mensaje/i });
    expect(triggers).toHaveLength(2);
    // El mensaje ajeno no ofrece borrado en su menú.
    fireEvent.click(triggers[0]!);
    expect(screen.queryByRole('button', { name: /borrar mensaje/i })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    // El propio sí: menú con “Borrar para ambos” y confirmación posterior.
    fireEvent.click(triggers[1]!);
    const buttons = screen.getAllByRole('button', { name: /borrar mensaje/i });
    expect(buttons).toHaveLength(1);
    const button = screen.getByRole('button', { name: /borrar mensaje/i });
    expect(button).toHaveAttribute('title', 'Borrar para ambos');
    fireEvent.click(button);
    expect(props.onDeleteMessage).toHaveBeenCalledExactlyOnceWith(ownMessage.id);
    expect(screen.queryByRole('button', { name: /vaciar conversación/i })).not.toBeInTheDocument();
    expect(screen.getByText('Hola, ¿cómo estás?')).toBeInTheDocument();
  });
});

describe('MVP sin botones muertos', () => {
  it('la foto del contacto abre una vista sin acciones de modificación y restaura el foco al cerrar', () => {
    const props = baseProps();
    const contact = props.partner!;
    const partner = { ...contact, avatarUrl: `/api/users/${contact.id}/avatar?v=2`, avatarVersion: 2 };
    const view = render(<ChatPanel {...props} partner={partner} />);
    const open = screen.getByRole('button', { name: 'Ver foto de perfil de Pareja' });
    open.focus();
    fireEvent.click(open);
    expect(screen.getByRole('dialog', { name: 'Foto de perfil de Pareja' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Foto de perfil de Pareja' })).toHaveAttribute('src', partner.avatarUrl);
    expect(screen.queryByRole('button', { name: /cambiar imagen|guardar imagen|quitar|eliminar foto/i })).not.toBeInTheDocument();
    expect(view.container.querySelector('input[type="file"]')).toBeNull();
    const close = screen.getByRole('button', { name: 'Cerrar vista previa' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(open).toHaveFocus();
  });

  it('sin contacto aún no ofrece abrir su foto', () => {
    render(<ChatPanel {...baseProps({ partner: null })} />);
    expect(screen.queryByRole('button', { name: /ver foto de perfil/i })).not.toBeInTheDocument();
  });

  it('no muestra llamadas, audio, grupos, registro ni adjuntos', () => {
    render(<ChatPanel {...baseProps()} />);
    expect(screen.queryByRole('button', { name: /llamar|videollamada|audio|grupo|adjuntar/i })).not.toBeInTheDocument();
  });

  it('muestra estado enviado tras persistencia (sin inventar entregado)', () => {
    render(<ChatPanel {...baseProps({
      messages: [{
        id: '33333333-3333-4333-8333-333333333333',
        clientMessageId: '44444444-4444-4333-8333-444444444444',
        senderId: '11111111-1111-4111-8111-111111111111',
        sequence: 2,
        body: 'Yo escribí esto',
        createdAt: '2026-01-01T12:01:00.000Z',
      }],
    })} />);
    // Propio persistido sin lectura del otro: "Enviado", no "Leído" ni "Entregado".
    expect(screen.getByText('Enviado')).toBeInTheDocument();
    expect(screen.queryByText('Entregado')).not.toBeInTheDocument();
  });
});
