import { test, expect } from '../helpers/test'
import {
  backendFetch, correctLine, createGroup, createJob, getJob, identity, jobPageIds, listJobs,
  moveJobToGroup, pageLines, seedCompletedJob, shareJob, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { scanPng } from '../helpers/image'
import { asSession, seedSession, useSession } from '../helpers/session'

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function lastActivity(jobId: string): Promise<string | null> {
  const job = (await listJobs()).find((j) => j.id === jobId) as { last_activity?: string | null }
  return job.last_activity ?? null
}

test.describe('Scenario: the list opens on what people worked on', () => {
  test('a dataset only the machine has touched is not "recently worked on"', async ({ page }) => {
    // Matched to a transcription and auto-checked by alignment, with nobody touching it.
    const alignedName = uniqueName('Machine only')
    const form = new FormData()
    form.append('name', alignedName)
    form.append('line_mode', 'per_crop')
    form.append('gt_autocheck', 'true')
    form.append('files', new Blob([new Uint8Array(scanPng())], { type: 'image/png' }), 'folio_1.png')
    form.append('files', new Blob(['Sample Header line 1\nSample Paragraph line 2'],
                                  { type: 'text/plain' }), 'folio_1.txt')
    const { job_id: aligned } = await backendFetch('/api/jobs', { method: 'POST', body: form })
    await waitForJobStatus(aligned, 'done')
    // Both transcription lines match a recognized line exactly, so alignment checked both.
    const alignedLines = await pageLines(aligned, (await jobPageIds(aligned))[0])
    expect(alignedLines.filter((l) => l.checked && l.check_source === 'align').map((l) => l.text))
      .toEqual(['Sample Header line 1', 'Sample Paragraph line 2'])

    // Corrected by a person afterwards, so it is newer than the aligned one.
    const editedName = uniqueName('Hand edited')
    const edited = await seedCompletedJob(editedName, 1)
    const [editedLine] = await pageLines(edited, (await jobPageIds(edited))[0])
    await correctLine(editedLine.id, 'Set right by hand')

    // Backend oracle: alignment is the pipeline's work, not somebody's.
    await expect.poll(() => lastActivity(edited)).not.toBeNull()
    expect(await lastActivity(aligned)).toBeNull()

    await page.goto('/')
    const recent = page.getByTestId('recent-dataset')
    await expect(recent.filter({ hasText: editedName })).toHaveCount(1)
    await expect(recent.filter({ hasText: alignedName })).toHaveCount(0)
  })
})

test.describe('Scenario: a group action says what it will change', () => {
  test('group settings count every dataset in the group, not only the ones the search shows',
    async ({ page }) => {
      const groupName = uniqueName('Settings group')
      const group = await createGroup(groupName)
      const shownName = uniqueName('Searched for')
      const shown = await seedCompletedJob(shownName, 1)
      const hidden = await seedCompletedJob(uniqueName('Filtered away'), 1)
      for (const jobId of [shown, hidden]) await moveJobToGroup(jobId, group.id)

      await page.goto(`/?q=${encodeURIComponent(shownName)}`)
      const section = page.locator('section').filter({ hasText: groupName })
      await expect(section.getByTestId('job-card')).toHaveCount(1)
      await section.getByTestId('group-settings').click()
      await page.getByTestId('group-pick-decode').selectOption('greedy')

      const save = page.getByTestId('group-settings-save')
      await expect(save).toHaveText('Apply to 2 datasets')
      await save.click()

      // Backend oracle: the group route changes every dataset in it, which is what the
      // button has to have said.
      await expect.poll(async () => (await getJob(shown)).ocr_decode).toBe('greedy')
      await expect.poll(async () => (await getJob(hidden)).ocr_decode).toBe('greedy')
    })

  test('moving a selection names the datasets it could not move', async ({ browser }) => {
    const username = `mover-${Date.now()}`
    const session = seedSession('member', username)
    const ownName = uniqueName('Mine to move')
    const own = await createJob(ownName, 1, undefined, identity(username, 'member'))
    const sharedName = uniqueName('Only shared with me')
    const shared = await seedCompletedJob(sharedName, 1)
    await shareJob(shared, [username])
    await waitForJobStatus(own, 'done')

    const targetName = uniqueName('Member target')
    const created = await asSession(session, '/api/groups', {
      method: 'POST', body: JSON.stringify({ name: targetName }),
    })
    expect(created.status).toBe(200)
    const target = (await created.json()) as { id: number }

    const context = await browser.newContext()
    await useSession(context, session)
    const page = await context.newPage()
    await page.goto('/')
    for (const name of [ownName, sharedName]) {
      await page.getByTestId('job-card').filter({ hasText: name }).getByRole('checkbox').check()
    }
    await expect(page.getByTestId('bulk-bar')).toContainText('2 selected')
    await page.getByRole('button', { name: 'Move to group…' }).click()
    await page.getByRole('button', { name: targetName, exact: true }).click()

    // Backend oracle: theirs moved, somebody else's did not.
    await expect.poll(async () => (await getJob(own)).group_id).toBe(target.id)
    expect((await getJob(shared)).group_id).toBeNull()

    // And the list says which one stayed where it was, as a re-run over a selection does.
    await expect(page.getByText(new RegExp(`1 skipped: ${escape(sharedName)}`))).toBeVisible()
    await context.close()
  })
})

test.describe('Scenario: walking a large dataset a screenful at a time', () => {
  test('Show more reaches the last page of a dataset larger than one request', async ({ page }) => {
    test.setTimeout(240_000)
    const PAGES = 501
    const form = new FormData()
    form.append('name', uniqueName('Large volume'))
    form.append('line_mode', 'per_crop')
    form.append('run_layout', 'false')
    form.append('run_lines', 'false')
    form.append('run_ocr', 'false')
    // Every scan a different height, so no two hash alike and ingest keeps them all.
    for (let i = 0; i < PAGES; i++) {
      form.append('files', new Blob([new Uint8Array(scanPng(60, 80 + i))], { type: 'image/png' }),
                  `scan_${String(i + 1).padStart(3, '0')}.png`)
    }
    const { job_id: jobId } = await backendFetch('/api/jobs', { method: 'POST', body: form })
    await waitForJobStatus(jobId, 'done', 180_000)
    expect((await getJob(jobId)).pages.length).toBe(PAGES)

    await page.goto(`/jobs/${jobId}`)
    const rows = page.locator('tbody tr')
    const count = page.getByTestId('page-count')
    await expect(count).toHaveText(`Showing 200 of ${PAGES}`)
    await page.getByTestId('page-more').click()
    await expect(count).toHaveText(`Showing 400 of ${PAGES}`)
    await page.getByTestId('page-more').click()

    await expect(rows).toHaveCount(PAGES)
    await expect(rows.last()).toContainText(`scan_${PAGES}.png`)
    await expect(count).toHaveCount(0)
  })
})
