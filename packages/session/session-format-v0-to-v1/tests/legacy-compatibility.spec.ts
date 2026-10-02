import { describe, expect, it } from 'vitest'
import { restoreV0ToV1, restoreV1 } from '../src/testing/restore.ts'

const header = { type: 'session', version: 0, id: 'legacy-compatibility', createdAt: 1, delegationDepth: 0 }

function descriptorRows(data: unknown) {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'subagent/descriptor', seq: 1, time: 2, data },
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

function deltaRows(name: unknown, extra: Record<string, unknown> = {}) {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: 'assistant/chunk', seq: 2, time: 3, data: { turn: 1, step: 1, chunk: {
      type: 'tool-call-delta', index: 0, id: 'recorded-call', argumentsDelta: '{}',
      ...(name === undefined ? {} : { name }), ...extra,
    } } },
    { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('bounded released-v0 compatibility', () => {
  it.each([
    { version: 2, mode: 'one-shot', provider: 'local' },
    { version: 2, mode: 'one-shot', provider: 'local', label: 'child' },
    { version: 2, mode: 'continuable', provider: 'local', label: 'child', agentProvider: 'route',
      agentModel: 'model', persona: 'instructions', toolFilter: { allow: ['read'], deny: ['write'] } },
  ])('preserves v2 descriptor composition while promoting its marker: %o', (descriptor) => {
    const rows = descriptorRows(descriptor)
    const before = structuredClone(rows)
    const restored = restoreV0ToV1(header, rows)
    expect(restored.events[1]?.data).toEqual({ ...descriptor, version: 3 })
    expect(restored.events[1]?.data).not.toHaveProperty('agentReasoningEffort')
    expect(rows).toEqual(before)
  })

  it.each([{ future: true }, { agentReasoningEffort: 'high' }])('refuses unknown v2 descriptor members: %o', (extra) => {
    expect(() => restoreV0ToV1(header, descriptorRows({ version: 2, mode: 'continuable', provider: 'local', label: 'child', ...extra })))
      .toThrow(/unexpected member/)
  })

  it('retains the current v3 descriptor without introducing a default', () => {
    const descriptor = { version: 3, mode: 'continuable', provider: 'local', label: 'child', agentReasoningEffort: 'high' }
    expect(restoreV0ToV1(header, descriptorRows(descriptor)).events[1]?.data).toEqual(descriptor)
  })

  it('normalizes only null delta-name while preserving coordinates, identity and arguments', () => {
    const rows = deltaRows(null)
    const before = structuredClone(rows)
    const expected = deltaRows(undefined)
    expect(restoreV0ToV1(header, rows).events).toEqual(expected)
    expect(rows).toEqual(before)
  })

  it.each([undefined, '', 'read'])('preserves distinct valid delta-name values: %s', (name) => {
    const rows = deltaRows(name)
    expect(restoreV0ToV1(header, rows).events).toEqual(rows)
  })

  it('refuses unknown null-delta members rather than discarding them', () => {
    expect(() => restoreV0ToV1(header, deltaRows(null, { future: true }))).toThrow(/unexpected member/)
  })

  it('leaves direct-v1 null-name admission strict', () => {
    expect(() => restoreV1({ ...header, version: 1 }, deltaRows(null))).toThrow(/name must be a string/)
  })
})
