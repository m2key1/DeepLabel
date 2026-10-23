import type { Browser } from '@playwright/test'
import { test, expect } from '../helpers/test'
import { createJob, getJob, identity, uniqueName, waitForJobStatus } from '../helpers/api'
import { scanPng } from '../helpers/image'
import { FRONTEND } from '../helpers/frontend'
import { seedSession, useSession, userRecord } from '../helpers/session'

async function signedInMember(browser: Browser, prefix: string) {
  const username = `${prefix}-${Date.now()}`
  const session = seedSession('member', username)
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
      const member = await signedInMember(browser, 'appender')
      const name = uniqueName('Owner appends')
      const jobId = await createJob(name, 1, undefined, identity(member.username, 'member'))
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

test.describe('Scenario: making a dataset asks for the phases it runs', () => {
  test('without the OCR grant, OCR is locked off on the form and adding pages is refused',
    async ({ page, browser }) => {
      const member = await signedInMember(browser, 'no-ocr')
      const own = uniqueName('Read before revoking')
      const ownId = await createJob(own, 1, undefined, identity(member.username, 'member'))
      await waitForJobStatus(ownId, 'done')

      const record = await userRecord(page, member.username)
      const revoked = await page.request.patch(`/api/users/${record.id}`, {
        data: { permissions: { 'pipeline.ocr': false } },
      })
      expect(revoked.status()).toBe(200)
      await expect.poll(async () => (await userRecord(page, member.username)).capabilities)
        .toEqual(['pipeline.layout', 'pipeline.lines', 'train.local'])

      await member.page.goto(`/jobs/${ownId}`)
      const addPages = member.page.getByTestId('add-pages')
      await expect(addPages).toBeDisabled()
      await expect(member.page.getByTestId('add-pages-locked'))
        .toHaveText('Adding pages runs OCR on them, which you have not been granted.')
      const form = new FormData()
      form.append('files', new Blob([new Uint8Array(scanPng())], { type: 'image/png' }), 'scan_2.png')
      const refused = await fetch(`${FRONTEND}/api/jobs/${ownId}/pages/upload`, {
        method: 'POST', body: form, redirect: 'manual', headers: { cookie: `sid=${member.session}` },
      })
      expect(refused.status).toBe(403)
      expect((await refused.json()).detail).toBe('not permitted: pipeline.ocr')
      expect(await pageStems(ownId)).toEqual(['scan_1'])

      const name = uniqueName('Made without OCR')
      await member.page.goto('/new')
      await member.page.getByLabel('Job name').fill(name)
      const ocr = member.page.getByRole('checkbox', { name: /^OCR/ })
      const lines = member.page.getByRole('checkbox', { name: /^Line segmentation/ })
      await expect(lines).toBeChecked()
      await expect(lines).toBeEnabled()
      await expect(ocr).not.toBeChecked()
      await expect(ocr).toBeDisabled()
      await expect(member.page.getByTestId('phase-locked-ocr'))
        .toHaveText('You have not been granted OCR - an admin can grant it on the Admin page.')
      await expect(member.page.getByTestId('phase-locked-lines')).toHaveCount(0)

      await member.page.locator('input[type="file"]').setInputFiles([
        { name: 'folio_1.png', mimeType: 'image/png', buffer: scanPng() },
      ])
      await member.page.getByRole('button', { name: 'Create job' }).click()
      await expect(member.page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
      const jobId = member.page.url().split('/').pop()!
      const job = await getJob(jobId)
      expect([job.name, job.owner, job.run_layout, job.run_lines, job.run_ocr])
        .toEqual([name, member.username, false, true, false])
      await member.context.close()
    })
})
