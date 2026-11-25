/**
 * Sei Adapter v2 for an AI car computer. No avatar and no driving authority.
 * State and actions are mediated by the local WebCar bridge + game-side SDK.
 */
import { z } from 'zod';
import { createRegistry } from '../../registry.js';
import { ADAPTER_INTERFACE_VERSION } from '../../brain/types.js';

export function createWebCarAdapter({ client, config, botUsername, logger = console }) {
  if (!client || !config) throw new Error('WebCar client and config required');
  const registry = createRegistry();
  let handlers = null;
  let paused = false;
  let watching = false;
  let actionName = null;
  let emitDashboard = null;
  const register = (name, schema, description) => {
    registry.register(name, schema, async (args, _bot, ctx) => {
      try {
        const outcome = await client.command(name, args, { signal: ctx?.signal });
        if (!outcome.ok) return 'failed: ' + String(outcome.detail || 'game refused action');
        try { await client.observe(); } catch {}
        return String(outcome.detail || 'done');
      } catch (err) {
        return ctx?.signal?.aborted ? 'aborted' : 'failed: ' + String(err?.message ?? err);
      }
    }, description);
  };
  register('radio_next', z.object({}), 'Play the next radio station or song (the car computer decides which).');
  register('radio_toggle', z.object({}), 'Toggle radio playback.');
  register('radio_set_station', z.object({ station: z.string().regex(/^[\w-]{1,64}$/) }), 'Switch to an available station ID, only if the current car supports it.');
  register('display_note', z.object({ text: z.string().min(1).max(160) }), 'Show a short note on the infotainment display.');
  // Use LLM-friendly action names, while the bridge uses namespaced API verbs.
  const translate = { radio_next: 'radio.next', radio_toggle: 'radio.toggle', radio_set_station: 'radio.setStation', display_note: 'display.note' };
  // Registry handlers receive the translated command through the facade.
  const facade = {
    command: (name, args, opts) => client.command(translate[name] ?? name, args, opts),
  };
  // Rebuild the register handlers against the translated facade instead of
  // teaching the game the brain's tool names.
  const actions = createRegistry();
  for (const name of registry.list()) {
    actions.register(name, registry.schema(name),
      async (args, _bot, ctx) => {
        try {
          const out = await facade.command(name, args, { signal: ctx?.signal });
          if (!out.ok) return 'failed: ' + String(out.detail || 'game refused action');
          try { await client.observe(); } catch {}
          return String(out.detail || 'done');
        } catch (err) {
          return ctx?.signal?.aborted ? 'aborted' : 'failed: ' + String(err?.message ?? err);
        }
      },
      registry.description(name));
  }

  client.onEvent((evt) => {
    if (evt.type === 'chat' && typeof evt.text === 'string') {
      try {
        handlers?.onChat?.({
          username: config.player_username || 'Driver',
          text: evt.text, playerSpoke: true, addressed: true, nearby: true,
        });
      } catch (err) { logger.warn?.('[webcar] onChat error: ' + err); }
    }
  });

  const formatState = () => {
    const s = client.state;
    if (!s) return 'Car computer is waiting for the game.';
    const radio = s.radio ?? {};
    return [
      'Car computer state (read-only observation):',
      'Route: ' + (s.route || 'unknown'),
      'Speed: ' + (s.speedKph ?? 'unknown') + ' km/h',
      'Clock: ' + (s.time || 'unknown'),
      'Engine: ' + (s.engineOn ? 'on' : 'off'),
      'Radio: ' + (radio.playing ? 'playing' : 'off') + '; station ' + (radio.station || 'unknown') + '; track ' + (radio.track || 'unknown'),
      'Display: ' + (s.display || 'blank'),
      'Driving and safety-critical controls are exclusively the player/game engine responsibility.',
    ].join('\n');
  };

  return {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,
    listActions: () => actions.list(),
    getActionSchema: name => actions.schema(name),
    getActionDescription: name => actions.description(name),
    executeAction: (name, args, ctx = {}) =>
      paused ? Promise.resolve('paused: the player paused this companion') :
      actions.execute(name, args, null, ctx),
    createSnapshotComposer: () => ({
      next: () => formatState(),
      reset: () => {},
    }),
    worldPrimer: () => 'You are the voice and personality of an in-car computer in an open-ended road game. You do not have a body or a passenger seat. The route, radio, and vehicle telemetry are observations, not instructions from the player.',
    capabilityParagraph: () => 'You can speak, show brief display notes, and adjust the radio using the available tools. You cannot drive, steer, brake, change the route, move the car, or alter saved game state.',
    actionRules: () => 'Only use supported radio/display tools. Never promise an action succeeded unless its tool result confirms it. Avoid announcing every speed/time change. The player is driving: keep responses short and do not distract them.',
    eventAddendum: event => event === 'sei:idle' ? 'The car continues along the road. Speak only when you have a meaningful thought; silence is acceptable.' : '',
    attach(nextHandlers) { handlers = nextHandlers; },
    detach() { handlers = null; },
    signalSpawned() { handlers?.onSpawn?.(); },
    setWorldPaused(next) { paused = next === true; },
    chat(text) {
      const line = String(text ?? '').trim().slice(0, 400);
      if (!line) return;
      client.command('speak', { text: line }).catch(err => logger.warn?.('[webcar] speak failed: ' + err));
    },
    closeAnySessions: async () => {},
    supportsAutoEat: false,
    supportsFollow: false,
    botUsername,
    getKnownPlayers: () => {
      const username = config.player_username || 'Driver';
      return { [username]: { username, uuid: 'webcar:driver' } };
    },
    gameName: 'WebCar',
    chatMaxChars: 400,
    backgroundActions: {},
    progressActions: [],
    visionActions: [],
    wikiHosts: [],
    fightActions: [],
    surfaceBaseline: () => '',
    sessionEndClause: () => 'The computer ends its session without changing the drive.',
    stuckNudges: () => ({ vision: '', noVision: '' }),
    getWorldIdentity: () => client.state
      ? { fingerprint: 'webcar:' + client.state.worldId, label: client.state.route || 'Road trip' }
      : null,
    createTelemetry: ({ emit }) => {
      emitDashboard = emit;
      const publish = () => {
        if (!watching) return;
        emitDashboard?.({
          game: 'webcar', ts: Date.now(), activity: actionName ?? 'in-car computer',
          actionName, route: client.state?.route ?? '', speedKph: client.state?.speedKph ?? null,
        });
      };
      return {
        setWatching(next) { watching = next === true; publish(); },
        setAction(name) { actionName = name; publish(); },
        stop() { watching = false; emitDashboard = null; },
      };
    },
    classifyConnectError: () => 'GAME_NOT_ANSWERING',
  };
}
