/**
 * WebCar polling client. One instance per active Sei companion.
 * Reads only sanitized state; sends bounded commands to the local bridge.
 */
export function createWebCarClient({
  host = '127.0.0.1',
  port = 61731,
  token,
  fetchImpl = fetch,
  pollIntervalMs = 500,
} = {}) {
  if (!token) throw new Error('missing WebCar token');
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('WebCar is loopback-only');
  const root = 'http://' + host + ':' + port;
  const headers = { 'x-sei-webcar-token': token, 'content-type': 'application/json' };
  let current = null, seq = 0, timer = null, inFlight = false, eventHandler = () => {}, offlineHandler = () => {}, onlineHandler = () => {};

  async function get(path, opts = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
    const signal = opts.signal;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const r = await fetchImpl(root + path, {
        method: opts.body === undefined ? 'GET' : 'POST',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
        cache: 'no-store',
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || data.error || 'HTTP ' + r.status);
      return data;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function observe() {
    const response = await get('/agent/state?since=' + seq);
    if (response.protocol !== 1) throw new Error('incompatible WebCar protocol');
    if (!response.online || !response.state) throw new Error('GAME_WORLD_NOT_OPEN: car computer is offline');
    current = response.state;
    for (const evt of response.events || []) {
      if (Number.isInteger(evt.seq) && evt.seq > seq) {
        seq = evt.seq;
        eventHandler(evt);
      }
    }
    seq = Math.max(seq, Number(response.seq) || 0);
    onlineHandler();
    return current;
  }

  return {
    get state() { return current; },
    observe,
    onEvent(fn) { eventHandler = fn; },
    onOffline(fn) { offlineHandler = fn; },
    onOnline(fn) { onlineHandler = fn; },
    start() {
      if (timer) return;
      timer = setInterval(async () => {
        if (inFlight) return;
        inFlight = true;
        try { await observe(); }
        catch (err) { offlineHandler(err); }
        finally { inFlight = false; }
      }, pollIntervalMs);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; },
    async command(name, args, { signal } = {}) {
      // Bridge checks the whitelist again and the browser's onAction is the
      // authoritative final executor. No vehicle-motion actions exist.
      return get('/agent/command', { body: { name, args }, signal, timeoutMs: 10000 });
    },
  };
}
