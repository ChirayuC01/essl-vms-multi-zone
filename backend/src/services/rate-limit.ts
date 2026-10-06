// A small fixed-window limiter for the public portal (two-zone rebuild,
// Phase 5). In memory: the backend is a single process by design (see
// events/bus.ts), and losing counts on a restart only resets a window.
// ponytail: in-memory windows; move to Postgres if the backend is ever scaled out.

const windows = new Map<string, { start: number; count: number }>();

/** True if this hit is allowed: at most `limit` hits per `windowMs` per key. */
export function allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    windows.set(key, { start: now, count: 1 });
    if (windows.size > 50_000) for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
    return true;
  }
  w.count += 1;
  return w.count <= limit;
}

/** Test hook. */
export function resetLimits(): void {
  windows.clear();
}
