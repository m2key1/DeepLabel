import { test, expect } from '../helpers/test'
import {
  backendFetch, createJob, getPageDetail, identity, jobPageIds, markLinesChecked, seedCompletedJob, shareJob,
  uniqueName, waitForJobStatus,
} from '../helpers/api'
import { seedSession, seedStaleUser } from '../helpers/session'
import { FRONTEND } from '../helpers/frontend'


async function editOneLineAs(jobId: string, username: string) {
  const [pageId] = await jobPageIds(jobId)
  const detail = await getPageDetail(jobId, pageId)
  const line = detail.elements.flatMap((e: { lines: { id: number }[] }) => e.lines)[0]
  await backendFetch(`/api/lines/${line.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...identity(username, 'member') },
    body: JSON.stringify({ checked: true }),
  })
}

test.describe('Scenario: what each person may ask for', () => {
  test('a capability taken from one person is refused for them and nobody else',
    async ({ page }) => {
      const username = `caps-${Date.now()}`
      const session = seedSession('member', username)
      const adminSession = seedSession('admin', `admin-${Date.now()}`)
      // Their own dataset, so the capability is the only thing that can refuse the re-run.
      const jobId = await createJob(uniqueName('Caps'), 1, undefined, identity(username, 'member'))
      await waitForJobStatus(jobId, 'done')

      const reread = () => fetch(`${FRONTEND}/api/jobs/${jobId}/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: `sid=${session}` },
        body: JSON.stringify({ from_phase: 'ocr' }),
      }).then((r) => r.status)
      const capsOf = async () => {
        const res = await fetch(`${FRONTEND}/api/users`, { headers: { cookie: `sid=${adminSession}` } })
        const users = (await res.json()).users as
          { username: string; capabilities: string[]; permissions: Record<string, boolean> }[]
        return users.find((u) => u.username === username)!
      }

      await page.goto('/admin')
      // Both training columns say training, and where.
      const heading = (cap: string) => page.locator(`[data-testid="permission-heading"][data-cap="${cap}"]`)
      await expect(heading('train.local')).toHaveText('Train locally')
      await expect(heading('train.cluster')).toHaveText('Train cluster')
      const row = page.getByTestId('permission-row').filter({ has: page.getByText(username) })
      const cell = row.locator('[data-testid="permission-cell"][data-cap="pipeline.ocr"]')
      // The member role allows it, and nothing has been said about this person.
      await expect(cell).toBeChecked()
      await expect(cell).not.toHaveAttribute('data-overridden', 'true')

      await cell.click()
      await expect(cell).not.toBeChecked()
      await expect(cell).toHaveAttribute('data-overridden', 'true')
      // Auth-service oracle: the exception is stored, and only the exception.
      await expect.poll(async () => (await capsOf()).permissions).toEqual({ 'pipeline.ocr': false })
      await expect.poll(async () => (await capsOf()).capabilities)
        .toEqual(['pipeline.layout', 'pipeline.lines', 'train.local'])

      // And the backend refuses them - which only happens if the set travelled there,
      // through nginx and /validate, rather than being a thing the admin page knows.
      await expect.poll(reread).toBe(403)

      // Given back, the same request goes through. Same locator, so a broken selector
      // cannot make the refusal above look like a pass.
      await cell.click()
      await expect(cell).toBeChecked()
      await expect(cell).not.toHaveAttribute('data-overridden', 'true')
      await expect.poll(async () => (await capsOf()).permissions).toEqual({})
      await expect.poll(reread).toBe(200)
    })

  test('an admin cannot take a capability off themselves', async ({ page }) => {
    await page.goto('/admin')
    const mine = page.getByTestId('permission-row').filter({ hasText: '(you)' })
    await expect(mine.locator('[data-testid="permission-cell"]').first()).toBeDisabled()
    // Every box on an admin's row is ticked and none of them can be moved.
    const boxes = mine.locator('[data-testid="permission-cell"]')
    expect(await boxes.count()).toBeGreaterThan(0)
    for (const box of await boxes.all()) await expect(box).toBeChecked()
  })
})

