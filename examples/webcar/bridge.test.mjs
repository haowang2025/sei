import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebCarBridge, sanitizeState, validateCommand } from './bridge.mjs';

const token = 'testing-webcar-local-token-32-chars';
const headers = { 'x-sei-webcar-token': token, 'content-type': 'application/json' };

test('sanitizes telemetry and disallows driving authority', () => {
  const obs = sanitizeState({
    worldId: 'demo', route: 'road', speedKph: 900, engineOn: true,
    radio: { playing: true, station: 'night' }, secret: 'not forwarded',
  });
  assert.equal(obs.speedKph, 500);
  assert.equal(Object.hasOwn(obs, 'secret'), false);
  assert.equal(validateCommand('drive.steer', { angle: 1 }), 'unsupported action');
  assert.equal(validateCommand('radio.setStation', { station: '../../bad' }) !== null, true);
  assert.equal(validateCommand('radio.next', {}), null);
});

test('local bridge enforces token, game heartbeat, chat, commands and result', async () => {
  const bridge = await createWebCarBridge({ port: 0, token, logger: { warn() {} }, commandTimeoutMs: 2000 });
  const root = 'http://127.0.0.1:' + bridge.port;
  async function call(path, { method = 'GET', data, sendToken = true, origin } = {}) {
    const res = await fetch(root + path, {
      method,
      headers: { ...(sendToken ? headers : {}), ...(origin ? { Origin: origin } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: res.status, body: await res.json(), headers: res.headers };
  }
  try {
    const health = await call('/health');
    assert.equal(health.body.gameOnline, false);
    assert.equal((await call('/agent/state', { sendToken: false })).status, 401);
    assert.equal((await call('/agent/state', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await call('/game/state', { method: 'POST', data: {
      worldId: 'route37', route: 'Night road', speedKph: 87, engineOn: true,
      radio: { station: 'night', playing: true, track: 'Ambient' },
    } })).status, 200);
    assert.equal((await call('/health')).body.gameOnline, true);
    assert.equal((await call('/game/chat', { method: 'POST', data: { text: 'Hello, car.' } })).status, 200);
    const seen = await call('/agent/state?since=0');
    assert.equal(seen.body.state.route, 'Night road');
    assert.equal(seen.body.events.length, 1);
    assert.equal(seen.body.events[0].text, 'Hello, car.');
    assert.equal((await call('/agent/state?since=' + seen.body.seq)).body.events.length, 0);
    assert.equal((await call('/agent/command', {
      method: 'POST', data: { name: 'drive.brake', args: {} },
    })).status, 400);

    const queued = call('/agent/command', { method: 'POST', data: { name: 'radio.next', args: {} } });
    // Wait until HTTP request is received and enqueued.
    let commands = [];
    for (let i = 0; i < 30 && !commands.length; i++) {
      commands = (await call('/game/commands')).body.commands;
      if (!commands.length) await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(commands.length, 1);
    assert.equal(commands[0].name, 'radio.next');
    assert.equal((await call('/game/result', { method: 'POST',
      data: { id: commands[0].id, ok: true, detail: 'station changed' },
    })).status, 200);
    const result = await queued;
    assert.deepEqual(result.body, { ok: true, detail: 'station changed' });

    // Sei say() uses the separate, non-LLM "speak" bridge command.
    const spoken = call('/agent/command', { method: 'POST', data: { name: 'speak', args: { text: 'Hi driver' } } });
    let speech = [];
    for (let i = 0; i < 30 && !speech.length; i++) {
      speech = (await call('/game/commands')).body.commands;
      if (!speech.length) await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(speech[0]?.name, 'speak');
    await call('/game/result', { method: 'POST', data: { id: speech[0].id, ok: true } });
    assert.equal((await spoken).body.ok, true);
  } finally {
    await bridge.close();
  }
});

test('demo and SDK are served as HTML/JS from the bridge', async () => {
  const bridge = await createWebCarBridge({ port: 0, token });
  try {
    const root = 'http://127.0.0.1:' + bridge.port;
    const demo = await fetch(root + '/demo');
    assert.equal(demo.status, 200);
    assert.match(demo.headers.get('content-type'), /text\/html/);
    assert.match(await demo.text(), /Car computer/);
    const sdk = await fetch(root + '/browser-client.js');
    assert.equal(sdk.status, 200);
    assert.match(await sdk.text(), /createWebCarClient/);
  } finally { await bridge.close(); }
});
