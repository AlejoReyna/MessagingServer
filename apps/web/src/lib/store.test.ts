import { describe, expect, it } from 'vitest';
import type { Message } from '@private-chat/contracts';
import {
  applyCleared,
  applyDeleted,
  canRetry,
  dedupeCreated,
  dropPendingFor,
  isVersionStale,
  maxSequence,
  mergeMessages,
  reconcileBuffer,
} from './store';

function msg(over: Partial<Message> & { sequence: number }): Message {
  return {
    id: over.id ?? `id-${over.sequence}`,
    clientMessageId: over.clientMessageId ?? `client-${over.sequence}`,
    senderId: over.senderId ?? '11111111-1111-4111-8111-111111111111',
    sequence: over.sequence,
    body: over.body ?? `hola ${over.sequence}`,
    createdAt: over.createdAt ?? '2026-01-01T00:00:00.000Z',
  };
}

describe('mergeMessages', () => {
  it('deduplica por id y ordena por sequence', () => {
    const a = [msg({ sequence: 3, id: 'c' }), msg({ sequence: 1, id: 'a' })];
    const b = [msg({ sequence: 2, id: 'b' }), msg({ sequence: 1, id: 'a' })];
    const merged = mergeMessages(a, b);
    expect(merged.map((m) => m.sequence)).toEqual([1, 2, 3]);
    expect(merged.filter((m) => m.id === 'a')).toHaveLength(1);
  });
});

describe('dedupeCreated (idempotencia HTTP/socket)', () => {
  it('no duplica cuando el socket repite un mensaje ya cargado por HTTP', () => {
    const base = [msg({ sequence: 1, id: 'm1', clientMessageId: 'c1' })];
    const next = dedupeCreated(base, { message: msg({ sequence: 1, id: 'm1', clientMessageId: 'c1' }) });
    expect(next).toHaveLength(1);
  });

  it('no duplica por clientMessageId aunque el eco traiga el mensaje confirmado', () => {
    const base = [msg({ sequence: 5, id: 'm5', clientMessageId: 'c5' })];
    const next = dedupeCreated(base, { message: msg({ sequence: 5, id: 'm5', clientMessageId: 'c5' }) });
    expect(next).toHaveLength(1);
    expect(next[0]?.id).toBe('m5');
  });

  it('agrega mensajes nuevos manteniendo el orden', () => {
    const base = [msg({ sequence: 1, id: 'a' })];
    const next = dedupeCreated(base, { message: msg({ sequence: 2, id: 'b' }) });
    expect(next.map((m) => m.id)).toEqual(['a', 'b']);
  });
});

describe('reconcileBuffer (suscribir antes de reconciliar)', () => {
  it('conserva eventos con sequence mayor aunque lleguen durante la carga HTTP', () => {
    const http = [msg({ sequence: 1, id: 'a' }), msg({ sequence: 2, id: 'b' })];
    const buffered = [{ message: msg({ sequence: 3, id: 'c' }) }];
    const out = reconcileBuffer(http, buffered, 2);
    expect(out.map((m) => m.sequence)).toEqual([1, 2, 3]);
  });

  it('descarta bufferizados ya incluidos en HTTP (sin duplicados)', () => {
    const http = [msg({ sequence: 1, id: 'a' }), msg({ sequence: 2, id: 'b' })];
    const buffered = [{ message: msg({ sequence: 2, id: 'b' }) }];
    const out = reconcileBuffer(http, buffered, 2);
    expect(out).toHaveLength(2);
  });
});

describe('versiones y vaciado', () => {
  it('detecta versión obsoleta para invalidar y recargar', () => {
    expect(isVersionStale(3, 4)).toBe(true);
    expect(isVersionStale(4, 4)).toBe(false);
    expect(isVersionStale(5, 4)).toBe(false);
  });

  it('applyDeleted quita el mensaje y sube la versión', () => {
    const base = [msg({ sequence: 1, id: 'a' }), msg({ sequence: 2, id: 'b' })];
    const r = applyDeleted(base, { messageId: 'a', conversationVersion: 4 }, 3);
    expect(r.messages.map((m) => m.id)).toEqual(['b']);
    expect(r.version).toBe(4);
  });

  it('applyCleared limpia historial y DESCARTA pendientes (no reenvía, no resucita)', () => {
    const base = [msg({ sequence: 1, id: 'a' })];
    const pending = [
      { clientMessageId: 'p1', body: 'pendiente viejo', conversationVersion: 3, status: 'pending' as const },
    ];
    const r = applyCleared(base, pending, { conversationVersion: 4 }, 3);
    expect(r.messages).toEqual([]);
    expect(r.pending).toEqual([]);
    expect(r.version).toBe(4);
  });

  it('un pendiente de versión anterior no se puede reintentar', () => {
    expect(canRetry({ clientMessageId: 'p', body: 'x', conversationVersion: 3, status: 'failed' }, 4)).toBe(false);
    expect(canRetry({ clientMessageId: 'p', body: 'x', conversationVersion: 4, status: 'failed' }, 4)).toBe(true);
  });

  it('dropPendingFor quita el pendiente confirmado (reintento idempotente)', () => {
    const pending = [
      { clientMessageId: 'p1', body: 'a', conversationVersion: 1, status: 'pending' as const },
      { clientMessageId: 'p2', body: 'b', conversationVersion: 1, status: 'pending' as const },
    ];
    expect(dropPendingFor(pending, 'p1').map((p) => p.clientMessageId)).toEqual(['p2']);
  });

  it('maxSequence de historial vacío es 0 (after=0 recupera todo)', () => {
    expect(maxSequence([])).toBe(0);
    expect(maxSequence([msg({ sequence: 7, id: 'z' })])).toBe(7);
  });
});
