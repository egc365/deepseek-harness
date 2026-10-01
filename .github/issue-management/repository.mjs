/** Validated runtime repository identity and the configured Project boundary. */

import fs from 'node:fs'
import process from 'node:process'
import config from './config.json' with { type: 'json' }

function parseRepository(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value) || ['.', '..'].includes(value.split('/')[1])) {
    throw new Error('Invalid repository identity')
  }
  return value
}

/** Resolve the event repository, rejecting mismatched runtime and PR base identities. */
export function repositoryFullName(event = undefined) {
  const runtime = process.env.GITHUB_REPOSITORY
  const file = process.env.GITHUB_EVENT_PATH
  if (!runtime && !file && !event?.repository && process.env.GITHUB_ACTIONS !== 'true') {
    return parseRepository(`${config.organization}/${config.repository}`)
  }
  const expected = parseRepository(runtime)
  const recorded = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : event
  if (!recorded?.repository) throw new Error('Missing event repository identity')
  for (const input of [recorded, ...(event ? [event] : [])]) {
    const repository = input.repository
    if (!repository || parseRepository(repository.full_name).toLowerCase() !== expected.toLowerCase() || !Number.isSafeInteger(repository.id) || repository.id < 1) {
      throw new Error('Event/runtime repository identity mismatch')
    }
    if (process.env.GITHUB_REPOSITORY_ID && String(repository.id) !== process.env.GITHUB_REPOSITORY_ID) {
      throw new Error('Event/runtime repository ID mismatch')
    }
    if (input.pull_request) {
      const base = input.pull_request.base?.repo
      if (!base || parseRepository(base.full_name).toLowerCase() !== expected.toLowerCase() || base.id !== repository.id) {
        throw new Error('Pull request base repository identity mismatch')
      }
      assertIssueNumber(input.pull_request.number)
    }
    if (input.issue) assertIssueNumber(input.issue.number)
  }
  return expected
}

/** Reject non-positive or non-integral Issue and PR identifiers before REST reads. */
export function assertIssueNumber(number) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid Issue/PR number')
}

/** Enable Project access only for the explicitly configured repository. */
export function projectAutomationEnabled() {
  return repositoryFullName().toLowerCase() === `${config.organization}/${config.repository}`.toLowerCase()
}

/** Declare the trusted lifecycle token requirement without performing GitHub reads or writes. */
export function runLifecyclePreflight(event) {
  repositoryFullName(event)
  const enabled = projectAutomationEnabled()
  if (enabled && (!process.env.DSH_ISSUE_APP_CLIENT_ID || !process.env.DSH_ISSUE_APP_PRIVATE_KEY)) {
    throw new Error('Configured upstream Project automation requires its App client ID and private key')
  }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `needs-project=${enabled}\n`)
  process.stdout.write(enabled ? 'Configured upstream Project automation enabled.\n' : 'Project automation not configured for this repository; Issue label metadata remains local.\n')
}
