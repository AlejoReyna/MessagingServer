import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message, PublicUser } from '@private-chat/contracts';
import { Composer } from './Composer';
import { MessageBubble, PendingBubble } from './MessageBubble';
import { Sidebar } from './Sidebar';
import { snippetOf } from '../lib/reply';

afterEach(() => cleanup());

const me: PublicUser = {
  id: '11111111-1111-4111-8111-111111111111', username: 'admin', displayName: 'Administrador',
  role: 'admin', avatarUrl: null, avatarVersion: 0, mustChangePassword: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const legacyBody = '[sticker:legacy:123]';
const message: Message = {
  id: '22222222-2222-4222-8222-222222222222', clientMessageId: '33333333-3333-4333-8333-333333333333',
  senderId: me.id, sequence: 1, body: legacyBody, createdAt: me.updatedAt,
};

describe('public distribution', () => {
  it('preserves the GitHub icon and points it at the selected repository', () => {
    render(<Sidebar me={me} partner={null} unread={0} busy={false}
      onOpenConversation={vi.fn()} onOpenAvatar={vi.fn()} onLogout={vi.fn()} />);
    const link = screen.getByRole('link', { name: 'Abrir repositorio en GitHub' });
    expect(link).toHaveAttribute('href', 'https://github.com/AlejoReyna/MessagingServer');
    expect(link.querySelector('svg')).not.toBeNull();
  });

  it('shows old catalog markers as plain text and keeps deletion and replies', () => {
    const onDelete = vi.fn();
    render(<MessageBubble message={message} mine read={false} isAdmin={false}
      onDelete={onDelete} onReply={vi.fn()} />);
    expect(screen.getByText(legacyBody)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(snippetOf(legacyBody)).toBe(legacyBody);
    fireEvent.click(screen.getByRole('button', { name: /Opciones del mensaje/ }));
    fireEvent.click(screen.getByRole('button', { name: /Borrar mensaje enviado/ }));
    expect(onDelete).toHaveBeenCalledWith(message.id);
  });

  it('renders old pending markers as plain text with retry controls', () => {
    render(<PendingBubble body={legacyBody} failed onRetry={vi.fn()} onDiscard={vi.fn()} />);
    expect(screen.getByText(legacyBody, { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });

  it('has no catalog selector and still sends ordinary text', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} onTyping={vi.fn()} onSendPhoto={vi.fn()} onSendVideo={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /sticker/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar foto' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar video' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hola' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar mensaje' }));
    expect(onSend).toHaveBeenCalledWith('Hola', null);
  });
});
