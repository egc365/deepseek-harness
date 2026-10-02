import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '../..')
const { runPullRequestPreflight, runPullRequestCheck, pullRequestSnapshot, lifecyclePullRequestSnapshot } = await import(pathToFileURL(path.join(root, '.github/issue-management/pull-request.mjs')))
const { runLifecycle } = await import(pathToFileURL(path.join(root, '.github/issue-management/lifecycle.mjs')))
const { repositoryFullName, projectAutomationEnabled, runLifecyclePreflight } = await import(pathToFileURL(path.join(root, '.github/issue-management/repository.mjs')))
const fixtureRoot = path.resolve(root, '.scratch/fork-ci-fixtures')
fs.mkdirSync(fixtureRoot, { recursive: true })
function fixture(t, overrides = {}) {
  const repository = { full_name: 'egc365/deepseek-harness', id: 1234, fork: true }
  const event = { repository, action: 'opened', pull_request: { number: 1, base: { repo: repository }, head: { repo: { full_name: 'outside/contribution', id: 4321, fork: true } } }, ...overrides }
  const dir = fs.mkdtempSync(path.join(fixtureRoot, 'case-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'event.json')
  fs.writeFileSync(file, JSON.stringify(event))
  const values = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repository.full_name, GITHUB_REPOSITORY_ID: String(repository.id), GITHUB_EVENT_PATH: file, GITHUB_TOKEN: 'synthetic', GITHUB_OUTPUT: path.join(dir, 'output'), GH_TOKEN: '', PROJECT_TOKEN: '', DSH_ISSUE_APP_CLIENT_ID: '', DSH_ISSUE_APP_PRIVATE_KEY: '' }
  const old = new Map(Object.keys(values).map(key => [key, process.env[key]]))
  Object.assign(process.env, values)
  t.after(() => { for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const pathname = new URL(url).pathname + new URL(url).search
    requests.push({ path: pathname, method: options.method ?? 'GET' })
    assert.match(pathname, /^\/repos\/egc365\/deepseek-harness\//)
    if (pathname.endsWith('/pulls/1')) return Response.json({ number: 1, draft: true, user: { type: 'User' }, labels: [], body: 'Fixes #2', base: { repo: repository } })
    throw Error('Unexpected request ' + pathname)
  })
  return { event, requests, file }
}

test('actual fork draft preflight reads only its own PR and needs no Project', async t => {
  const f = fixture(t)
  assert.deepEqual(await runPullRequestPreflight(f.event), { eligible: false, needsProject: false })
  await runPullRequestCheck(f.event)
  assert.deepEqual(f.requests, Array(2).fill({ path: '/repos/egc365/deepseek-harness/pulls/1', method: 'GET' }))
})

test('fork lifecycle explicitly reports unavailable Project and performs no PR mutations', async t => {
  const f = fixture(t)
  const text = []
  t.mock.method(process.stdout, 'write', s => { text.push(s); return true })
  await runLifecycle('pull_request', f.event)
  assert.deepEqual(f.requests, [])
  assert.match(text.join(''), /Project automation not configured/)
})

for (const [name, change] of [
  ['cross-repository event', e => { e.repository = { ...e.repository, full_name: 'other/repo' } }],
  ['cross-repository PR base', e => { e.pull_request.base.repo = { ...e.repository, full_name: 'other/repo' } }],
  ['mismatched numeric repository ID', e => { e.repository = { ...e.repository, id: 99 } }],
  ['malformed repository path', e => { e.repository = { ...e.repository, full_name: 'egc365/../private' } }],
  ['repository whitespace even when both identities agree', e => { e.repository = { ...e.repository, full_name: 'egc365/deepseek-harness\n' }; e.pull_request.base.repo = e.repository; process.env.GITHUB_REPOSITORY = e.repository.full_name }],
  ['malformed PR number', e => { e.pull_request.number = '../2' }],
]) {
  test(name + ' refuses before requests', async t => {
    const f = fixture(t)
    change(f.event)
    fs.writeFileSync(f.file, JSON.stringify(f.event))
    await assert.rejects(runPullRequestPreflight(f.event), /identity|number|repository/i)
    assert.deepEqual(f.requests, [])
  })
}

test('fork in-review PR still enforces repository labels and Issue references', async t => {
  const f = fixture(t)
  t.mock.method(globalThis, 'fetch', async url => {
    const p = new URL(url).pathname + new URL(url).search
    f.requests.push(p)
    assert.match(p, /^\/repos\/egc365\/deepseek-harness\//)
    if (p.endsWith('/pulls/1')) return Response.json({ number: 1, draft: false, user: { type: 'User' }, labels: [], body: 'Fixes #2; Refs deepseek-harness/deepseek-harness#3', base: { repo: f.event.repository } })
    if (p.endsWith('/requested_reviewers')) return Response.json({ users: [{}], teams: [] })
    if (p.endsWith('/reviews?per_page=100')) return Response.json([])
    if (p.endsWith('/issues/2')) return Response.json({})
    throw Error('Unexpected request ' + p)
  })
  assert.deepEqual(await runPullRequestPreflight(f.event), { eligible: true, needsProject: false })
  await assert.rejects(runPullRequestCheck(f.event), /Issue policy/)
  assert.ok(f.requests.every(p => !p.includes('graphql') && !p.endsWith('/issues/3')))
})

test('fork Issue label cleanup stays local without Project or audit/type claims', async t => {
  const f = fixture(t, { issue: { number: 2 } })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const p = new URL(url).pathname
    f.requests.push({ path: p, method: options.method ?? 'GET' })
    assert.match(p, /^\/repos\/egc365\/deepseek-harness\//)
    if (p.endsWith('/issues/2')) return Response.json({ labels: [{ name: 'kind/feature' }, { name: 'area/llm' }], state: 'open', type: null })
    if (p.endsWith('/labels/kind%2Ffeature')) return new Response(null, { status: 204 })
    throw Error('Unexpected request ' + p)
  })
  await runLifecycle('issues', f.event)
  assert.deepEqual(f.requests, [{ path: '/repos/egc365/deepseek-harness/issues/2', method: 'GET' }, { path: '/repos/egc365/deepseek-harness/issues/2/labels/kind%2Ffeature', method: 'DELETE' }])
})

test('unconfigured fork lifecycle preflight never requires optional App secrets', t => {
  const f = fixture(t)
  delete process.env.DSH_ISSUE_APP_CLIENT_ID
  delete process.env.DSH_ISSUE_APP_PRIVATE_KEY
  runLifecyclePreflight(f.event)
  assert.equal(projectAutomationEnabled(), false)
  assert.equal(fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8'), 'needs-project=false\n')
})

test('configured upstream requires App configuration and preserves Project scope', t => {
  const f = fixture(t)
  f.event.repository = { full_name: 'deepseek-harness/deepseek-harness', id: 99, fork: false }
  f.event.pull_request.base.repo = f.event.repository
  fs.writeFileSync(f.file, JSON.stringify(f.event))
  process.env.GITHUB_REPOSITORY = f.event.repository.full_name
  process.env.GITHUB_REPOSITORY_ID = '99'
  const keys = ['DSH_ISSUE_APP_CLIENT_ID', 'DSH_ISSUE_APP_PRIVATE_KEY']
  for (const k of keys) delete process.env[k]
  assert.equal(projectAutomationEnabled(), true)
  assert.throws(() => runLifecyclePreflight(f.event), /requires its App/)
  process.env.DSH_ISSUE_APP_CLIENT_ID = 'synthetic-client'
  assert.throws(() => runLifecyclePreflight(f.event), /requires its App/)
  process.env.DSH_ISSUE_APP_PRIVATE_KEY = 'synthetic-key'
  runLifecyclePreflight(f.event)
  assert.equal(fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8'), 'needs-project=true\n')
})

test('runtime missing identity or event source fails closed in Actions', t => {
  const f = fixture(t)
  delete process.env.GITHUB_REPOSITORY
  assert.throws(() => repositoryFullName(f.event), /identity/)
  process.env.GITHUB_REPOSITORY = 'egc365/deepseek-harness'
  delete process.env.GITHUB_EVENT_PATH
  assert.throws(() => repositoryFullName(), /identity/)
})

test('API snapshots reject unsafe numbers before transport', async t => {
  const f = fixture(t)
  for (const number of [0, -1, '1', 1.5, NaN, Infinity]) {
    await assert.rejects(pullRequestSnapshot(number), /number/)
    await assert.rejects(lifecyclePullRequestSnapshot(number), /number/)
  }
  assert.deepEqual(f.requests, [])
})

test('fork metadata validation does not claim unknown Project priorities are empty', async t => {
  const f = fixture(t)
  t.mock.method(globalThis, 'fetch', async url => {
    const p = new URL(url).pathname + new URL(url).search
    f.requests.push(p)
    assert.match(p, /^\/repos\/egc365\/deepseek-harness\//)
    if (p.endsWith('/pulls/1')) return Response.json({ draft: false, user: { type: 'User' }, labels: [{ name: 'kind/feature' }, { name: 'area/llm' }, { name: 'p1' }], body: 'Fixes #2' })
    if (p.endsWith('/requested_reviewers')) return Response.json({ users: [{}], teams: [] })
    if (p.endsWith('/reviews?per_page=100')) return Response.json([])
    if (p.endsWith('/issues/2')) return Response.json({})
    throw Error('Unexpected request ' + p)
  })
  const snapshot = await pullRequestSnapshot(1)
  assert.equal(snapshot.projectAvailable, false)
  await runPullRequestCheck(f.event)
  assert.ok(f.requests.every(p => p !== '/graphql'))
})
