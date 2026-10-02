import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as stock from '../src/index.ts'
import type { ResolvedPiAiProviderProfile } from '../src/config.ts'

let ctx: Context | undefined

afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined })

async function mount(transform?: stock.PiAiProfileTransform) {
  ctx = new Context()
  await ctx.plugin(LlmRuntime)
  let mountedConfig: stock.Config | undefined
  const fiber = await ctx.plugin({
    name: stock.name,
    inject: stock.inject,
    Config: stock.Config,
    apply: (inner: Context, config: stock.Config) => {
      mountedConfig = config
      stock.applyWithProfileTransform(inner, config, transform)
    },
  }, { providers: { 'openai-codex': {}, openai: { models: [{ id: 'gpt-4.1' }] } } })
  if (!mountedConfig) throw new Error('Expected the plugin to mount its configuration')
  return { context: ctx, fiber, providers: mountedConfig.providers }
}

describe('public resolved-profile transform', () => {
  it('retains stock provider routes, catalog and credential settings namespace without a transform', async () => {
    const { context, fiber } = await mount()
    expect(context.llm.listProviders().map(x => x.id).sort()).toEqual(['openai', 'openai-codex'])
    expect((await context.llm.listModels('openai')).map(x => x.id)).toEqual(['gpt-4.1'])
    expect(context.llm.listConfigurableProviders().find(x => x.provider === 'openai-codex')?.settingsNs).toBe('llm-pi-ai')
    await fiber.dispose()
    expect(context.llm.listProviders()).toEqual([])
  })

  it('captures one transformed generation and reruns only when the raw volatile profile generation changes', async () => {
    const generations: ReadonlyMap<string, ResolvedPiAiProviderProfile>[] = []
    const { context, fiber, providers } = await mount((profiles) => {
      generations.push(profiles)
      const next = new Map(profiles)
      const codex = profiles.get('openai-codex')!
      next.set('openai-codex', { ...codex, displayName: 'Transformed Codex' })
      expect(next.get('openai')).toBe(profiles.get('openai'))
      return next
    })
    await context.llm.listModels('openai-codex')
    await context.llm.listModels('openai')
    expect(generations).toHaveLength(1)
    expect(context.llm.listProviders().find(x => x.id === 'openai-codex')?.name).toBe('Transformed Codex')
    expect(generations[0]?.get('openai-codex')?.displayName).not.toBe('Transformed Codex')
    updateVolatile(providers, stock.Config({ providers: { 'openai-codex': {} } }).providers)
    fiber.ctx.emit('loader/volatile-update', [['providers']])
    await context.llm.listModels('openai-codex')
    expect(generations).toHaveLength(2)
    expect(context.llm.listProviders().map(x => x.id)).toEqual(['openai-codex'])
  })
})
