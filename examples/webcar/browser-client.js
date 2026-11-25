/**
 * Browser-side WebCar client. Embed in your own HTML5 game's car computer,
 * never in a third-party page. No global state or game-engine assumptions.
 *
 * The game retains final authority: onAction must validate station IDs and
 * decide whether each action is allowed. Sei cannot drive the car.
 */
export function createWebCarClient({
  baseUrl = 'http://127.0.0.1:61731',
  token,
  observe,
  onAction,
  onSay = () => {},
  onStatus = () => {},
  fetchImpl = fetch,
  stateIntervalMs = 750,
  commandIntervalMs = 200,
}) {
  if (!token || typeof observe !== 'function' || typeof onAction !== 'function') {
    throw new Error('token, observe and onAction are required');
  }
  const headers = { 'content-type': 'application/json', 'x-sei-webcar-token': token };
  let running = false, states = null, commands = null, stateBusy = false, commandBusy = false;

  async function api(method, path, body) {
    const res = await fetchImpl(baseUrl + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store' });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.detail || payload.error || 'bridge error ' + res.status);
    return payload;
  }
  async function sendState() {
    if (!running || stateBusy) return;
    stateBusy = true;
    try { await api('POST', '/game/state', await observe()); onStatus('connected'); }
    catch (err) { onStatus('error', String(err?.message ?? err)); }
    finally { stateBusy = false; }
  }
  async function runCommands() {
    if (!running || commandBusy) return;
    commandBusy = true;
    try {
      const { commands: list } = await api('GET', '/game/commands');
      for (const cmd of list) {
        let outcome;
        try {
          if (cmd.name === 'speak') {
            // This notification is sent separately by the Sei adapter below,
            // not through the model's tool/action registry.
            await onSay(cmd.args?.text ?? '');
            outcome = { ok: true, detail: 'spoken' };
          } else {
            outcome = await onAction(cmd.name, cmd.args);
            if (!outcome || typeof outcome.ok !== 'boolean') {
              outcome = { ok: false, detail: 'onAction must return {ok, detail}' };
            }
          }
        } catch (err) {
          outcome = { ok: false, detail: String(err?.message ?? err).slice(0, 200) };
        }
        await api('POST', '/game/result', { id: cmd.id, ...outcome }).catch(err => onStatus('error', String(err)));
      }
    } catch (err) { onStatus('error', String(err?.message ?? err)); }
    finally { commandBusy = false; }
  }

  return {
    start() {
      if (running) return;
      running = true;
      void sendState();
      void runCommands();
      states = setInterval(() => { void sendState(); }, stateIntervalMs);
      commands = setInterval(() => { void runCommands(); }, commandIntervalMs);
    },
    stop() {
      running = false;
      clearInterval(states);
      clearInterval(commands);
    },
    sendChat(text) {
      return api('POST', '/game/chat', { text: String(text).slice(0, 500) });
    },
    sendState, // Explicit refresh after a meaningful event.
  };
}
