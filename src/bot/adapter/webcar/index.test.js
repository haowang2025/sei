import { describe, it, expect, vi } from 'vitest'
import { createWebCarAdapter } from './index.js'
import { botUsernameFor, adapterConfigFrom, checkJoinTarget } from './runtime.js'

const config = { player_username: 'Driver', persona: { name: 'Sui' }, world_label: 'Road 37' }
function makeClient() {
  let event = () => {}
  return {
    state: {
      worldId: 'save-37', route: 'Road 37', speedKph: 89, time: '23:20',
      engineOn: true, radio: { station: 'night', playing: true, track: 'Test Track' }, display: 'Hi',
    },
    onEvent(fn) { event = fn },
    emit(e) { event(e) },
    command: vi.fn(async (name, args) => ({ ok: true, detail: name + ':' + JSON.stringify(args) })),
    observe: vi.fn(async () => {}),
  }
}
describe('WebCar in-dash Adapter v2', () => {
  it('is an infotainment-only tool surface', async () => {
    const client = makeClient()
    const adapter = createWebCarAdapter({ client, config, botUsername: 'Sui' })
    expect(adapter.listActions()).toEqual(['radio_next', 'radio_toggle', 'radio_set_station', 'display_note'])
    expect(adapter.listActions()).not.toContain('drive')
    expect(adapter.getActionDescription('radio_next')).toMatch(/radio/)
    const result = await adapter.executeAction('radio_set_station', { station: 'night' })
    expect(result).toMatch(/radio\.setStation/)
    expect(client.command).toHaveBeenCalledWith('radio.setStation', { station: 'night' }, { signal: undefined })
    await expect(adapter.executeAction('radio_set_station', { station: '../../etc' })).rejects.toThrow()
    await expect(adapter.executeAction('drive', {})).rejects.toThrow(/Unknown action/)
  })

  it('captures a stable world, snapshots and driver chat', () => {
    const client = makeClient()
    const adapter = createWebCarAdapter({ client, config, botUsername: 'Sui' })
    const onSpawn = vi.fn(), onChat = vi.fn()
    adapter.attach({ onSpawn, onChat })
    adapter.signalSpawned()
    client.emit({ type: 'chat', text: 'Hey Sei' })
    expect(onSpawn).toHaveBeenCalledTimes(1)
    expect(onChat).toHaveBeenCalledWith(expect.objectContaining({
      username: 'Driver', text: 'Hey Sei', addressed: true, playerSpoke: true,
    }))
    expect(adapter.createSnapshotComposer().next({ lastActionResult: null, inFlight: null })).toContain('Road 37')
    expect(adapter.getWorldIdentity()).toEqual({ fingerprint: 'webcar:save-37', label: 'Road 37' })
    adapter.detach()
    client.emit({ type: 'chat', text: 'Not delivered' })
    expect(onChat).toHaveBeenCalledTimes(1)
  })

  it('honors pause and routes speech only to the display', async () => {
    const client = makeClient()
    const adapter = createWebCarAdapter({ client, config, botUsername: 'Sui' })
    adapter.setWorldPaused(true)
    expect(await adapter.executeAction('radio_next', {})).toMatch(/paused/)
    adapter.setWorldPaused(false)
    adapter.chat('Hello from Sei')
    expect(client.command).toHaveBeenCalledWith('speak', { text: 'Hello from Sei' })
  })
})

describe('WebCar runtime helpers', () => {
  it('derives a bounded name and validates join targets', () => {
    expect(botUsernameFor({ name: 'Sui' })).toBe('Sui')
    expect(adapterConfigFrom({ joinTarget: { port: 61235, token: 'abc' }, botUsername: 'Sui' }))
      .toMatchObject({ host: '127.0.0.1', port: 61235, token: 'abc', username: 'Sui' })
    expect(checkJoinTarget(null)?.error).toBe('GAME_WORLD_NOT_OPEN')
    expect(checkJoinTarget({ port: 61235, token: 'abc' })).toBeNull()
  })
})
