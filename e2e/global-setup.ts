import { execSync } from 'node:child_process'
import { request } from '@playwright/test'

import { listRegistryModels } from './helpers/api'
import { FRONTEND } from './helpers/frontend'
const BACKEND = `http://localhost:${process.env.E2E_BACKEND_PORT ?? 8001}`

export const STORAGE_STATE = '.auth/state.json'

/** The stub backends' builtin models, which DeepLabel adopts once it reaches them. */
async function waitForBuiltinModels(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const tasks = new Set((await listRegistryModels()).filter((m) => m.source === 'backend').map((m) => m.task))
    if (['layout', 'lines', 'ocr'].every((task) => tasks.has(task))) return
    if (Date.now() > deadline) throw new Error('timed out waiting for the builtin models')
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function waitFor(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

export default async function globalSetup() {
  const compose = 'docker compose -f ../compose.e2e.yml'
  // Start from empty volumes so every run sees the same world - unless the stack was
  // started fresh for this run already, as a sharded run does for each of its stacks.
  if (!process.env.E2E_STACK_READY) {
    execSync(`${compose} down -v --remove-orphans`, { stdio: 'inherit' })
    execSync(`${compose} up -d --build`, { stdio: 'inherit' })
  }
  await waitFor(`${BACKEND}/docs`, 120_000)
  await waitFor(FRONTEND, 120_000)
  await waitForBuiltinModels(90_000)

  // Log in once through the dev bypass and share the session cookie with every
  // test, so scenarios can deep-link straight to any page.
  const session = await request.newContext({ baseURL: FRONTEND })
  await session.get('/api/login')
  await session.storageState({ path: STORAGE_STATE })
  await session.dispose()
}
