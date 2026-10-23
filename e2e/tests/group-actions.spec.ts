import { test, expect } from '../helpers/test'
import {
  correctLine, createGroup, getJob, getReocrPreview, greedyLines, jobPageIds, markLinesChecked,
  moveJobToGroup, pageLines, patchJob, seedCompletedJob, uniqueName, waitForJobStatus,
} from '../helpers/api'

/** The dataset's own row and the group's header offer the same actions, because both fill
 *  the same selection and hit the same endpoint. What is worth proving here is that asking
 *  a group reaches every dataset in it, says what it will cost before it does, and leaves
 *  the datasets outside alone. */

test.describe('Scenario: one action over a whole group', () => {
  test('re-reading a group says what it will cost, then queues every dataset in it',
       async ({ page }) => {
    const groupName = uniqueName('Run group')
    const group = await createGroup(groupName)
    const first = await seedCompletedJob(uniqueName('Run first'), 1)
    const second = await seedCompletedJob(uniqueName('Run second'), 1)
    const outside = await seedCompletedJob(uniqueName('Run outside'), 1)
    for (const jobId of [first, second]) await moveJobToGroup(jobId, group.id)
    // Decoding greedily from here on, so the lines this action re-reads are tellable
    // apart from the ones the original beam run wrote.
    for (const jobId of [first, second]) await patchJob(jobId, { ocr_decode: 'greedy' })
    // One line is checked, so the preview has something to say it will leave alone.
    await markLinesChecked(first, 1)

    await page.goto('/')
    const section = page.locator('section').filter({ hasText: groupName })
    await section.getByTestId('group-run').click()
    await page.getByRole('button', { name: 'Re-read OCR…' }).click()

    // The stub detects two elements per page and cuts three lines in each, so a
    // one-page dataset holds six. Two of them in the group is twelve, of which the one
    // checked above stays as it is and the other eleven are re-read.
    const dialog = page.getByTestId('bulk-preview')
    await expect(dialog.getByTestId('preview-datasets')).toHaveText('2')
    await expect(dialog.getByTestId('preview-unchecked')).toHaveText('11')
    await expect(dialog.getByTestId('preview-checked')).toHaveText('1')

    await page.getByRole('button', { name: 'Re-read OCR', exact: true }).click()

    // The backend is the oracle, and provenance is the durable form of it: the datasets
    // were set to decode greedily above, so a line carrying a greedy author is one this
    // re-read produced. Waiting for the status to leave 'done' would race the worker,
    // which finishes a one-page dataset in about a second.
    await expect.poll(async () => greedyLines(first)).toBe(5)
    await expect.poll(async () => greedyLines(second)).toBe(6)
    expect(await greedyLines(outside)).toBe(0)
    for (const jobId of [first, second]) await waitForJobStatus(jobId, 'done')

    // The one line a person had checked keeps the text they left on it.
    const after = await getReocrPreview(first)
    expect(after.checked).toBe(1)
  })

  test('aligning a group says it discards nothing, and the corrections survive it',
       async ({ page }) => {
    const groupName = uniqueName('Align group')
    const group = await createGroup(groupName)
    const first = await seedCompletedJob(uniqueName('Align first'), 1)
    const second = await seedCompletedJob(uniqueName('Align second'), 1)
    for (const jobId of [first, second]) await moveJobToGroup(jobId, group.id)
    const [pageId] = await jobPageIds(first)
    const [line] = await pageLines(first, pageId)
    await correctLine(line.id, 'Pfarre Wien', false)

    await page.goto('/')
    const section = page.locator('section').filter({ hasText: groupName })
    await section.getByTestId('group-run').click()
    await page.getByRole('button', { name: 'Alignment…' }).click()

    // Six stub lines per one-page dataset, twelve in the group. Alignment re-matches the
    // text on hand, so the correction above is not among what it costs.
    const dialog = page.getByTestId('bulk-preview')
    await expect(dialog.getByTestId('preview-datasets')).toHaveText('2')
    await expect(dialog.getByTestId('preview-lines')).toHaveText('12')
    await expect(dialog.getByTestId('preview-corrected')).toHaveText('0')

    const ran = page.waitForResponse((r) => r.url().endsWith('/api/bulk/rerun'))
    await page.getByRole('button', { name: 'Re-run', exact: true }).click()
    expect((await (await ran).json()).changed.map((c: { id: string }) => c.id).sort())
      .toEqual([first, second].sort())
    for (const jobId of [first, second]) await waitForJobStatus(jobId, 'done')

    await expect.poll(async () => (await pageLines(first, pageId))
      .find((l) => l.id === line.id)?.corrected_text).toBe('Pfarre Wien')
  })

  test('a dataset that is already running is reported rather than failing the rest',
       async ({ page }) => {
    const groupName = uniqueName('Partial group')
    const group = await createGroup(groupName)
    const ready = await seedCompletedJob(uniqueName('Partial ready'), 1)
    const busy = await seedCompletedJob(uniqueName('Partial busy'), 1)
    for (const jobId of [ready, busy]) await moveJobToGroup(jobId, group.id)

    // Queue one of them behind the other so the group action finds it busy.
    await page.request.post(`/api/jobs/${busy}/reocr`, { data: { scope: 'unchecked' } })
    await expect.poll(async () => (await getJob(busy)).status).not.toBe('done')

    await page.goto('/')
    const section = page.locator('section').filter({ hasText: groupName })
    await section.getByTestId('group-run').click()
    await page.getByRole('button', { name: 'Re-read OCR…' }).click()
    // Only the free one is counted; the busy one is named as left alone.
    await expect(page.getByTestId('preview-datasets')).toHaveText('1')
    await expect(page.getByTestId('preview-blocked')).toBeVisible()
  })
})

test.describe('Scenario: acting on a selection across groups', () => {
  test('picking datasets by hand files them under a group in one go', async ({ page }) => {
    const target = uniqueName('Filing target')
    const group = await createGroup(target)
    const one = await seedCompletedJob(uniqueName('Filing one'), 1)
    const two = await seedCompletedJob(uniqueName('Filing two'), 1)

    const names = [(await getJob(one)).name, (await getJob(two)).name]
    await page.goto('/')
    for (const name of names) {
      const row = page.getByTestId('job-card').filter({ hasText: name })
      await row.getByRole('checkbox').check()
    }
    await expect(page.getByTestId('bulk-bar')).toContainText('2 selected')
    await page.getByRole('button', { name: 'Move to group…' }).click()
    await page.getByRole('button', { name: target, exact: true }).click()

    for (const jobId of [one, two]) {
      await expect.poll(async () => (await getJob(jobId)).group_id).toBe(group.id)
    }
  })
})
