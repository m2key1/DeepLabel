import { test, expect } from '../helpers/test'
import {
  BACKEND, jobPageIds, listJobs, pageLines, seedCompletedJob, shareJob, uniqueName,
} from '../helpers/api'
import { accountControls } from '../helpers/admin'
import { seedSession, useSession, userRecord } from '../helpers/session'
import { LANDSCAPE, openViewer } from '../helpers/viewer'

const asPerson = (username: string, role: string) =>
  ({ 'X-Frontend-Secret': 'e2e-secret', 'X-Auth-User': username, 'X-Auth-Role': role, 'Content-Type': 'application/json' })

const lineRow = (page: import('@playwright/test').Page, text: string) =>
  page.getByTestId('line-row').filter({ hasText: text })

test.describe('Scenario: what each role may do with a dataset someone else created (#131)', () => {
  test('an Annotator corrects and adds pages, but runs nothing and checks nothing', async ({ page }) => {
    const name = uniqueName('Annotated')
    const jobId = await seedCompletedJob(name, 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    const annotator = `annotator-${Date.now()}`
    await shareJob(jobId, [annotator])

    // As the admin who created it, the dataset offers its Run menu: the locator is sound.
    await page.goto(`/jobs/${jobId}`)
    await expect(page.getByTestId('dataset-run')).toBeVisible()
    await expect(page.getByTestId('job-complete')).toBeVisible()

    await useSession(page.context(), seedSession('annotator', annotator))
    await page.goto(`/jobs/${jobId}`)
    await expect(page.getByRole('button', { name: 'Add pages' })).toBeVisible()
    await expect(page.getByTestId('dataset-run')).toHaveCount(0)
    // Marking the dataset complete is a Reviewer's, and it is not complete, so nothing shows.
    await expect(page.getByTestId('job-complete')).toHaveCount(0)

    await openViewer(page, jobId, pageId)
    const box = lineRow(page, 'Sample Header line 1').getByRole('checkbox')
    await expect(box).toBeDisabled()
    await expect(box).toHaveAttribute('title', 'Waiting for a Reviewer to check it')

    const refused = await fetch(`${BACKEND}/api/lines/${(await pageLines(jobId, pageId))[0].id}`, {
      method: 'PATCH', headers: asPerson(annotator, 'annotator'), body: JSON.stringify({ checked: true }),
    })
    expect(refused.status).toBe(403)
    expect((await pageLines(jobId, pageId)).filter((l) => l.checked)).toHaveLength(0)
  })

  test('a Reviewer checks a line in the page viewer', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Reviewed'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    const reviewer = `reviewer-${Date.now()}`
    await shareJob(jobId, [reviewer])
    await useSession(page.context(), seedSession('reviewer', reviewer))

    await openViewer(page, jobId, pageId)
    await lineRow(page, 'Sample Header line 2').getByTitle('Checked').click()
    await expect.poll(async () =>
      (await pageLines(jobId, pageId)).filter((l) => l.checked).map((l) => l.text),
    ).toEqual(['Sample Header line 2'])
  })

  test('a Manager deletes a dataset someone else created, without any granted capability', async ({ page }) => {
    const name = uniqueName('Managed')
    const jobId = await seedCompletedJob(name, 1, LANDSCAPE)
    const manager = `manager-${Date.now()}`
    await shareJob(jobId, [manager])
    await useSession(page.context(), seedSession('manager', manager))

    await page.goto('/')
    const card = page.getByTestId('job-card').filter({ hasText: name })
    await card.getByTestId('job-menu').click()
    page.once('dialog', (dialog) => dialog.accept())
    await card.getByRole('button', { name: 'Delete' }).click()
    await expect.poll(async () => (await listJobs()).some((j: { id: string }) => j.id === jobId)).toBe(false)
    await expect(page.getByTestId('job-card').filter({ hasText: name })).toHaveCount(0)
  })

  test('the Admin page offers the five roles and says what each may do', async ({ page }) => {
    const username = `role-${Date.now()}`
    seedSession('annotator', username)

    await page.goto('/admin')
    const role = (await accountControls(page, username)).getByTestId('role-select')
    await expect(role).toHaveValue('annotator')
    await expect(role.locator('option')).toHaveText(['Admin', 'Manager', 'Reviewer', 'Annotator', 'Viewer'])
    await role.selectOption('reviewer')
    await expect((await accountControls(page, username)).getByTestId('role-description'))
      .toHaveText('An Annotator who also marks lines and pages checked')
    await expect.poll(async () => (await userRecord(page, username)).role).toBe('reviewer')
    await expect(page.getByTestId('role-row').filter({ hasText: 'Reviewers' })).toContainText('An Annotator who also marks lines and pages checked')
  })
})
