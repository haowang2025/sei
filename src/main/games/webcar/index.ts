/**
 * WebCar experimental GameModule. The browser game speaks to a local
 * authentication-gated bridge; Sei joins as its voice-driven car computer.
 * No passenger avatar, no vehicle controls.
 */
import type { Character } from '../../../shared/characterSchema';
import type { WorldState } from '../../../shared/gameIpc';
import type { GameModule, GameWatcher } from '../index';

const DEFAULT_PORT = 61731;
const portFromEnv = () => {
  const n = Number(process.env.SEI_WEBCAR_PORT ?? DEFAULT_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
};
const tokenFromEnv = () => process.env.SEI_WEBCAR_TOKEN ?? '';
type WebCarState = Extract<WorldState, { game: 'webcar' }>;
export function createWebCarGameModule({
  fetchImpl = fetch,
  intervalMs = 3000,
}: { fetchImpl?: typeof fetch; intervalMs?: number } = {}): GameModule {
  let state: WebCarState = { game: 'webcar', kind: 'closed' };
  let timer: ReturnType<typeof setInterval> | null = null;
  let callback: ((s: WorldState) => void) | null = null;
  let inflight: Promise<WebCarState> | null = null;

  async function probe(): Promise<WebCarState> {
    if (!tokenFromEnv() || tokenFromEnv().length < 24) return { game: 'webcar', kind: 'unavailable' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    try {
      const response = await fetchImpl('http://127.0.0.1:' + portFromEnv() + '/health', { signal: controller.signal });
      const hello = await response.json();
      if (!response.ok || hello?.protocol !== 1 || hello?.gameOnline !== true) {
        return { game: 'webcar', kind: 'closed' };
      }
      return {
        game: 'webcar', kind: 'open', label: String(hello.label || 'Road trip').slice(0, 120),
        lastSeenAt: Date.now(),
      };
    } catch {
      return { game: 'webcar', kind: 'closed' };
    } finally { clearTimeout(timeout); }
  }
  function checkNow(): Promise<WebCarState> {
    if (inflight) return inflight;
    inflight = probe().then(next => {
      const changed = next.kind !== state.kind || (next.kind === 'open' && state.kind === 'open' && next.label !== state.label);
      state = next;
      if (changed) callback?.(next);
      return next;
    }).finally(() => { inflight = null; });
    return inflight;
  }
  const watcher: GameWatcher = {
    start({ onUpdate }) {
      callback = onUpdate;
      if (timer) return;
      void checkNow();
      timer = setInterval(() => { void checkNow(); }, intervalMs);
      timer.unref?.();
    },
    checkNow,
    stop() { if (timer) clearInterval(timer); timer = null; callback = null; },
  };
  return {
    id: 'webcar',
    displayName: 'WebCar',
    effectiveUsername: (character: Character) => String(character.username || character.name || 'Sei').slice(0, 24),
    collides: (a, b) => a.toLowerCase() === b.toLowerCase(),
    maxBodies: 1,
    oneBodyError: { error: 'GAME_NOT_ANSWERING', message: 'Only one car computer can be connected at a time.' },
    watcher,
    getWorldState: () => state,
    getJoinTarget: () => state.kind === 'open' && tokenFromEnv().length >= 24
      ? { port: portFromEnv(), token: tokenFromEnv(), label: state.label }
      : null,
    joinTargetMissingError: {
      error: 'GAME_WORLD_NOT_OPEN',
      message: 'Start the WebCar bridge and browser game first. Set SEI_WEBCAR_TOKEN in the Sei process.',
    },
  };
}
