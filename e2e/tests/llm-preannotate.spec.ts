import { test, expect } from '../helpers/test'
import {
  backendFetch, getPageDetail, identity, jobPageIds, llmStats, pageCandidates, redetectLines,
  resetLlmStats, seedDistinctPagesJob, seedLlmConnection, setElementBbox, uniqueName,
  waitForJobStatus,
} from '../helpers/api'
import { llmReadStatus, pickModel, waitForLlmReads } from '../helpers/llm'
import { openViewer } from '../helpers/viewer'

const DEV = identity('dev', 'admin')

// The stub provider answers from the model id alone: 'stub-perfect' returns the stub
// runner's own six lines verbatim, 'stub-typo' gets one word wrong. See e2e/README.md.
const PERFECT = 'stub-perfect'
const TYPO = 'stub-typo'
// Reads correctly but slowly, so a run can be looked at while it is still happening.
const SLOW = 'stub-slow'

const BARELY_MOVED = [0.1, 0.2, 0.88, 0.85]

async function paragraphOf(jobId: string, pageId: number) {
  const detail = await getPageDetail(jobId, pageId)
  return detail.elements.find((e: { class_name: string }) => e.class_name === 'Paragraph')!
}

test.describe('Scenario: pre-annotating a dataset with language models', () => {
  test('two models read every page, and their readings land on the lines', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('LLM read'), 2)
    const connection = uniqueName('Reader pair')
    await seedLlmConnection(connection, [PERFECT, TYPO], DEV)
    await resetLlmStats()

    await page.goto(`/jobs/${jobId}`)
    await page.getByTestId('llm-read-open').click()
    await pickModel(page, connection, PERFECT).check()
    await pickModel(page, connection, TYPO).check()
    // Two models over two scans, none of them read before.
    await expect(page.getByTestId('llm-cost')).toHaveText('4 calls over 2 pages.')
    await page.getByTestId('llm-start').click()

    // Work was queued, so the progress strip carries it and there is nothing to announce.
    await expect(page.getByTestId('llm-progress')).toBeVisible()
    await expect(page.getByTestId('job-notice')).toHaveCount(0)

    await waitForLlmReads(jobId, 4)

    // Exactly one call per scan per model - no page read twice.
    expect(await llmStats()).toMatchObject({
      total: 4, calls: { 'stub-perfect': 2, 'stub-typo': 2 },
    })

    // Both readings sit on the lines they describe. The stub OCR reads the first
    // paragraph line as 'Sample Paragraph line 1'; both models agree on it, and only
    // 'stub-typo' misreads the second.
    const [pageId] = await jobPageIds(jobId)
    const paragraph = await paragraphOf(jobId, pageId)
    const candidates = await pageCandidates(pageId)
    const onLine = (lineId: number) => candidates
      .filter((c) => c.source === 'llm' && c.line_id === lineId)
      .map((c) => `${c.author}=${c.text}`)
      .sort()

    expect(onLine(paragraph.lines[0].id)).toEqual([
      `llm:${connection} ${PERFECT}=Sample Paragraph line 1`,
      `llm:${connection} ${TYPO}=Sample Paragraph line 1`,
    ])
    expect(onLine(paragraph.lines[1].id)).toEqual([
      `llm:${connection} ${PERFECT}=Sample Paragraph line 2`,
      `llm:${connection} ${TYPO}=Sample Paragraf line 2`,
    ])
  })

  test('re-detecting the lines re-matches the readings without paying again', async ({ page: _p }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('LLM redetect'), 1)
    const connection = uniqueName('Single reader')
    const seeded = await seedLlmConnection(connection, [PERFECT], DEV)
    await resetLlmStats()

    const perfect = seeded.models[0]
    await backendFetch(`/api/jobs/${jobId}/llm/read`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...DEV },
      body: JSON.stringify({ model_ids: [perfect.id] }),
    })
    await waitForLlmReads(jobId, 1)
    const afterFirstRead = await llmStats()
    expect(afterFirstRead.total).toBe(1)

    const [pageId] = await jobPageIds(jobId)
    const before = await paragraphOf(jobId, pageId)
    expect((await pageCandidates(pageId)).filter((c) => c.line_id === before.lines[0].id
      && c.source === 'llm')).toHaveLength(1)

    // The lines are re-detected: new rows, new ids, so every reading is homeless again.
    await setElementBbox(before.id, BARELY_MOVED)
    await redetectLines(jobId, pageId)
    await waitForJobStatus(jobId, 'done')

    const after = await paragraphOf(jobId, pageId)
    expect(after.lines[0].id).not.toBe(before.lines[0].id)
    const rematched = (await pageCandidates(pageId))
      .filter((c) => c.source === 'llm' && c.line_id === after.lines[0].id)
    expect(rematched.map((c) => c.text)).toEqual(['Sample Paragraph line 1'])

    // The whole point: not one extra call to get them back.
    expect(await llmStats()).toEqual(afterFirstRead)
  })

  test('the same scan in another dataset is never paid for twice', async ({ page }) => {
    const first = await seedDistinctPagesJob(uniqueName('LLM paid'), 1)
    const connection = uniqueName('Reused reader')
    const seeded = await seedLlmConnection(connection, [PERFECT], DEV)
    await resetLlmStats()
    const perfect = seeded.models[0]
    await backendFetch(`/api/jobs/${first}/llm/read`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...DEV },
      body: JSON.stringify({ model_ids: [perfect.id] }),
    })
    await waitForLlmReads(first, 1)
    expect((await llmStats()).total).toBe(1)

    // A second dataset ingesting the identical scan.
    const second = await seedDistinctPagesJob(uniqueName('LLM free'), 1)

    await page.goto(`/jobs/${second}`)
    await page.getByTestId('llm-read-open').click()
    await pickModel(page, connection, PERFECT).check()
    await expect(page.getByTestId('llm-cost')).toHaveText('0 calls over 1 page, 1 already read and free.')
    await page.getByTestId('llm-start').click()

    // Nothing is queued, so nothing appears in the progress strip: the page has to say
    // what happened, or the click looks like it did nothing at all.
    await expect(page.getByTestId('job-notice'))
      .toHaveText("Nothing new to read - 1 reading already on file, now on this dataset's lines.")

    // The reading is on the second dataset's lines, and the provider was never called.
    const [pageId] = await jobPageIds(second)
    await expect.poll(async () => (await pageCandidates(pageId))
      .filter((c) => c.source === 'llm').length, { timeout: 20_000 }).toBe(6)
    expect((await llmStats()).total).toBe(1)
  })

  test('a model that fails says why, and the failure is retried rather than buried',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('LLM failing'), 1)
      const connection = uniqueName('Broken reader')
      await seedLlmConnection(connection, ['stub-error'], DEV)

      await page.goto(`/jobs/${jobId}`)
      await page.getByTestId('llm-read-open').click()
      await pickModel(page, connection, 'stub-error').check()
      await page.getByTestId('llm-start').click()

      await expect(page.locator(
        `[data-testid="llm-progress-error"][data-label="${connection} stub-error"]`))
        .toContainText('the model is overloaded', { timeout: 20_000 })
      await expect.poll(async () => (await llmReadStatus(jobId)).error).toBe(1)

      // Asking again retries it - a failed reading was never paid for, so there is
      // nothing to protect. Counting from zero makes the retry's own call the subject.
      await resetLlmStats()
      await page.getByTestId('llm-read-open').click()
      await pickModel(page, connection, 'stub-error').check()
      await page.getByTestId('llm-start').click()
      // Both halves in one poll: the row is briefly back to pending while the retry runs,
      // so asking about either alone can catch it mid-flight.
      await expect.poll(async () => ({
        calls: (await llmStats()).calls['stub-error'] ?? 0,
        failed: (await llmReadStatus(jobId)).error,
      }), { timeout: 20_000 }).toEqual({ calls: 1, failed: 1 })
    })
})

