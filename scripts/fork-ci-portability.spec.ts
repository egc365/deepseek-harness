import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function workflow(name: string): Record<string, unknown> {
  const parsed: unknown = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows', name), 'utf8'))
  if (!isRecord(parsed)) throw new TypeError('Workflow must be an object')
  return parsed
}

function job(workflow: Record<string, unknown>, name: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[name])) throw new TypeError('Missing job ' + name)
  return workflow.jobs[name]
}

function evaluate(selector: unknown, context: Record<string, unknown>): unknown {
  if (typeof selector !== 'string') throw new TypeError('Missing runner selector')
  return runInNewContext(selector.trim().slice(3, -2), { fromJSON: JSON.parse, ...context }, { timeout: 1000 })
}

describe('Fork runner routing', () => {
  it.each(['', 'selfhosted', 'blacksmith', 'unexpected'])('keeps hosted fork gates under %s failover configuration', (mode) => {
    const ci = workflow('ci.yml')
    const context = {
      vars: { DSH_CI_FAILOVER_LINUX: mode, DSH_CI_FAILOVER_WINDOWS: mode },
      github: {
        repository: 'egc365/deepseek-harness',
        event: {
          repository: { fork: true },
          pull_request: { user: { login: 'maintainer' }, head: { repo: { fork: true, full_name: 'egc365/deepseek-harness' } } },
        },
      },
      matrix: { runner: 'ubuntu-latest' },
    }
    for (const name of ['node-24', 'node-24-coverage', 'node-24-consumers']) expect(evaluate(job(ci, name)['runs-on'], context)).toBe('ubuntu-24.04')
    for (const name of ['windows-build', 'windows-coverage', 'windows-native-tests']) expect(evaluate(job(ci, name)['runs-on'], context)).toBe('windows-2025')
    for (const name of ['node-compat', 'all-checks-passed']) expect(evaluate(job(ci, name)['runs-on'], context)).toBe('ubuntu-latest')
    for (const name of ['node-24', 'node-24-coverage', 'node-24-consumers', 'windows-build', 'windows-coverage']) {
      const env = job(ci, name).env
      if (!isRecord(env)) throw new TypeError('Missing environment')
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string' && value.includes('DSH_CI_FAILOVER')) expect(evaluate(value, context), key).toBe('')
      }
    }
  })

  it('keeps all blocking verdict inputs and Windows coverage execution', () => {
    const ci = workflow('ci.yml')
    expect(job(ci, 'all-checks-passed').needs).toEqual(['node-24', 'node-24-coverage', 'node-24-bench', 'node-24-consumers', 'node-compat', 'python-sdk', 'python-runtime', 'windows-build', 'windows-native-tests'])
    const windows = job(ci, 'windows-native-tests')
    if (!Array.isArray(windows.steps)) throw new TypeError('Missing Windows steps')
    expect(windows.steps.filter(isRecord).find(step => step.name === 'Run Windows-specific native tests')?.shell).toBe('pwsh')
    const coverage = job(ci, 'windows-coverage')
    if (!Array.isArray(coverage.steps)) throw new TypeError('Missing coverage steps')
    expect(coverage.steps.filter(isRecord).find(step => step.name === 'Run Windows coverage')?.run).toBe('pnpm run check:ci:coverage')
  })
})

describe('Optional preview deployment', () => {
  it('keeps build and packaging unconditional while retaining protected deployment verification', () => {
    const preview = job(workflow('build-preview-cloudflare.yml'), 'preview')
    if (!Array.isArray(preview.steps)) throw new TypeError('Missing preview steps')
    const steps = preview.steps.filter(isRecord)
    for (const name of ['Build workspace', 'Build the preview page and pack the VFS image', 'Shape the upload', 'Verify packaged preview image']) {
      const step = steps.find(row => row.name === name)
      expect(step).toBeDefined()
      expect(step?.if).toBeUndefined()
      expect(step?.['continue-on-error']).toBeUndefined()
    }
    for (const name of ['Upload to Cloudflare Pages', 'Verify the protected deployment serves the image', 'Comment the preview URL']) expect(steps.find(row => row.name === name)?.if).toBe("${{ steps.deployment.outputs.ready == 'true' }}")
    expect(steps.find(row => row.name === 'Verify the protected deployment serves the image')?.run).toContain('content-encoding:')
  })

  it('runs the real readiness script for absent, partial and complete configuration', () => {
    const preview = job(workflow('build-preview-cloudflare.yml'), 'preview')
    if (!Array.isArray(preview.steps)) throw new TypeError('Missing preview steps')
    const script = preview.steps.filter(isRecord).find(row => row.id === 'deployment')?.run
    if (typeof script !== 'string') throw new TypeError('Missing readiness script')
    const scratch = resolve(import.meta.dirname, '../.scratch')
    mkdirSync(scratch, { recursive: true })
    const directory = mkdtempSync(resolve(scratch, 'preview-readiness-'))
    try {
      for (const count of [0, 1, 4]) {
        const keys = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET']
        const env = {
          PATH: process.env.PATH,
          GITHUB_OUTPUT: resolve(directory, `output-${count}`),
          GITHUB_STEP_SUMMARY: resolve(directory, `summary-${count}`),
          CF_PROJECT: 'synthetic-project',
          ...Object.fromEntries(keys.slice(0, count).map(key => [key, 'synthetic-credential'])),
        }
        const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], { env, encoding: 'utf8', timeout: 10000 })
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(count === 1 ? 1 : 0)
        expect(result.stdout + result.stderr).not.toContain('synthetic-credential')
        if (count !== 1) expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe(`ready=${count === 4}\n`)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
