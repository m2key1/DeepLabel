import { execSync } from 'node:child_process'
import type { Browser, Page } from '@playwright/test'
import { expect } from './test'

// The frontend whose auth service signs in through the stub Authentik rather than the dev
// bypass. Docker picks its port, so it is asked for once the stack is up.
let site = ''

export async function signInSite(): Promise<string> {
  if (site) return site
  const bound = execSync('docker compose -f ../compose.e2e.yml port frontend-oidc 80').toString().trim()
  site = `http://${bound.replace('0.0.0.0', '127.0.0.1')}`
  await expect.poll(async () => {
    try {
      return (await fetch(`${site}/api/login`, { redirect: 'manual' })).status
    } catch {
      return 0
    }
  }, { timeout: 60_000 }).toBe(303)
  return site
}

/** Who the browser is signed in as, asked of the auth service rather than the page. */
export async function signedInAs(page: Page): Promise<string | null> {
  const me = await page.request.get(`${site}/api/me`, { maxRedirects: 0 })
  return me.ok() ? (await me.json()).user : null
}

/** The auth service's own view of the signed-in account. */
export async function me(page: Page): Promise<{ user: string; role: string; pending: boolean } | null> {
  const answer = await page.request.get(`${site}/api/me`, { maxRedirects: 0 })
  return answer.ok() ? answer.json() : null
}

/** Fill the sign-in form and send it, waiting for the auth service's answer. */
export async function submit(page: Page, email: string, password: string) {
  await page.getByTestId('sign-in-email').fill(email)
  await page.getByTestId('sign-in-password').fill(password)
  const answered = page.waitForResponse((r) => r.url().endsWith('/api/sign-in'))
  await page.getByTestId('sign-in-submit').click()
  return (await answered).status()
}

/** A browser of its own, signed in as this person, on the sign-in site. */
export async function signedInPage(browser: Browser, email: string, password: string): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const page = await context.newPage()
  await page.goto(`${site}/sign-in`)
  expect(await submit(page, email, password)).toBe(200)
  await expect.poll(() => signedInAs(page)).toBe(email)
  return page
}
