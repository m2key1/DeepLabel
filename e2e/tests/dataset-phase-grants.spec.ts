import type { Browser } from '@playwright/test'
import { test, expect } from '../helpers/test'
import { backendFetch, createJob, getJob, identity, shareJob, uniqueName, waitForJobStatus } from '../helpers/api'
import { scanPng } from '../helpers/image'
import { createDataset, wizardStep } from '../helpers/new-dataset'
import { seedSession, useSession, type SeededRole } from '../helpers/session'

async function signedIn(browser: Browser, role: SeededRole, prefix: string) {
  const username = `${prefix}-${Date.now()}`
  const session = seedSession(role, username)
  const context = await browser.newContext()
  await useSession(context, session)
  return { username, session, context, page: await context.newPage() }
}

async function pageStems(jobId: string): Promise<string[]> {
  const pages = (await getJob(jobId)).pages as { idx: number; filename: string }[]
  return [...pages].sort((a, b) => a.idx - b.idx).map((p) => p.filename.replace(/\.[^.]+$/, ''))
}

test.describe('Scenario: a dataset\'s owner adds pages to it', () => {
  test('the owner gets Add pages without the admin-only server path, and the pages arrive',
    async ({ page, browser }) => {
      const member = await signedIn(browser, 'manager', 'appender')
      const name = uniqueName('Owner appends')
      const jobId = await createJob(name, 1, undefined, identity(member.username, 'manager'))
      await waitForJobStatus(jobId, 'done')

      await page.goto(`/jobs/${jobId}`)
      await expect(page.getByTestId('add-pages')).toContainText('from server path')

      await member.page.goto(`/jobs/${jobId}`)
      const addPages = member.page.getByTestId('add-pages')
      await expect(addPages).toBeEnabled()
      await expect(addPages).toContainText('Add pages')
      await expect(addPages).not.toContainText('from server path')

      await member.page.locator('input[type="file"]').setInputFiles([
        { name: 'scan_2.png', mimeType: 'image/png', buffer: scanPng() },
      ])
      await expect.poll(() => pageStems(jobId)).toEqual(['scan_1', 'scan_2'])
      await waitForJobStatus(jobId, 'done')
      await member.context.close()
    })
})

test.describe('Scenario: an Annotator adds pages and makes datasets (#131)', () => {
  test('they add pages to a dataset they were given, and make one of their own with every phase on offer',
    async ({ browser }) => {
      const annotator = await signedIn(browser, 'annotator', 'adds')
      const given = uniqueName('Given to an annotator')
      const givenId = await createJob(given, 1)
      await waitForJobStatus(givenId, 'done')
      await shareJob(givenId, [annotator.username])

      await annotator.page.goto(`/jobs/${givenId}`)
      const addPages = annotator.page.getByTestId('add-pages')
      await expect(addPages).toBeEnabled()
      await expect(addPages).toContainText('Add pages')
      await annotator.page.locator('input[type="file"]').setInputFiles([
        { name: 'scan_2.png', mimeType: 'image/png', buffer: scanPng() },
      ])
      await expect.poll(() => pageStems(givenId)).toEqual(['scan_1', 'scan_2'])
      await waitForJobStatus(givenId, 'done')

      const name = uniqueName('Made by an annotator')
      await annotator.page.goto('/new')
      await annotator.page.getByLabel('Job name').fill(name)
      await annotator.page.locator('input[type="file"]').setInputFiles([
        { name: 'folio_1.png', mimeType: 'image/png', buffer: scanPng() },
      ])
      await wizardStep(annotator.page, 'run')
      const ocr = annotator.page.getByRole('checkbox', { name: /^OCR/ })
      await expect(ocr).toBeEnabled()
      await expect(ocr).toBeChecked()

      await createDataset(annotator.page)
      await expect(annotator.page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
      const jobId = annotator.page.url().split('/').pop()!
      const job = await getJob(jobId)
      expect([job.name, job.owner, job.run_lines, job.run_ocr]).toEqual([name, annotator.username, true, true])
      // Whoever made a dataset manages it, whatever their role.
      expect((await backendFetch(`/api/jobs/${jobId}?pages=false`, { headers: identity(annotator.username, 'annotator') })).my_role)
        .toBe('manager')
      await annotator.context.close()
    })
})
