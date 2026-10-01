import { describe, expect, it } from 'vitest'
import { BlockAssembler, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'

function delta(index: number, id: string, name?: string): StreamChunk {
  return { type: 'tool-call-delta', index, id: ToolCallId(id), ...(name === undefined ? {} : { name }), argumentsDelta: '{}' }
}

describe('BlockAssembler tool-call ID continuity', () => {
  it.each(['text', 'reasoning'] as const)('keeps closed %s content when a late delta arrives', (type) => {
    const assembler = new BlockAssembler()
    const block = { type, text: 'authoritative' }
    assembler.push({ type: 'block-end', index: 0, block })
    assembler.push({ type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: 0, text: 'late' })
    expect(assembler.blocks()).toEqual([block])
  })

  it('retains a recorded ID across an empty continuation', () => {
    const assembler = new BlockAssembler()
    assembler.push(delta(0, 'recorded', 'echo'))
    assembler.push(delta(0, ''))
    expect(assembler.blocks()).toEqual([{ type: 'tool-call', id: 'recorded', name: 'echo', arguments: '{}{}' }])
  })

  it('retains an explicitly empty ID when every delta ID is empty', () => {
    const assembler = new BlockAssembler()
    assembler.push(delta(0, ''))
    assembler.push(delta(0, ''))
    expect(assembler.blocks()).toEqual([{ type: 'tool-call', id: '', name: '', arguments: '{}{}' }])
  })

  it('keeps the existing fallback when no delta supplies an ID', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-start', index: 4, blockType: 'tool-call' })
    expect(assembler.blocks()).toEqual([{ type: 'tool-call', id: 'call-4', name: '', arguments: '' }])
  })

  it('accepts a later nonempty ID after a recorded nonempty ID', () => {
    const assembler = new BlockAssembler()
    assembler.push(delta(0, 'earlier'))
    assembler.push(delta(0, 'later'))
    expect(assembler.blocks()).toEqual([{ type: 'tool-call', id: 'later', name: '', arguments: '{}{}' }])
  })

  it('accepts a later nonempty ID after an empty initial ID', () => {
    const assembler = new BlockAssembler()
    assembler.push(delta(0, ''))
    assembler.push(delta(0, 'later'))
    expect(assembler.blocks()).toEqual([{ type: 'tool-call', id: 'later', name: '', arguments: '{}{}' }])
  })

  it('keeps interleaved blocks and their IDs independent', () => {
    const assembler = new BlockAssembler()
    assembler.push(delta(7, 'first'))
    assembler.push(delta(2, ''))
    assembler.push(delta(7, ''))
    expect(assembler.blocks()).toEqual([
      { type: 'tool-call', id: 'first', name: '', arguments: '{}{}' },
      { type: 'tool-call', id: '', name: '', arguments: '{}' },
    ])
  })

  it('uses an authoritative empty close even after a nonempty delta', () => {
    const assembler = new BlockAssembler()
    assembler.push(delta(0, 'recorded', 'echo'))
    const block = { type: 'tool-call' as const, id: ToolCallId(''), name: '', arguments: '{}' }
    assembler.push({ type: 'block-end', index: 0, block })
    expect(assembler.blocks()).toEqual([block])
  })

  it('ignores stragglers and repeated closes after the first close', () => {
    const assembler = new BlockAssembler()
    const block = { type: 'tool-call' as const, id: ToolCallId('closed'), name: 'echo', arguments: '{}' }
    assembler.push({ type: 'block-end', index: 0, block })
    assembler.push(delta(0, 'later', 'changed'))
    assembler.push(delta(0, ''))
    assembler.push({ type: 'block-end', index: 0, block: { ...block, id: ToolCallId('different') } })
    expect(assembler.blocks()).toEqual([block])
  })

  it('preserves input chunks and the name and argument assembly', () => {
    const assembler = new BlockAssembler()
    const chunks = [delta(0, 'recorded', 'first'), delta(0, '', ''), delta(0, 'later', 'last')]
    const before = structuredClone(chunks)
    for (const chunk of chunks) assembler.push(chunk)
    expect(chunks).toEqual(before)
    expect(assembler.blocks()).toEqual([{ type: 'tool-call', id: 'later', name: 'last', arguments: '{}{}{}' }])
  })
})
