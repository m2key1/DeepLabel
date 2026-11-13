import { test, expect } from '../helpers/test'
import { signIn, signInSite, signedInAs, submit } from '../helpers/signIn'

let site = ''

test.describe('Scenario: signing in on DeepLabel\'s own page', () => {
  test.use({ storageState: { cookies: [], origins: [] } })
  test.beforeEach(async () => {
    site = await signInSite()
  })

  test('a visitor without a session lands on the sign-in page and is brought back where they were headed',
       async ({ page }) => {
    await page.goto(`${site}/models`)
    await expect(page).toHaveURL(`${site}/sign-in?next=%2Fmodels`)
    await expect(page.getByTestId('sign-in-form')).toBeVisible()
    expect(await signedInAs(page)).toBeNull()

    await submit(page, 'root@example.org', 'copper willow tandem fjord')

    await expect(page).toHaveURL(`${site}/models`)
    await expect.poll(() => signedInAs(page)).toBe('root@example.org')
    await expect(page.getByTestId('user-menu')).toBeVisible()
  })

  test('a test signed in by the helper is already past the sign-in page, so its next step cannot race it',
       async ({ page }) => {
    // A busy browser: the page takes its time over the sign-in answer before moving on,
    // which is when a test's own navigation used to be overtaken by that move.
    await page.addInitScript(() => {
      const fetchNow = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        const answer = await fetchNow(input, init)
        if (String(input).endsWith('/api/sign-in')) await new Promise((r) => setTimeout(r, 1500))
        return answer
      }
    })

    await signIn(page, 'root@example.org', 'copper willow tandem fjord')

    expect(page.url()).toBe(`${site}/`)
    await page.goto(`${site}/admin`)
    await expect(page).toHaveURL(`${site}/admin`)
    await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible()
  })

  test('a wrong password says so, keeps the email, empties the password and signs nobody in',
       async ({ page }) => {
    await page.goto(`${site}/sign-in`)

    await submit(page, 'anna@example.org', 'not-the-password')

    await expect(page.getByTestId('account-error')).toHaveText('Wrong email or password.')
    await expect(page.getByTestId('sign-in-email')).toHaveValue('anna@example.org')
    await expect(page.getByTestId('sign-in-password')).toHaveValue('')
    await expect(page).toHaveURL(`${site}/sign-in`)
    expect(await signedInAs(page)).toBeNull()
  })

  test('after five wrong passwords the next try has to wait', async ({ page }) => {
    await page.goto(`${site}/sign-in`)
    const error = page.getByTestId('account-error')
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await submit(page, 'locked@example.org', `guess-${attempt}`)).toBe(400)
      await expect(error).toHaveText('Wrong email or password.')
    }

    expect(await submit(page, 'locked@example.org', 'guess-6')).toBe(429)
    await expect(error).toHaveText('Too many attempts - try again in 1 minute.')
    expect(await signedInAs(page)).toBeNull()
  })

  test('someone made in Authentik but never let in sees only the waiting page, and can log out from it',
       async ({ page }) => {
    await page.goto(`${site}/models`)
    await submit(page, 'anna@example.org', 'quartz lantern orbit meadow')

    await expect(page.getByTestId('pending-approval')).toBeVisible()
    await expect(page.getByTestId('pending-email')).toHaveText('anna@example.org')
    await expect(page.getByTestId('user-menu')).toHaveCount(0)
    const backend = await page.request.get(`${site}/api/jobs`, { maxRedirects: 0 })
    expect(backend.status()).toBe(403)

    await page.getByTestId('pending-log-out').click()
    await expect(page).toHaveURL(`${site}/sign-in`)
    expect(await signedInAs(page)).toBeNull()
  })

  test('log out ends the session and lands back on the sign-in page', async ({ page }) => {
    await page.goto(`${site}/`)
    await submit(page, 'root@example.org', 'copper willow tandem fjord')
    await expect.poll(() => signedInAs(page)).toBe('root@example.org')

    await page.getByTestId('user-menu').click()
    await page.getByRole('button', { name: 'Log out' }).click()

    await expect(page).toHaveURL(`${site}/sign-in`)
    await expect(page.getByTestId('sign-in-form')).toBeVisible()
    expect(await signedInAs(page)).toBeNull()
  })

  test('a username signs in as well as an email', async ({ page }) => {
    await page.goto(`${site}/sign-in`)

    expect(await submit(page, 'carla', 'hazel comet ladder brine')).toBe(200)

    await expect.poll(() => signedInAs(page)).toBe('carla')
  })
})