test.describe('Scenario: managing users', () => {
  test('an admin assigns roles, but not their own', async ({ page }) => {
    const username = `promote-${Date.now()}`
    seedSession('viewer', username)

    await page.goto('/admin')
    const row = page.getByTestId('user-row').filter({ hasText: username })
    await expect(row.locator('select')).toHaveValue('viewer')
    await row.locator('select').selectOption('member')
    await expect(row.locator('select')).toHaveValue('member')

    await page.reload()
    await expect(page.getByTestId('user-row').filter({ hasText: username }).locator('select')).toHaveValue('member')

    await expect(page.getByTestId('user-row').filter({ hasText: '(you)' }).locator('select')).toBeDisabled()
  })

  test('being here just now is what the dot means, your own row included', async ({ page }) => {
    const idle = `idle-${Date.now()}`
    seedStaleUser('member', idle, 7)

    await page.goto('/admin')
    const mine = page.getByTestId('user-row').filter({ hasText: '(you)' })
    const theirs = page.getByTestId('user-row').filter({ hasText: idle })
    await expect(theirs).toBeVisible()

    // Loading this page is itself a request, so the admin reading it is here by definition -
    // presence needed a second browser to say so, and never said it of you at all.
    await expect(mine.getByTestId('live-now')).toContainText('online')
    await expect(mine.getByTestId('last-login')).toHaveText('just now')
    // Paired against the row above: the same locator, absent for a week-old visit.
    await expect(theirs.getByTestId('live-now')).toHaveCount(0)
    await expect(theirs.getByTestId('last-login')).toHaveText('7 days ago')
  })

  test('details show what a person reaches and has done, and sign them out everywhere', async ({ page }) => {
    const username = `inspect-${Date.now()}`
    const token = seedSession('member', username)
    const jobName = uniqueName('Inspect')
    const jobId = await seedCompletedJob(jobName)
    await shareJob(jobId, [username])
    await editOneLineAs(jobId, username)

    await page.goto('/admin')
    const row = page.getByTestId('user-row').filter({ hasText: username })
    await expect(row.getByTestId('last-login')).toHaveText('just now')
    await row.getByRole('button', { name: `Show details for ${username}` }).click()

    const detail = page.getByTestId('user-detail')
    const access = detail.getByTestId('user-access')
    await expect(access).toContainText('Shared directly')
    await expect(access.getByRole('link', { name: jobName })).toHaveAttribute('href', `/jobs/${jobId}`)
    await expect(detail.getByTestId('activity-totals')).toHaveText('1 line')
    await expect(detail.getByTestId('user-activity').getByRole('link', { name: jobName })).toBeVisible()
    await expect(detail.getByTestId('session-count')).toHaveText('1')

    await detail.getByRole('button', { name: 'Sign out everywhere' }).click()
    await expect(detail.getByTestId('session-count')).toHaveText('0')
    await expect.poll(async () => {
      const res = await fetch(`${FRONTEND}/api/me`, { headers: { cookie: `sid=${token}` }, redirect: 'manual' })
      return res.status
    }).toBe(401)
    await expect(detail.getByTestId('user-audit')).toContainText('signed out of 1 session')

    await row.getByRole('button', { name: `Hide details for ${username}` }).click()
    await expect(detail).toHaveCount(0)
  })

  test('role changes are attributed in the account history', async ({ page }) => {
    const username = `history-${Date.now()}`
    seedSession('viewer', username)

    await page.goto('/admin')
    const row = page.getByTestId('user-row').filter({ hasText: username })
    await row.locator('select').selectOption('member')
    await expect(row.locator('select')).toHaveValue('member')
    // Controlled checkbox: it flips once the PATCH answers, so wait rather than check().
    await row.getByTestId('train-cluster').click()
    await expect(row.getByTestId('train-cluster')).toBeChecked()
    await row.getByRole('button', { name: `Show details for ${username}` }).click()

    const audit = page.getByTestId('user-detail').getByTestId('user-audit')
    await expect(audit.getByRole('listitem')).toHaveCount(2)
    await expect(audit.getByRole('listitem').nth(0)).toHaveText(new RegExp(`^granted "Train cluster" to ${username}`))
    await expect(audit.getByRole('listitem').nth(1)).toContainText('role: viewer → member')
    await expect(audit).toContainText('by dev')
  })
})

