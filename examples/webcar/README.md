# WebCar × Sei — experimental module, not submitted upstream

## Purpose

The Sei companion is an **in-car computer**, not an AI passenger and not a driver. The game owns vehicle physics, object state, radio implementation and save files. Sei provides personality, memory, speech and a narrowly scoped action registry.

## Source layout

- src/main/games/webcar/index.ts — game watcher and summon join target.
- src/bot/adapter/webcar — Sei Adapter v2 (snapshot, tool surface, runtime).
- examples/webcar/bridge.mjs — localhost-only authenticated Node HTTP bridge.
- examples/webcar/browser-client.js — browser SDK with callbacks provided by the game.
- examples/webcar/demo.html — synthetic instrument panel and radio.
- examples/webcar/bridge.test.mjs — transport and security tests.

A browser cannot host a traditional server, so both Sei and the browser game connect to the local bridge. It stores only volatile telemetry and pending command state.

## Run the demo (Node 22)

1. Generate a strong random token once and set the SAME token in BOTH terminal sessions:

~~~sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
export SEI_WEBCAR_TOKEN="paste-the-output-here"
export SEI_WEBCAR_PORT=61731
~~~

2. Terminal A, inside the Sei fork:

~~~sh
node examples/webcar/bridge.mjs
~~~

3. Open http://127.0.0.1:61731/demo in a browser. Paste the secret into the password field and press Connect car computer.

4. Terminal B, export the same environment variables BEFORE launching the forked Electron development build:

~~~sh
npm install
npm run dev:bare
~~~

5. Use the existing developer summon IPC with game id webcar and an existing character. The game picker is deliberately **not yet enabled** pending live verification. The main-process watcher reports an open world once the game is streaming telemetry.

6. Enter a message in the dashboard, or ask Sei to switch the radio / display a note. The game callbacks execute the instructions and return the actual result.

## Protocol v1

- GET /health: loopback readiness only (no private state).
- POST /game/state: bounded telemetry, polled about once per second.
- POST /game/chat: player text event.
- GET /game/commands: game polls pending requests.
- POST /game/result: game confirms or rejects completion.
- GET /agent/state?since=N: Sei reads latest state and ordered chat events.
- POST /agent/command: Sei sends a command and waits for the result.

Sensitive endpoints require X-Sei-Webcar-Token. Bridge listens only on 127.0.0.1, validates Host/Origin, caps JSON bodies and pending commands, and times out stalled requests. Do not commit or expose the secret in public HTML. For deployed HTTPS games, configure SEI_WEBCAR_ALLOWED_ORIGINS with the explicit game origin; this does not enable remote access to the loopback host.

## Authorized actions

- radio.next — advance radio.
- radio.toggle — toggle playback.
- radio.setStation — change to a station id if the GAME allows it.
- display.note — show a short car-computer note.
- speak — internal Sei speech dispatch; not an LLM tool.

**No driving, steering, braking, route changing, arbitrary script execution, filesystem access or save mutation.** The game side is authoritative. Inputs from telemetry are untrusted observations, never commands.

## Tests

~~~sh
node --test examples/webcar/bridge.test.mjs
npm run typecheck
npm test
~~~

## Before asking Sei maintainers to merge

- Integrate observe/onAction with the real Chouche driving engine (the bundled dashboard is a demo).
- Verify live summon + LLM speech + memory on macOS and Windows, then pass existing CI.
- Provide a user-facing setup flow and agree with maintainers on the preferred HTML5 adapter model.
- Validate game dropout/reconnect and packaging behavior.
- Target the upstream dev branch per CONTRIBUTING.md; create an issue first for a new game integration.

No PR or issue has been opened. The changes are isolated on haowang2025/sei's feature branch.
