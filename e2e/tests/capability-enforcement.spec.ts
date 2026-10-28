import type { BrowserContext } from '@playwright/test'
import { test, expect } from '../helpers/test'
import {
  createJob, getJob, getReocrPreview, greedyLines, identity, jobPageIds, listJobs, markLinesChecked,
  patchJob, seedCompletedJob, shareJob, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { asSession, seedSession, useSession, userRecord } from '../helpers/session'
import { datasetAction, openDatasetMenu } from '../helpers/dataset'
import { accountControls } from '../helpers/admin'

async function signInAs(context: BrowserContext, role: 'member' | 'admin', username: string) {
  const session = seedSession(role, username)
  await useSession(context, session)
  return session
}

test.describe('Scenario: a capability the admin page offers is one the backend enforces', () => {
  test('a member cannot delete even their own dataset until they are given the capability',
    async ({ page, browser }) => {
      const username = `deleter-${Date.now()}`
      const memberSession = seedSession('member', username)
      const name = uniqueName('Own dataset')
      const jobId = await createJob(name, 1, undefined, identity(username, 'member'))
      await waitForJobStatus(jobId, 'done')

      // The member role does not carry dataset.delete - the auth service says so itself.
      await expect.poll(async () => (await userRecord(page, username)).capabilities)
        .toEqual(['pipeline.layout', 'pipeline.lines', 'pipeline.ocr', 'train.local'])

      // The list offers the member the menu of their own dataset, but not a Delete in it.
      const memberContext = await browser.newContext()
      const memberPage = await memberContext.newPage()
      await useSession(memberContext, memberSession)
      await memberPage.goto('/')
      const row = memberPage.getByTestId('job-card').filter({ hasText: name })
      await row.getByTestId('job-menu').click()
      await expect(memberPage.getByRole('button', { name: 'Rename', exact: true })).toBeVisible()
      await expect(memberPage.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0)

      // And asking anyway is refused, and the dataset is still there.
      const refused = await asSession(memberSession, `/api/jobs/${jobId}`, { method: 'DELETE' })
      expect(refused.status).toBe(403)
      expect((await getJob(jobId)).name).toBe(name)

      // Granted from the permission matrix, the same request goes through.
      await page.goto('/admin')
      const matrixRow = page.getByTestId('user-row').filter({ has: page.getByText(username) })
      const cell = matrixRow.locator('[data-testid="permission-cell"][data-cap="dataset.delete"]')
      await expect(cell).not.toBeChecked()
      await cell.click()
      await expect(cell).toBeChecked()
      await expect.poll(async () => (await userRecord(page, username)).permissions)
        .toEqual({ 'dataset.delete': true })

      await memberPage.reload()
      await memberPage.getByTestId('job-card').filter({ hasText: name }).getByTestId('job-menu').click()
      await expect(memberPage.getByRole('button', { name: 'Delete', exact: true })).toBeVisible()

      const allowed = await asSession(memberSession, `/api/jobs/${jobId}`, { method: 'DELETE' })
      expect(allowed.status).toBe(200)
      expect((await listJobs()).some((j) => j.id === jobId)).toBe(false)
      await memberContext.close()
    })

  test('taking "Train locally" away in the matrix stops that person training locally',
    async ({ page }) => {
      const username = `trainer-${Date.now()}`
      const memberSession = seedSession('member', username)
      const targets = async () => (await (await asSession(memberSession, '/api/trainings')).json()).targets
      await expect.poll(targets).toEqual({ local: true, slurm: false })

      await page.goto('/admin')
      const matrixRow = page.getByTestId('user-row').filter({ has: page.getByText(username) })
      const cell = matrixRow.locator('[data-testid="permission-cell"][data-cap="train.local"]')
      await expect(cell).toBeChecked()
      await cell.click()
      await expect(cell).not.toBeChecked()
      await expect.poll(async () => (await userRecord(page, username)).capabilities)
        .toEqual(['pipeline.layout', 'pipeline.lines', 'pipeline.ocr'])

      // The backend is the oracle: what the auth service now says must be what it enforces.
      await expect.poll(targets).toEqual({ local: false, slurm: false })

      // The Training column on the same person's row says the same as the matrix.
      await page.reload()
      const userRow = page.getByTestId('user-row').filter({ hasText: username })
      await expect(userRow.locator('[data-testid="permission-cell"][data-cap="train.local"]')).not.toBeChecked()
    })

  test('a phase run on one page is refused to someone the phase was taken from',
    async ({ page }) => {
      const username = `pagerun-${Date.now()}`
      const memberSession = seedSession('member', username)
      const jobId = await createJob(uniqueName('Page run'), 1, undefined, identity(username, 'member'))
      await waitForJobStatus(jobId, 'done')
      const [pageId] = await jobPageIds(jobId)

      await page.goto('/admin')
      const matrixRow = page.getByTestId('user-row').filter({ has: page.getByText(username) })
      await matrixRow.locator('[data-testid="permission-cell"][data-cap="pipeline.layout"]').click()
      await expect.poll(async () => (await userRecord(page, username)).permissions)
        .toEqual({ 'pipeline.layout': false })

      const runOnPage = (phase: string) => asSession(memberSession, `/api/pages/${pageId}/run`, {
        method: 'POST', body: JSON.stringify({ phase }),
      }).then((r) => r.status)

      // The same refusal the whole-dataset re-run gives.
      const wholeDataset = await asSession(memberSession, `/api/jobs/${jobId}/rerun`, {
        method: 'POST', body: JSON.stringify({ from_phase: 'layout' }),
      })
      expect(wholeDataset.status).toBe(403)
      expect(await runOnPage('layout')).toBe(403)
      expect((await getJob(jobId)).status).toBe('done')

      // A phase they still hold goes through on the same page, so the 403 above is the
      // capability and not the page being out of reach.
      expect(await runOnPage('ocr')).toBe(200)
      await waitForJobStatus(jobId, 'done')
    })

  // README: "A viewer may not write at all, so the grid takes no exceptions for one: their
  // row is greyed with a note to promote the account to member first, and the auth service
  // refuses such a grant in as many words."
  test('a viewer\'s row in the matrix takes no grant until the account is promoted, and the history says what was granted',
    async ({ page }) => {
      const username = `reader-${Date.now()}`
      seedSession('viewer', username)
      await expect.poll(async () => (await userRecord(page, username)).capabilities).toEqual([])

      await page.goto('/admin')
      const matrixRow = page.getByTestId('user-row').filter({ has: page.getByText(username) })
      const cell = matrixRow.locator('[data-testid="permission-cell"][data-cap="dataset.delete"]')
      await expect(matrixRow).toHaveAttribute('data-viewer', 'true')
      await expect(matrixRow.getByTestId('promote-first')).toHaveText('promote to member to grant anything')
      await expect(cell).toBeDisabled()
      await expect(cell).toHaveAttribute('title',
        `${username} is a viewer and may not write at all - promote the account to member first`)
      await expect(cell).not.toBeChecked()

      // The page is not the only gate: the same grant asked of the API is refused, in words.
      const record = await userRecord(page, username)
      expect(record.role).toBe('viewer')
      const refused = await page.request.patch(`/api/users/${record.id}`,
        { data: { permissions: { 'dataset.delete': true } } })
      expect(refused.status()).toBe(409)
      expect((await refused.json()).detail).toBe(
        `${username} is a viewer, and a viewer may not write at all - promote the account to member before granting it anything`)
      expect((await userRecord(page, username)).capabilities).toEqual([])

      // Promoted, the same row takes the grant, and the history reads it as a sentence.
      await (await accountControls(page, username)).getByTestId('role-select').selectOption('member')
      await expect.poll(async () => (await userRecord(page, username)).role).toBe('member')
      await expect(matrixRow).not.toHaveAttribute('data-viewer')
      await expect(matrixRow.getByTestId('promote-first')).toHaveCount(0)
      await expect(cell).toBeEnabled()
      await cell.click()
      await expect(cell).toBeChecked()
      await expect.poll(async () => (await userRecord(page, username)).permissions)
        .toEqual({ 'dataset.delete': true })
      const audit = page.getByTestId('user-detail').getByTestId('user-audit').getByRole('listitem')
      await expect(audit).toHaveCount(2)
      await expect(audit.nth(0)).toHaveText(new RegExp(`^granted "Delete" to ${username}by dev`))
      await expect(audit.nth(1)).toHaveText(/^role: viewer → member/)
    })
})

test.describe('Scenario: a member re-runs a dataset', () => {
  test('the careful re-read of their own dataset needs no permission to discard, and re-reads the unchecked lines',
    async ({ page }) => {
      const username = `rerunner-${Date.now()}`
      await signInAs(page.context(), 'member', username)
      const jobId = await createJob(uniqueName('Member re-run'), 1, undefined, identity(username, 'member'))
      await waitForJobStatus(jobId, 'done')
      // Decoding greedily from here on, so the lines this re-run reads are tellable apart
      // from the ones the original beam run wrote.
      await patchJob(jobId, { ocr_decode: 'greedy' })
      await markLinesChecked(jobId, 1)

      await page.goto(`/jobs/${jobId}`)
      await datasetAction(page, 'rerun-open')
      await page.locator('[data-testid="rerun-phase"][data-phase="ocr"]').check()
      // The careful answer is the default: checked lines are left as they are.
      await expect(page.locator('[data-testid="rerun-choice"][data-keep="true"]')).toBeChecked()
      const answer = page.waitForResponse((r) => r.url().endsWith(`/api/jobs/${jobId}/rerun`))
      await page.getByTestId('rerun-confirm').click()
      expect((await answer).status()).toBe(200)

      // Backend oracle: the stub cuts six lines on a page; the five nobody checked were
      // read again, greedily, and the checked one was left as it was.
      await expect.poll(async () => greedyLines(jobId)).toBe(5)
      await waitForJobStatus(jobId, 'done')
      expect((await getReocrPreview(jobId)).checked).toBe(1)
    })

  test('a dataset they were given is its owner\'s to re-run', async ({ page }) => {
    const username = `given-${Date.now()}`
    const session = await signInAs(page.context(), 'member', username)
    const name = uniqueName('Given re-run')
    const jobId = await seedCompletedJob(name, 1)
    await shareJob(jobId, [username])

    await page.goto(`/jobs/${jobId}`)
    // The dataset is open to them, but the re-run is not offered.
    await expect(page.getByRole('heading', { name })).toBeVisible()
    const run = await openDatasetMenu(page, 'dataset-run')
    await expect(run.getByTestId('llm-read-open')).toBeVisible()
    await expect(run.getByTestId('rerun-open')).toHaveCount(0)

    const refused = await asSession(session, `/api/jobs/${jobId}/rerun`, {
      method: 'POST', body: JSON.stringify({ from_phase: 'ocr' }),
    })
    expect(refused.status).toBe(403)
    expect((await refused.json()).detail).toBe(`only the owner or an admin may re-run ${name}`)
    const group = await asSession(session, '/api/bulk/rerun', {
      method: 'POST', body: JSON.stringify({ job_ids: [jobId], from_phase: 'ocr' }),
    })
    expect(group.status).toBe(403)
    // Backend oracle: nothing was queued, and every line still has its text.
    expect((await getJob(jobId)).status).toBe('done')
    expect((await getReocrPreview(jobId)).unchecked).toBe(6)
  })
})