test.describe('Scenario: what an admin may and may not see', () => {
  test('Settings shows only your own tokens, the Admin page shows everyone\'s', async ({ page }) => {
    const username = `tokens-${Date.now()}`
    const session = seedSession('member', username)
    const theirToken = `their-${Date.now()}`
    const created = await fetch(`${FRONTEND}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `sid=${session}` },
      body: JSON.stringify({ name: theirToken }),
    })
    expect(created.status).toBe(200)
    const theirSecret = (await created.json()).token
    const asTheirToken = () =>
      fetch(`${FRONTEND}/api/jobs`, {
        headers: { Authorization: `Bearer ${theirSecret}` }, redirect: 'manual',
      }).then((r) => r.status)
    expect(await asTheirToken()).toBe(200)

    // Settings is personal: an admin's own page must not list somebody else's token.
    await page.goto('/settings?section=tokens')
    const mine = page.getByTestId('api-tokens').getByTestId('token-row')
    await expect(mine.filter({ hasText: theirToken })).toHaveCount(0)
    // Paired presence assertion, so a broken selector cannot pass the absence above.
    const ownName = `mine-${Date.now()}`
    await page.getByLabel('Token name').fill(ownName)
    await page.getByRole('button', { name: 'Create token' }).click()
    await expect(mine.filter({ hasText: ownName })).toHaveCount(1)
    await expect(mine.filter({ hasText: theirToken })).toHaveCount(0)

    // Revoking a leaked token is still possible - from Admin, where it belongs.
    await page.goto('/admin')
    const all = page.getByTestId('admin-tokens').getByTestId('admin-token-row')
    await expect(all.filter({ hasText: theirToken })).toContainText(username)
    await expect(all.filter({ hasText: ownName })).toHaveCount(1)

    page.once('dialog', (d) => d.accept())
    await all.filter({ hasText: theirToken }).getByRole('button', { name: 'Revoke' }).click()
    await expect(all.filter({ hasText: theirToken })).toHaveCount(0)
    // Backend-state oracle: the revoked token authenticates nothing any more.
    await expect.poll(asTheirToken).toBe(401)
  })

  test('the local GPU and the cluster are granted independently', async ({ page }) => {
    const username = `grants-${Date.now()}`
    const session = seedSession('member', username)
    const targets = async () => {
      const res = await fetch(`${FRONTEND}/api/trainings`, { headers: { cookie: `sid=${session}` } })
      return (await res.json()).targets
    }
    // A new member starts with the local card and nothing else.
    await expect.poll(targets).toEqual({ local: true, slurm: false })

    await page.goto('/admin')
    const row = page.getByTestId('user-row').filter({ hasText: username })
    // Controlled checkboxes: they flip once the PATCH answers, so click and wait.
    await row.getByTestId('train-local').click()
    await expect.poll(targets).toEqual({ local: false, slurm: false })

    await row.getByTestId('train-cluster').click()
    await expect.poll(targets).toEqual({ local: false, slurm: true })
    await expect(row.getByTestId('train-local')).not.toBeChecked()
    await expect(row.getByTestId('train-cluster')).toBeChecked()

    await page.reload()
    const reloaded = page.getByTestId('user-row').filter({ hasText: username })
    await expect(reloaded.getByTestId('train-local')).not.toBeChecked()
    await expect(reloaded.getByTestId('train-cluster')).toBeChecked()
  })

  test('the SLURM account an admin sets is charged to that person\'s runs', async ({ page }) => {
    const username = `account-${Date.now()}`
    const session = seedSession('member', username)
    const account = `p_e2e${Date.now()}`
    const adminSession = seedSession('admin', `admin-${Date.now()}`)
    const jobName = uniqueName('Charged')
    const jobId = await seedCompletedJob(jobName, 1)
    await shareJob(jobId, [username])
    await markLinesChecked(jobId, 1)

    await page.goto('/admin')
    const row = page.getByTestId('user-row').filter({ hasText: username })
    await row.getByTestId('slurm-account').fill(account)
    await row.getByTestId('slurm-account').press('Enter')
    // Backend-state oracle for the edit itself, before checking where the value travels.
    await expect.poll(async () => {
      const res = await fetch(`${FRONTEND}/api/users`, { headers: { cookie: `sid=${adminSession}` } })
      const users = (await res.json()).users as { username: string; slurm_account: string }[]
      return users.find((u) => u.username === username)?.slurm_account
    }).toBe(account)

    // Backend-state oracle: the account travels as a header through nginx and /validate,
    // so only a run this person actually creates proves it arrived.
    const trainingName = uniqueName('Charged run')
    const created = await fetch(`${FRONTEND}/api/trainings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `sid=${session}` },
      body: JSON.stringify({ task: 'ocr', name: trainingName, dataset_job_ids: [jobId], target: 'local' }),
    })
    expect(created.status).toBe(200)
    expect((await created.json()).slurm_account).toBe(account)

    await row.getByRole('button', { name: `Show details for ${username}` }).click()
    await expect(page.getByTestId('user-detail').getByTestId('user-audit'))
      .toContainText(`SLURM account: the cluster default → ${account}`)
  })
})
