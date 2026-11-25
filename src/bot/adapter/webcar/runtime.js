/**
 * Runtime for the car-computer game adapter. Game must already be connected
 * to the local WebCar bridge before summon. This has no avatar/spawn protocol:
 * "spawn" means the in-dash computer went online.
 */
import { createWebCarClient } from './client.js';
import { createWebCarAdapter } from './index.js';

export function botUsernameFor(character) {
  return String(character?.username || character?.name || 'Sei').trim().slice(0, 24) || 'Sei';
}
export function adapterConfigFrom({ joinTarget, botUsername }) {
  return {
    host: '127.0.0.1',
    port: joinTarget?.port ?? 61731,
    token: joinTarget?.token ?? '',
    username: botUsername,
  };
}
export function checkJoinTarget(joinTarget) {
  return joinTarget?.port && joinTarget?.token
    ? null
    : { error: 'GAME_WORLD_NOT_OPEN', message: 'WebCar bridge not configured. Set SEI_WEBCAR_TOKEN and launch the browser game.' };
}

export async function createRuntime(config, hooks) {
  const {
    logger = console, createBrain, onBrainReady = () => {}, onBrainLost = () => {},
    onConnected = () => {}, onDisconnected = () => {}, onError = () => {},
    onDashboard = null, createClient = createWebCarClient,
  } = hooks;
  const cfg = config.adapter.webcar;
  const client = createClient({ host: cfg.host, port: cfg.port, token: cfg.token });
  let brain = null, adapter = null, telemetry = null, stopped = false;
  let watching = false, badPolls = 0;

  const handle = {
    get adapter() { return adapter; },
    get telemetry() { return telemetry; },
    async stop() {
      stopped = true;
      client.stop();
      try { adapter?.detach?.(); } catch {}
      try { telemetry?.stop?.(); } catch {}
      if (brain) {
        const old = brain; brain = null;
        try { onBrainLost(); } catch {}
        await old.stop?.();
      }
    },
    setCompanions(names) {
      const list = Array.isArray(names)
        ? names.filter(n => typeof n === 'string' && n.trim() && n !== cfg.username)
        : [];
      config._seiCompanions = list;
      return list;
    },
    setDashboardWatch(next) {
      watching = next === true;
      telemetry?.setWatching?.(watching);
    },
  };

  try {
    await client.observe(); // Must already have a live car computer.
    adapter = createWebCarAdapter({ client, config, botUsername: cfg.username, logger });
    if (typeof onDashboard === 'function') {
      telemetry = adapter.createTelemetry({ emit: onDashboard, logger });
      telemetry.setWatching(watching);
    }
    brain = await createBrain(adapter);
    if (stopped) { await brain?.stop?.(); return handle; }
    onBrainReady(brain);
    adapter.signalSpawned();
    onConnected();

    client.onOffline(err => {
      if (stopped) return;
      if (++badPolls < 4) return; // Tolerate brief renderer stalls.
      stopped = true;
      try { onDisconnected({ reason: String(err?.message ?? err), willRetry: false }); } catch {}
      try { onError({ error: 'GAME_WORLD_NOT_OPEN', message: 'WebCar disconnected. Reopen the game and summon again.' }); } catch {}
      void handle.stop();
    });
    // Recover missed poll counter on successful observations.
    const originalObserve = client.observe;
    if (typeof client.onOnline === 'function') client.onOnline(() => { badPolls = 0; });
    client.start();
  } catch (err) {
    const message = String(err?.message ?? err);
    logger.warn?.('[webcar] failed to start: ' + message);
    try { onError({ error: 'GAME_WORLD_NOT_OPEN', message }); } catch {}
  }
  return handle;
}
