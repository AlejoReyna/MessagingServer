import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PHOTO_MESSAGE_BODY, type Message } from '@private-chat/contracts';
import { Composer } from './Composer';
import { MessageBubble, PendingBubble } from './MessageBubble';
import { snippetOf, snapshotOf } from '../lib/reply';

afterEach(() => cleanup());

const mine = '11111111-1111-4111-8111-111111111111';
const theirs = '22222222-2222-4222-8222-222222222222';
const original: Message = {
  id: '33333333-3333-4333-8333-333333333333',
  clientMessageId: '44444444-4444-4444-8444-444444444444',
  senderId: theirs, sequence: 1, body: '¿Traes pan integral por favor?',
  createdAt: '2026-10-11T12:00:00.000Z',
};
const replyTo = { message: original, author: 'Miembro' };

describe('responder mensajes', () => {
  it('snippetOf resume foto, sticker y texto largo', () => {
    expect(snippetOf(PHOTO_MESSAGE_BODY, `/api/messages/${original.id}/photo`)).toBe('📷 Foto');
    expect(snippetOf(PHOTO_MESSAGE_BODY)).toBe(PHOTO_MESSAGE_BODY);
    expect(snippetOf('Hola')).toBe('Hola');
    expect(snippetOf(`${'a'.repeat(200)}`)).toHaveLength(121);
    expect(snapshotOf(original, 'Miembro')).toEqual({
      author: 'Miembro', messageId: original.id, senderId: theirs, body: original.body,
    });
  });

  it('el compositor previsualiza la cita, la cancela y la envía con el mensaje', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onCancelReply = vi.fn();
    const view = render(<Composer onSend={onSend} onTyping={vi.fn()} replyTo={replyTo} onCancelReply={onCancelReply} />);
    expect(screen.getByLabelText(`Respondiendo a Miembro`)).toBeInTheDocument();
    expect(screen.getByText('¿Traes pan integral por favor?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar respuesta' }));
    expect(onCancelReply).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
    view.rerender(<Composer onSend={onSend} onTyping={vi.fn()} replyTo={replyTo} onCancelReply={onCancelReply} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Sí, claro' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar mensaje' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledExactlyOnceWith('Sí, claro', replyTo));
    expect(onCancelReply).toHaveBeenCalled();
  });

  it('la burbuja muestra la cita, responde y salta al original', () => {
    const onReply = vi.fn();
    const onQuoteClick = vi.fn();
    const withQuote: Message = {
      id: '55555555-5555-4555-8555-555555555555',
      clientMessageId: '66666666-6666-4666-8666-666666666666',
      senderId: mine, sequence: 2, body: 'Sí, integral',
      replyTo: { messageId: original.id, senderId: theirs, body: original.body },
      createdAt: '2026-10-11T12:01:00.000Z',
    };
    render(<MessageBubble message={withQuote} mine read isAdmin={false}
      onDelete={vi.fn()} onReply={onReply} replyAuthorName="Miembro" onQuoteClick={onQuoteClick} />);
    expect(screen.getByText('Miembro')).toBeInTheDocument();
    expect(screen.getByText('¿Traes pan integral por favor?')).toBeInTheDocument();
    // Estilo WhatsApp: Responder vive en el menú de la burbuja.
    fireEvent.click(screen.getByRole('button', { name: /opciones del mensaje/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Responder mensaje/ }));
    expect(onReply).toHaveBeenCalledExactlyOnceWith(withQuote);
    fireEvent.click(screen.getByRole('button', { name: 'Ver mensaje original de Miembro' }));
    expect(onQuoteClick).toHaveBeenCalledExactlyOnceWith(original.id);
  });

  it('sin cita no hay bloque citado; el pendiente conserva su cita', () => {
    const plain: Message = { ...original, senderId: mine };
    const view = render(<MessageBubble message={plain} mine read isAdmin={false}
      onDelete={vi.fn()} onReply={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^Ver mensaje original/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /opciones del mensaje/i }));
    expect(screen.getByRole('button', { name: /^Responder mensaje/ })).toBeInTheDocument();
    view.rerender(<MessageBubble message={plain} mine read isAdmin={false}
      onDelete={vi.fn()} onReply={vi.fn()} />);
    render(<PendingBubble body="Voy en camino" replyTo={snapshotOf(original, 'Miembro')}
      failed={false} onRetry={vi.fn()} onDiscard={vi.fn()} />);
    expect(screen.getByText('Voy en camino')).toBeInTheDocument();
    expect(screen.getAllByText('Miembro').length).toBeGreaterThan(0);
  });
});
