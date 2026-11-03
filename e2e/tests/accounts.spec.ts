import type { Browser, Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import { me, signInSite, signedInAs, signedInPage, submit } from '../helpers/signIn'

let site = ''
const ROOT = 'root@example.org'
const ROOT_PASSWORD = 'root-password'

/** An email nobody in this run has used yet. */
const freshEmail = (who: string) => `${who}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.org`

async function fresh(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  return context.newPage()
}

async function signUp(page: Page, email: string, password = 'a-good-password') {
  await page.goto(`${site}/sign-up`)
  await page.getByTestId('sign-up-name').fill('Mia Example')
  await page.getByTestId('sign-up-email').fill(email)
  await page.getByTestId('new-password').fill(password)
  await page.getByTestId('new-password-repeat').fill(password)
  await page.getByTestId('sign-up-submit').click()
  await expect(page.getByTestId('pending-approval')).toBeVisible()
}

/** Invite someone through the API as the admin and set their password through the link,
 *  as the person would: the setup for the scenarios about passwords. */
async function invited(admin: Page, browser: Browser, role = 'member', password = 'first-password') {
  const email = freshEmail('julia')
  const invitation = await admin.request.post(`${site}/api/users/invitations`, { data: { email, role } })
  expect(invitation.ok()).toBe(true)
  const token = new URL(`${site}${(await invitation.json()).link}`).searchParams.get('token')
  const person = await fresh(browser)
  const set = await person.request.post(`${site}/api/set-password`, { data: { token, password } })
  expect(set.ok()).toBe(true)
  // Setting it signs them in; that session is the setup's, not one the scenario counts.
  await person.request.post(`${site}/api/logout`)
  await person.context().close()
  return email
}

async function pendingCount(admin: Page): Promise<number> {
  return (await (await admin.request.get(`${site}/api/users/pending`)).json()).count
}

test.describe('Scenario: accounts on DeepLabel\'s own pages', () => {
  test.use({ storageState: { cookies: [], origins: [] } })
  test.beforeEach(async () => {
    site = await signInSite()
  })

  test('someone signs up, waits, and an admin lets them in with the role they pick', async ({ page, browser }) => {
    const email = freshEmail('mia')
    await page.goto(`${site}/sign-in`)
    await page.getByTestId('sign-up-link').click()
    await expect(page).toHaveURL(`${site}/sign-up`)
    await page.getByTestId('new-password').fill('a-good-password')
    await page.getByTestId('new-password-repeat').fill('a-good-passwort')
    await expect(page.getByTestId('account-error')).toHaveText('The two passwords differ.')
    await expect(page.getByTestId('sign-up-submit')).toBeDisabled()

    await signUp(page, email)
    await expect(page.getByTestId('pending-email')).toHaveText(email)
    expect(await me(page)).toMatchObject({ user: email, pending: true })

    const admin = await signedInPage(browser, ROOT, ROOT_PASSWORD)
    await admin.goto(`${site}/admin`)
    const waiting = await pendingCount(admin)
    expect(waiting).toBeGreaterThan(0)
    await expect(admin.getByTestId('admin-pending')).toHaveText(String(waiting))
    const row = admin.locator(`[data-testid="pending-user"][data-user="${email}"]`)
    await row.getByTestId('pending-role').selectOption('member')
    await row.getByTestId('approve').click()
    await expect(row).toHaveCount(0)
    await expect.poll(() => me(page)).toMatchObject({ user: email, pending: false, role: 'member' })
    expect(await pendingCount(admin)).toBe(waiting - 1)

    await page.reload()
    await expect(page.getByTestId('user-menu')).toBeVisible()
    await expect(page.getByTestId('pending-approval')).toHaveCount(0)
  })

  test('a rejected sign-up is signed out and cannot sign in again', async ({ page, browser }) => {
    const email = freshEmail('rex')
    await signUp(page, email)
    const admin = await signedInPage(browser, ROOT, ROOT_PASSWORD)
    await admin.goto(`${site}/admin`)

    await admin.locator(`[data-testid="pending-user"][data-user="${email}"]`).getByTestId('reject').click()

    await expect.poll(() => signedInAs(page)).toBeNull()
    await page.goto(`${site}/sign-in`)
    expect(await submit(page, email, 'a-good-password')).toBe(400)
    await expect(page.getByTestId('account-error')).toHaveText('Wrong email or password.')
  })

  test('an invitation link sets a password, lets the person in with the invited role, and works once',
       async ({ page, browser }) => {
    const email = freshEmail('julia')
    const admin = await signedInPage(browser, ROOT, ROOT_PASSWORD)
    await admin.goto(`${site}/admin`)
    const invite = admin.getByTestId('invite-person')
    await invite.getByRole('textbox', { name: 'Email' }).fill(email)
    await invite.getByTestId('invite-role').selectOption('member')
    await invite.getByRole('button', { name: 'Create link' }).click()
    const url = await admin.getByTestId('password-link-url').textContent()
    expect(url).toMatch(new RegExp(`^${site}/set-password\\?token=`))

    await page.goto(url!)
    await expect(page.getByTestId('set-password-email')).toHaveText(email)
    await page.getByTestId('new-password').fill('short')
    await page.getByTestId('new-password-repeat').fill('short')
    await page.getByTestId('set-password-submit').click()
    await expect(page.getByTestId('account-error')).toHaveText('Password needs to be 8 characters or longer.')
    expect(await signedInAs(page)).toBeNull()
    await page.getByTestId('new-password').fill('julias-password')
    await page.getByTestId('new-password-repeat').fill('julias-password')
    await page.getByTestId('set-password-submit').click()

    await expect(page).toHaveURL(`${site}/`)
    await expect.poll(() => me(page)).toMatchObject({ user: email, role: 'member', pending: false })

    const again = await fresh(browser)
    await again.goto(url!)
    await expect(again.getByTestId('set-password-dead-reason'))
      .toHaveText('This link has expired or was already used. Ask an admin for a new one.')
  })

  test('an admin\'s reset link replaces the password and signs the person out everywhere', async ({ browser }) => {
    const admin = await signedInPage(browser, ROOT, ROOT_PASSWORD)
    const email = await invited(admin, browser)
    const person = await signedInPage(browser, email, 'first-password')

    await admin.goto(`${site}/admin`)
    await admin.getByRole('button', { name: `Show details for ${email}` }).click()
    await admin.getByTestId('reset-password').click()
    const url = await admin.getByTestId('password-link-url').textContent()
    const opened = await fresh(browser)
    await opened.goto(url!)
    await opened.getByTestId('new-password').fill('second-password')
    await opened.getByTestId('new-password-repeat').fill('second-password')
    await opened.getByTestId('set-password-submit').click()

    await expect.poll(() => signedInAs(opened)).toBe(email)
    expect(await signedInAs(person)).toBeNull()
    const check = await fresh(browser)
    await check.goto(`${site}/sign-in`)
    expect(await submit(check, email, 'first-password')).toBe(400)
    expect(await submit(check, email, 'second-password')).toBe(200)
  })

  test('changing your own password keeps this browser and signs the others out', async ({ browser }) => {
    const admin = await signedInPage(browser, ROOT, ROOT_PASSWORD)
    const email = await invited(admin, browser)
    const here = await signedInPage(browser, email, 'first-password')
    const elsewhere = await signedInPage(browser, email, 'first-password')

    await here.goto(`${site}/people/${encodeURIComponent(email)}?section=password`)
    await here.getByTestId('new-password').fill('second-password')
    await here.getByTestId('new-password-repeat').fill('second-password')
    await here.getByTestId('change-password-save').click()

    await expect(here.getByTestId('change-password-done'))
      .toHaveText('Password changed. One other browser was signed out.')
    expect(await signedInAs(here)).toBe(email)
    expect(await signedInAs(elsewhere)).toBeNull()
    const check = await fresh(browser)
    await check.goto(`${site}/sign-in`)
    expect(await submit(check, email, 'first-password')).toBe(400)
    expect(await submit(check, email, 'second-password')).toBe(200)
  })
})
