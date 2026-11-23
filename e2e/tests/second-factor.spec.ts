import { execSync } from 'node:child_process'
import type { Browser, Page } from '@playwright/test'
import { expect, test } from '../helpers/test'
import { signInSite, signedInAs, signedInPage, submit } from '../helpers/signIn'

// The stub Authentik asks mia for a second factor; its app's code is always this one.
const MIA = 'mia@example.org'
const MIA_PASSWORD = 'birch harbor violet quill'
const APP_CODE = '424242'
const RECOVERY = ['mia-amber', 'mia-basil', 'mia-cedar', 'mia-dune', 'mia-elm', 'mia-fern']
const ROOT = 'root@example.org'
const ROOT_PASSWORD = 'copper willow tandem fjord'

let site = ''

async function fresh(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  return context.newPage()
}

async function answer(page: Page, code: string) {
  await page.getByTestId('second-factor-code').fill(code)
  const answered = page.waitForResponse((r) => r.url().endsWith('/api/sign-in/step'))
  await page.getByTestId('second-factor-submit').click()
  return answered
}

test.describe.serial('Scenario: a second factor at sign-in', () => {
  test.beforeEach(async () => {
    site = await signInSite()
  })

  test('the first sign-in sets up an app and stores recovery codes before DeepLabel opens', async ({ browser }) => {
    const page = await fresh(browser)
    await page.goto(`${site}/sign-in`)
    await submit(page, MIA, MIA_PASSWORD)

    const step = page.getByTestId('second-factor-step')
    await expect(step).toHaveAttribute('data-kind', 'enrol')
    await expect(page.getByTestId('second-factor-qr')).toHaveAttribute('src', /^data:image\/svg\+xml/)
    await expect(page.getByTestId('second-factor-secret')).toHaveText('JBSW Y3DP EHPK 3PXP')
    expect(await signedInAs(page)).toBeNull()

    await answer(page, '000000')
    await expect(page.getByTestId('account-error'))
      .toHaveText('That code did not work. Check the time on your phone, wait for the next code and try again.')
    await expect(step).toHaveAttribute('data-kind', 'enrol')

    await answer(page, APP_CODE)
    await expect(step).toHaveAttribute('data-kind', 'recovery')
    await expect(page.getByTestId('second-factor-codes').getByRole('listitem')).toHaveText(RECOVERY)
    await expect(page.getByTestId('second-factor-submit')).toBeDisabled()
    expect(await signedInAs(page)).toBeNull()

    await page.getByTestId('second-factor-stored').check()
    await page.getByTestId('second-factor-submit').click()
    await expect(page).toHaveURL(`${site}/`)
    await expect.poll(() => signedInAs(page)).toBe(MIA)
  })

  test('every sign-in after asks for a code, and a recovery code serves once', async ({ browser }) => {
    const page = await fresh(browser)
    await page.goto(`${site}/sign-in`)
    await submit(page, MIA, MIA_PASSWORD)
    const step = page.getByTestId('second-factor-step')
    await expect(step).toHaveAttribute('data-kind', 'code')

    await page.getByTestId('second-factor-use-recovery').click()
    await expect(page.getByText('Type one of the recovery codes you stored. Each one works once.')).toBeVisible()
    await answer(page, RECOVERY[0])
    await expect(page).toHaveURL(`${site}/`)
    await expect.poll(() => signedInAs(page)).toBe(MIA)

    const again = await fresh(browser)
    await again.goto(`${site}/sign-in`)
    await submit(again, MIA, MIA_PASSWORD)
    await again.getByTestId('second-factor-use-recovery').click()
    await answer(again, RECOVERY[0])
    await expect(again.getByTestId('account-error')).toHaveText(/^That code did not work\./)
    expect(await signedInAs(again)).toBeNull()
    await answer(again, APP_CODE)
    await expect.poll(() => signedInAs(again)).toBe(MIA)
  })

  test("an admin takes a lost phone's factor away, and the next sign-in sets one up again", async ({ browser }) => {
    const admin = await signedInPage(browser, ROOT, ROOT_PASSWORD)
    await admin.goto(`${site}/admin`)
    // Her first sign-in made her account, which waits for an admin like any other.
    const waiting = admin.locator(`[data-testid="pending-user"][data-user="${MIA}"]`)
    await waiting.getByTestId('pending-role').selectOption('annotator')
    await waiting.getByTestId('approve').click()
    await expect(waiting).toHaveCount(0)
    await admin.getByRole('button', { name: `Show details for ${MIA}` }).click()
    admin.once('dialog', (dialog) => void dialog.accept())
    const reset = admin.waitForResponse((r) => r.url().endsWith('/second-factor') && r.request().method() === 'DELETE')
    await admin.getByTestId('reset-second-factor').click()
    expect(await (await reset).json()).toEqual({ removed: 2 })
    await expect(admin.getByText('second factor reset: 2 devices removed, a new one is set up at the next sign-in'))
      .toBeVisible()

    const page = await fresh(browser)
    await page.goto(`${site}/sign-in`)
    await submit(page, MIA, MIA_PASSWORD)
    await expect(page.getByTestId('second-factor-step')).toHaveAttribute('data-kind', 'enrol')
  })

  test('a step answered after its ten minutes says to start again, and signs nobody in', async ({ browser }) => {
    const page = await fresh(browser)
    await page.goto(`${site}/sign-in`)
    await submit(page, MIA, MIA_PASSWORD)
    await expect(page.getByTestId('second-factor-step')).toBeVisible()
    const script = 'from app import config, store; conn = store.connect(config.DB_PATH); '
      + `conn.execute(\\"UPDATE pending_sign_ins SET created_at = datetime('now', '-11 minutes')\\"); conn.commit()`
    execSync(`docker compose -f ../compose.e2e.yml exec -T auth-oidc python -c "${script}"`)

    await answer(page, APP_CODE)
    await expect(page.getByTestId('second-factor-ended'))
      .toContainText('Signing in took too long or was finished elsewhere - start again.')
    expect(await signedInAs(page)).toBeNull()
    await page.getByTestId('second-factor-restart').click()
    await expect(page.getByTestId('sign-in-form')).toBeVisible()
  })
})
