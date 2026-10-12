/** Límites de intentos en memoria (una instancia).
 *
 * Protegen login por cuenta e IP, y el envío de mensajes por usuario.
 * En un despliegue con varias réplicas habría que moverlos a un almacén
 * compartido (p. ej. PostgreSQL o Redis); documentado en el handoff.
 */
export interface RateLimitOptions {
  maxAttempts: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class MemoryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;

  constructor(options: RateLimitOptions) {
    this.maxAttempts = options.maxAttempts;
    this.windowMs = options.windowMs;
  }

  /** Devuelve true si el intento se permite (y lo cuenta). */
  take(key: string, nowMs: number = Date.now()): boolean {
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= nowMs) {
      this.buckets.set(key, { count: 1, resetAt: nowMs + this.windowMs });
      return true;
    }
    if (existing.count >= this.maxAttempts) return false;
    existing.count += 1;
    return true;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Limpieza periódica de cubos expirados. */
  sweep(nowMs: number = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= nowMs) this.buckets.delete(key);
    }
  }
}