test.describe('Scenario: reading part of a dataset', () => {
  const llmOn = (pageId: number) =>
    pageCandidates(pageId).then((held) => held.filter((c) => c.source === 'llm').length)

  test('a ticked page is read and the rest of the dataset is left alone', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Selection'), 2)
    const connection = uniqueName('Selective reader')
    await seedLlmConnection(connection, [PERFECT], DEV)
    await resetLlmStats()
    const [first, second] = await jobPageIds(jobId)

    await page.goto(`/jobs/${jobId}`)
    await page.locator('tbody tr').nth(1).locator('input[type="checkbox"]').click()
    await page.getByTestId('bulk-llm-read').click()
    await pickModel(page, connection, PERFECT).check()

    // The dialog prices the selection, and offers the whole dataset without closing. It
    // always says which of the two it is about to do.
    await expect(page.getByTestId('llm-scope')).toContainText('Transcribing 1 selected page of 2')
    await expect(page.getByTestId('llm-cost')).toHaveText('1 call over 1 page.')
    await page.getByTestId('llm-scope-all').click()
    await expect(page.getByTestId('llm-cost')).toHaveText('2 calls over 2 pages.')
    await expect(page.getByTestId('llm-scope')).toContainText('Transcribing all 2 pages')

    // Back to the selection by reopening, and read it.
    await page.getByRole('button', { name: 'Cancel' }).click()
    await page.getByTestId('bulk-llm-read').click()
    await pickModel(page, connection, PERFECT).check()
    await expect(page.getByTestId('llm-cost')).toHaveText('1 call over 1 page.')
    await page.getByTestId('llm-start').click()

    await waitForLlmReads(jobId, 1)
    // One scan sent, one page read: the same locator finds readings on the ticked page
    // and none on the other.
    expect((await llmStats()).total).toBe(1)
    expect(await llmOn(second)).toBe(6)
    expect(await llmOn(first)).toBe(0)
  })

  test('the models a dataset reads with are pinned where its other models are',
    async ({ page }) => {
      const name = uniqueName('Pinned')
      const jobId = await seedDistinctPagesJob(name, 1)
      const connection = uniqueName('Pinned reader')
      await seedLlmConnection(connection, [PERFECT], DEV)
      await resetLlmStats()

      await page.goto('/')
      const card = page.getByTestId('job-card').filter({ hasText: name })
      await card.getByTestId('job-menu').click()
      await card.getByRole('button', { name: 'Models…' }).click()
      await page.locator(`[data-testid="llm-model-pin"][data-label="${connection} ${PERFECT}"]`)
        .getByRole('checkbox').check()
      await page.getByRole('button', { name: 'Save' }).click()

      // Backend oracle: pinned on the dataset, and nothing was read to say so.
      await expect.poll(async () =>
        (await backendFetch(`/api/jobs/${jobId}`, { headers: DEV })).llm_model_ids,
      ).toHaveLength(1)
      expect((await llmStats()).total).toBe(0)

      // Which is what the page viewer's own read offers without being asked again.
      const [pageId] = await jobPageIds(jobId)
      await openViewer(page, jobId, pageId)
      await page.getByTestId('run-menu').click()
      await expect(page.getByTestId('run-llm-read')).toContainText(`${connection} ${PERFECT}`)
    })

  test('a page can be sent to the models from the viewer, once the dataset has some',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('One page'), 2)
      const connection = uniqueName('Viewer reader')
      await seedLlmConnection(connection, [PERFECT], DEV)
      await resetLlmStats()
      const [first, second] = await jobPageIds(jobId)

      // Reading one page is also what tells the dataset which models it reads with.
      await page.goto(`/jobs/${jobId}`)
      await page.locator('tbody tr').nth(0).locator('input[type="checkbox"]').click()
      await page.getByTestId('bulk-llm-read').click()
      await pickModel(page, connection, PERFECT).check()
      await page.getByTestId('llm-start').click()
      await waitForLlmReads(jobId, 1)

      // The page that was read has nothing left to ask of this model - the entry still
      // opens, because picking a different one is exactly what to do about that.
      await openViewer(page, jobId, first)
      await page.getByTestId('run-menu').click()
      const entry = page.getByTestId('run-llm-read')
      await expect(entry).toContainText('already read')

      // The one that was not, is named and priced, and the dialog behind it prices the
      // page alone before anything is sent.
      await openViewer(page, jobId, second)
      await page.getByTestId('run-menu').click()
      await expect(entry).toContainText(`${connection} ${PERFECT} - 1 call`)
      await entry.click()
      await expect(page.getByTestId('llm-cost')).toHaveText('1 call over 1 page.')
      await page.getByTestId('llm-start').click()

      // The run is not waited on in the page: a pill says it is happening.
      await expect(page.getByTestId('llm-run-pill')).toBeVisible()
      await waitForLlmReads(jobId, 2)
      expect((await llmStats()).total).toBe(2)
      await expect.poll(() => llmOn(second)).toBe(6)
      // And it clears itself once the queue drains, rather than sitting there.
      await expect(page.getByTestId('llm-run-pill')).toHaveCount(0)
    })

  test('the pill is about the page on screen, and stays behind when that page is left',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Pill scope'), 2)
      const connection = uniqueName('Slow reader')
      await seedLlmConnection(connection, [SLOW], DEV)
      await resetLlmStats()
      const [first, second] = await jobPageIds(jobId)

      await openViewer(page, jobId, first)
      await page.getByTestId('run-menu').click()
      await page.getByTestId('run-llm-read').click()
      await pickModel(page, connection, SLOW).check()
      await page.getByTestId('llm-start').click()

      const pill = page.getByTestId('llm-run-pill')
      await expect(pill).toBeVisible()

      // The second page was never sent, so nothing on it is being read. The pill must not
      // follow the reader around the dataset claiming otherwise.
      await page.keyboard.press('ArrowRight')
      await expect(page).toHaveURL(new RegExp(`/pages/${second}$`))
      await expect(pill).toHaveCount(0)

      // Backend oracle: the run is genuinely still in flight, on the first page alone.
      const active = async (pageId: number) => (await llmReadStatus(jobId, [pageId])).active
      expect(await active(first)).toBe(true)
      expect(await active(second)).toBe(false)

      // Back where the reading is happening, it says so again.
      await page.keyboard.press('ArrowLeft')
      await expect(page).toHaveURL(new RegExp(`/pages/${first}$`))
      await expect(pill).toBeVisible()

      await waitForLlmReads(jobId, 1)
      await expect(pill).toHaveCount(0)
    })
})

