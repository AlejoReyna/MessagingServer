import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Composer } from './Composer';
import { MessagePhoto } from './MessagePhoto';
import { sendPhoto } from '../lib/api';

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:local-photo'), revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('envío de fotos', () => {
  it('elegir foto sólo previsualiza; Enviar adjunta foto y texto opcional; limpiar libera URL', async () => {
    const onSendPhoto = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSend={vi.fn()} onSendPhoto={onSendPhoto} onTyping={vi.fn()} />);
    const file = new File(['photo'], 'foto.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Elegir foto'), { target: { files: [file] } });
    expect(onSendPhoto).not.toHaveBeenCalled();
    const preview = screen.getByAltText('Foto lista para enviar');
    expect(preview).toHaveAttribute('src', 'blob:local-photo');
    expect(screen.getByRole('button', { name: 'Enviar mensaje' })).toBeDisabled();
    fireEvent.load(preview);
    fireEvent.change(screen.getByLabelText('Escribe un mensaje'), { target: { value: 'Una foto' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar mensaje' }));
    await waitFor(() => expect(onSendPhoto).toHaveBeenCalledExactlyOnceWith(file, 'Una foto', null));
    await waitFor(() => expect(screen.queryByAltText('Foto lista para enviar')).toBeNull());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-photo');
  });
  it('permite foto sin texto, quitar sin enviar y rechaza archivo inválido', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSend={vi.fn()} onSendPhoto={send} onTyping={vi.fn()} />);
    const file = new File(['photo'], 'foto.webp', { type: 'image/webp' });
    fireEvent.change(screen.getByLabelText('Elegir foto'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Quitar foto' }));
    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByAltText('Foto lista para enviar')).toBeNull();
    fireEvent.change(screen.getByLabelText('Elegir foto'), { target: { files: [file] } });
    fireEvent.load(screen.getByAltText('Foto lista para enviar'));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar mensaje' }));
    await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith(file, '', null));
    fireEvent.change(screen.getByLabelText('Elegir foto'), { target: { files: [new File(['svg'], 'x.svg', { type: 'image/svg+xml' })] } });
    expect(screen.getByRole('alert')).toHaveTextContent('JPEG, PNG o WebP');
    expect(screen.queryByAltText('Foto lista para enviar')).toBeNull();
  });
  it('abre la foto del mensaje en grande y cierra con Escape', () => {
    render(<MessagePhoto src="/api/messages/11111111-1111-4111-8111-111111111111/photo" />);
    fireEvent.click(screen.getByRole('button', { name: 'Ver foto' }));
    expect(screen.getByRole('dialog', { name: 'Foto' })).toBeInTheDocument();
    expect(screen.getByAltText('Foto ampliada')).toHaveAttribute('src', '/api/messages/11111111-1111-4111-8111-111111111111/photo');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cerrar vista previa' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('multipart mantiene clave/version/caption y envía cookies + CSRF sin Content-Type manual', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const message = { id, clientMessageId: id, senderId: id, sequence: 1, body: 'Foto', createdAt: '2026-10-11T12:00:00.000Z', photoUrl: `/api/messages/${id}/photo` };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['photo'], 'x.png', { type: 'image/png' });
    await sendPhoto(file, { clientMessageId: id, body: 'Foto', conversationVersion: 7 }, 'csrf-token');
    const [url, options] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/messages/photo');
    expect(options.credentials).toBe('include');
    expect(options.headers).toEqual({ Accept: 'application/json', 'X-CSRF-Token': 'csrf-token' });
    const body = options.body as FormData;
    expect(body.get('clientMessageId')).toBe(id);
    expect(body.get('conversationVersion')).toBe('7');
    expect(body.get('body')).toBe('Foto');
    expect(body.get('photo')).toBeInstanceOf(File);
  });
});