test.describe('Scenario: seeing which pages have been transcribed', () => {
  test('the table marks the rows a model has read, and the banner says the scope',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Partly read'), 3)
      const connection = uniqueName('Partial reader')
      await seedLlmConnection(connection, [PERFECT], DEV)
      await resetLlmStats()

      await page.goto(`/jobs/${jobId}`)
      await page.locator('tbody tr').nth(1).locator('input[type="checkbox"]').click()
      await page.getByTestId('bulk-llm-read').click()
      await pickModel(page, connection, PERFECT).check()
      await page.getByTestId('llm-start').click()
      await waitForLlmReads(jobId, 1)

      await page.reload()
      // One chip, on the row that was read - and the same locator finds none on the rest.
      const chips = page.getByTestId('page-llm-models')
      await expect(chips).toHaveCount(1)
      await expect(chips).toHaveText('1')
      await expect(page.locator('tbody tr').nth(1).getByTestId('page-llm-models')).toBeVisible()
    })

  test('a banner left standing by a failed reading can be dismissed', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Stuck banner'), 2)
    const connection = uniqueName('Failing reader')
    await seedLlmConnection(connection, ['stub-error'], DEV)

    // One page of two, so what the banner counts and what the dataset holds differ.
    await page.goto(`/jobs/${jobId}`)
    await page.locator('tbody tr').first().locator('input[type="checkbox"]').click()
    await page.getByTestId('bulk-llm-read').click()
    await pickModel(page, connection, 'stub-error').check()
    await page.getByTestId('llm-start').click()
    await expect.poll(async () => (await llmReadStatus(jobId)).error, { timeout: 20_000 }).toBe(1)
    await expect(page.getByTestId('llm-progress')).toBeVisible()
    // 1/1 read reads as the whole dataset having been transcribed, so the banner says what
    // it is counting out of.
    await expect(page.getByTestId('llm-progress-scope')).toHaveText('of 2 pages in this dataset')

    // The failure is stored, so the banner used to stay up for the life of the dataset.
    await page.getByTestId('llm-progress-dismiss').click()
    await expect(page.getByTestId('llm-progress')).toHaveCount(0)
    // Dismissing hides it; it does not pretend the failure is gone.
    expect((await llmReadStatus(jobId)).error).toBe(1)
  })
})
