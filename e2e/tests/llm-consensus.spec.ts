import { test, expect } from '../helpers/test'
import {
  backendFetch, correctLine, createTraining, getJob, identity, jobPageIds, listTrainings,
  llmStats, pageLines, patchJob, resetLlmStats, seedDistinctPagesJob, seedLlmConnection,
  uniqueName,
} from '../helpers/api'
import { startLlmRead } from '../helpers/llm'
import { openViewer } from '../helpers/viewer'
import { pickDataset, taskSection } from '../helpers/training'
import { datasetAction, openDatasetMenu } from '../helpers/dataset'

const DEV = identity('dev', 'admin')

// 'stub-perfect' and 'stub-second' both return the stub runner's own six lines verbatim;
// 'stub-typo' returns the same six with 'Paragraph line 2' misread as 'Paragraf line 2'.
const PERFECT = 'stub-perfect'
const SECOND = 'stub-second'
const TYPO = 'stub-typo'

const DISPUTED = 'Sample Paragraph line 2'

// The identity helpers/api.ts seeds under, which is who a correction made there is by.
const SEEDER = 'e2e-seeder'

const STUB_LINES = [
  'Sample Header line 1', 'Sample Header line 2', 'Sample Header line 3',
  'Sample Paragraph line 1', 'Sample Paragraph line 2', 'Sample Paragraph line 3',
]

/** What settles a line and who did it - the fields every oracle below reads. */
async function lineState(jobId: string, pageId: number, lineId: number) {
  const line = (await pageLines(jobId, pageId)).find((l) => l.id === lineId)!
  return {
    corrected_text: line.corrected_text, corrected_by: line.corrected_by,
    llm_agree_count: line.llm_agree_count, checked: line.checked,
  }
}

test.describe('Scenario: language models agreeing on a line', () => {
  test('two models settle the lines they read alike, and leave the one they do not',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Consensus'), 1)
      const connection = uniqueName('Pair')
      await seedLlmConnection(connection, [PERFECT, TYPO], DEV)
      await resetLlmStats()

      await startLlmRead(page, jobId, connection, [PERFECT, TYPO], { minAgree: 2 })

      const [pageId] = await jobPageIds(jobId)
      await expect.poll(async () =>
        (await pageLines(jobId, pageId)).filter((l) => l.corrected_text !== null).length,
      { timeout: 20_000 }).toBe(5)

      const lines = await pageLines(jobId, pageId)
      const byText = (text: string) => lines.find((l) => l.text === text)!
      // Read alike by both, so the reading is filled in - but nobody has verified it.
      expect(byText('Sample Header line 1')).toMatchObject({
        corrected_text: 'Sample Header line 1', llm_agree_count: 2, checked: false,
        check_source: null,
      })
      // The one they read differently is left exactly as the OCR model had it.
      expect(byText(DISPUTED)).toMatchObject({
        corrected_text: null, llm_agree_count: 1, checked: false,
      })
    })

  test('a third model breaking the tie settles the last line too', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Consensus three'), 1)
    const connection = uniqueName('Trio')
    await seedLlmConnection(connection, [PERFECT, TYPO, SECOND], DEV)
    await resetLlmStats()

    await startLlmRead(page, jobId, connection, [PERFECT, TYPO, SECOND], { minAgree: 2 })

    const [pageId] = await jobPageIds(jobId)
    await expect.poll(async () =>
      (await pageLines(jobId, pageId)).filter((l) => l.corrected_text !== null).length,
    { timeout: 20_000 }).toBe(6)

    const disputed = (await pageLines(jobId, pageId)).find((l) => l.text === DISPUTED)!
    // Two of the three read it as the page has it; the odd one out does not carry the line.
    expect(disputed).toMatchObject({ corrected_text: DISPUTED, llm_agree_count: 2 })
  })

  test('raising the bar to three leaves a pair unsettled', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Consensus strict'), 1)
    const connection = uniqueName('Strict pair')
    await seedLlmConnection(connection, [PERFECT, SECOND], DEV)
    await resetLlmStats()

    await startLlmRead(page, jobId, connection, [PERFECT, SECOND], { minAgree: 3 })

    const [pageId] = await jobPageIds(jobId)
    const lines = await pageLines(jobId, pageId)
    // Both read every line the same way, and it still is not enough.
    expect(lines.filter((l) => l.llm_agree_count === 2)).toHaveLength(6)
    expect(lines.filter((l) => l.corrected_text !== null)).toHaveLength(0)
  })
})

test.describe('Scenario: letting agreement select lines for training', () => {
  test('settled lines are checked off, stay marked as machine-settled, and can be left out of a run',
    async ({ page }) => {
      const name = uniqueName('Autocheck')
      const jobId = await seedDistinctPagesJob(name, 1)
      const connection = uniqueName('Agreeing pair')
      await seedLlmConnection(connection, [PERFECT, SECOND], DEV)
      await resetLlmStats()

      await startLlmRead(page, jobId, connection, [PERFECT, SECOND], { minAgree: 2, autocheck: true })

      const [pageId] = await jobPageIds(jobId)
      await expect.poll(async () =>
        (await pageLines(jobId, pageId)).filter((l) => l.checked).length,
      { timeout: 20_000 }).toBe(6)

      const lines = await pageLines(jobId, pageId)
      expect(lines.every((l) => l.check_source === 'llm')).toBe(true)
      expect(lines.map((l) => l.corrected_text)).toEqual([
        'Sample Header line 1', 'Sample Header line 2', 'Sample Header line 3',
        'Sample Paragraph line 1', 'Sample Paragraph line 2', 'Sample Paragraph line 3',
      ])

      // The training dialog counts them apart from what a person verified, and offers to
      // train without them.
      const preview = await backendFetch('/api/trainings/preview', {
        method: 'POST',
        headers: { ...DEV, 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'ocr', job_ids: [jobId] }),
      })
      expect(preview.counts[jobId]).toBe(6)
      expect(preview.machine_settled[jobId]).toBe(6)

      await page.goto('/models')
      const ocrSection = taskSection(page, 'ocr')
      await ocrSection.getByTestId('train-model').click()
      await pickDataset(page, name)
      await expect(page.getByTestId('settled-count'))
        .toContainText('6 of 6 checked lines were settled by models')
      await expect(page.getByTestId('human-checked-only')).toBeVisible()
    })

  test('training only on what a person verified is refused when nobody verified anything',
    async ({ page }) => {
      const name = uniqueName('Only machines')
      const jobId = await seedDistinctPagesJob(name, 1, 70)
      const connection = uniqueName('Settling pair')
      await seedLlmConnection(connection, [PERFECT, SECOND], DEV)
      await resetLlmStats()

      await startLlmRead(page, jobId, connection, [PERFECT, SECOND], { minAgree: 2, autocheck: true })
      const [pageId] = await jobPageIds(jobId)
      await expect.poll(async () =>
        (await pageLines(jobId, pageId)).filter((l) => l.check_source === 'llm').length,
      { timeout: 20_000 }).toBe(6)

      const start = (humanOnly: boolean, modelName: string) => createTraining({
        task: 'ocr', name: modelName, dataset_job_ids: [jobId], target: 'local',
        epochs: 1, batch_size: 4, val_fraction: 0.3, human_checked_only: humanOnly,
      }, DEV)
      // Every checked line was settled by models, so leaving them out leaves nothing.
      const emptyName = uniqueName('Nothing to learn')
      await expect(start(true, emptyName)).rejects.toThrow(/400/)
      expect((await listTrainings()).some((t) => t.name === emptyName)).toBe(false)

      // The same request with the models' lines allowed has six to train on.
      const fullName = uniqueName('Machine material')
      await start(false, fullName)
      await expect.poll(async () => (await listTrainings()).find((t) => t.name === fullName)?.status,
                        { timeout: 60_000 }).toBe('done')
    })

  test('a line the models settled becomes a person\'s once a person corrects it', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Taken over'), 1, 75)
    const connection = uniqueName('Settling pair')
    await seedLlmConnection(connection, [PERFECT, SECOND], DEV)
    await resetLlmStats()

    await startLlmRead(page, jobId, connection, [PERFECT, SECOND], { minAgree: 2, autocheck: true })
    const [pageId] = await jobPageIds(jobId)
    await expect.poll(async () =>
      (await pageLines(jobId, pageId)).filter((l) => l.check_source === 'llm').length,
    { timeout: 20_000 }).toBe(6)

    const [taken, untouched] = await pageLines(jobId, pageId)
    await correctLine(taken.id, 'A person read it this way')
    const after = await pageLines(jobId, pageId)
    expect(after.find((l) => l.id === taken.id)).toMatchObject({
      corrected_text: 'A person read it this way', checked: true, check_source: null,
    })
    // The lines nobody touched are still the models'.
    expect(after.find((l) => l.id === untouched.id)!.check_source).toBe('llm')
  })

  test('a correction someone made is never overwritten by agreement', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Human wins'), 1)
    const connection = uniqueName('Overruled pair')
    await seedLlmConnection(connection, [PERFECT, SECOND], DEV)
    await resetLlmStats()

    const [pageId] = await jobPageIds(jobId)
    const first = (await pageLines(jobId, pageId))[0]
    await correctLine(first.id, 'What a person typed')

    await startLlmRead(page, jobId, connection, [PERFECT, SECOND], { minAgree: 2, autocheck: true })

    // Every other line is settled, so the run definitely reached this page...
    await expect.poll(async () =>
      (await pageLines(jobId, pageId)).filter((l) => l.check_source === 'llm').length,
    { timeout: 20_000 }).toBe(5)

    // ...and the one a person had touched still says what they typed.
    const kept = (await pageLines(jobId, pageId)).find((l) => l.id === first.id)!
    expect(kept).toMatchObject({
      corrected_text: 'What a person typed', check_source: null, llm_agree_count: 2,
    })
  })
})

test.describe('Scenario: letting Deep OCR count as one of the readers', () => {
  test('one model agreeing with the recognition settles a line, and the line it misreads stays open',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Ocr votes'), 1)
      const connection = uniqueName('Single')
      await seedLlmConnection(connection, [TYPO], DEV)
      await resetLlmStats()

      // One model alone could never reach two. With Deep OCR counted in, every line it
      // reads as the page was recognised does.
      await startLlmRead(page, jobId, connection, [TYPO], { minAgree: 2, withOcr: true })

      const [pageId] = await jobPageIds(jobId)
      await expect.poll(async () =>
        (await pageLines(jobId, pageId)).filter((l) => l.corrected_text !== null).length,
      { timeout: 20_000 }).toBe(5)

      const lines = await pageLines(jobId, pageId)
      expect(lines.find((l) => l.text === 'Sample Header line 1')).toMatchObject({
        corrected_text: 'Sample Header line 1', llm_agree_count: 2, checked: false,
      })
      // 'Paragraf line 2' is not what the recognition says, so that line is still one voice.
      expect(lines.find((l) => l.text === DISPUTED)).toMatchObject({
        corrected_text: null, llm_agree_count: 1,
      })
      // And the dataset remembers the choice for the next read.
      const job = await backendFetch(`/api/jobs/${jobId}`, { headers: DEV })
      expect(job.llm_consensus_with_ocr).toBe(true)
    })

  test('left off, the same single model settles nothing', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Ocr silent'), 1)
    const connection = uniqueName('Single off')
    await seedLlmConnection(connection, [TYPO], DEV)
    await resetLlmStats()

    await startLlmRead(page, jobId, connection, [TYPO], { minAgree: 2 })

    const [pageId] = await jobPageIds(jobId)
    // The reading did arrive - every line counts one voice...
    await expect.poll(async () =>
      (await pageLines(jobId, pageId)).filter((l) => l.llm_agree_count === 1).length,
    { timeout: 20_000 }).toBe(6)
    // ...and none of them is settled by it.
    expect((await pageLines(jobId, pageId)).filter((l) => l.corrected_text !== null)).toHaveLength(0)
  })
})

test.describe('Scenario: withdrawing the agreement that settled a line', () => {
  // README: "Setting aside the readings that settled a line withdraws the agreement: the
  // line returns to its OCR text, unless a person has checked or typed it since."
  test('setting aside a settled line\'s readings puts it back to the OCR text, and leaves what a person typed',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Unsettled'), 1, 90)
      const connection = uniqueName('Withdrawn pair')
      await seedLlmConnection(connection, [PERFECT, SECOND], DEV)
      await resetLlmStats()

      await startLlmRead(page, jobId, connection, [PERFECT, SECOND], { minAgree: 2 })
      const [pageId] = await jobPageIds(jobId)
      await expect.poll(async () =>
        (await pageLines(jobId, pageId)).filter((l) => l.corrected_text !== null).length,
      { timeout: 20_000 }).toBe(6)

      const lines = await pageLines(jobId, pageId)
      const settled = lines.find((l) => l.text === 'Sample Header line 1')!
      const typed = lines.find((l) => l.text === 'Sample Header line 2')!
      expect(await lineState(jobId, pageId, settled.id)).toEqual({
        corrected_text: 'Sample Header line 1', corrected_by: 'llm:consensus@2',
        llm_agree_count: 2, checked: false,
      })
      // A person types over one settled line without checking it: the line is theirs now.
      await correctLine(typed.id, 'What a person typed', false)
      expect(await lineState(jobId, pageId, typed.id)).toEqual({
        corrected_text: 'What a person typed', corrected_by: SEEDER, llm_agree_count: 2, checked: false,
      })

      await openViewer(page, jobId, pageId)

      // The settled line wears the reading the models agreed on: opened, it lists both
      // readers' copies as in use, and one is released from there. One voice short of the
      // two the dataset asks for, the settlement has nothing left to rest on: the line
      // reads what the OCR model said, under nobody.
      const settledRow = page.getByTestId('line-row').filter({ hasText: 'Sample Header line 1' })
      await expect(settledRow.getByTestId('agree-badge')).toHaveText('2×')
      await settledRow.click()
      const inUse = page.getByTestId('line-candidate-in-use')
      await expect(inUse).toHaveCount(2)
      await inUse.first().getByTestId('release-candidate').click()
      await expect.poll(() => lineState(jobId, pageId, settled.id)).toEqual({
        corrected_text: null, corrected_by: null, llm_agree_count: 1, checked: false,
      })
      await expect(settledRow.getByTestId('agree-badge')).toHaveCount(0)

      // The typed line's readings differ from what it says, so they are offered under it
      // and released from there. Both go, and the person's text stays theirs.
      const typedRow = page.getByTestId('line-row').filter({ hasText: 'What a person typed' })
      await expect(typedRow.getByTestId('agree-badge')).toHaveText('2×')
      await typedRow.click()
      const modelReadings = page.locator('[data-testid="line-candidate"][data-source="llm"]')
      await expect(modelReadings).toHaveCount(2)
      await modelReadings.first().getByTestId('release-candidate').click()
      await expect(modelReadings).toHaveCount(1)
      await modelReadings.first().getByTestId('release-candidate').click()
      await expect(modelReadings).toHaveCount(0)
      await expect.poll(() => lineState(jobId, pageId, typed.id)).toEqual({
        corrected_text: 'What a person typed', corrected_by: SEEDER, llm_agree_count: 0, checked: false,
      })
      await expect(typedRow.getByTestId('agree-badge')).toHaveCount(0)

      // The four lines nobody touched are still settled by the same two models.
      const rest = (await pageLines(jobId, pageId))
        .filter((l) => l.id !== settled.id && l.id !== typed.id)
      expect(rest.map((l) => [l.corrected_text, l.corrected_by, l.llm_agree_count])).toEqual(
        STUB_LINES.slice(2).map((text) => [text, 'llm:consensus@2', 2]))
    })
})

test.describe('Scenario: applying changed agreement settings to lines already read', () => {
  // README: "Agreement settings changed later apply to future reads; 'Settle again' on the
  // dataset applies them to the unchecked lines already read, and says how many it would
  // touch before it does."
  test('lowering the bar settles nothing by itself; "Settle again" names the count, settles the lines, and calls no model',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Settle again'), 1, 95)
      const connection = uniqueName('Patient pair')
      await seedLlmConnection(connection, [PERFECT, SECOND], DEV)
      await resetLlmStats()

      await startLlmRead(page, jobId, connection, [PERFECT, SECOND], { minAgree: 3 })
      const [pageId] = await jobPageIds(jobId)
      const agreement = async () => (await pageLines(jobId, pageId))
        .map((l) => ({ corrected_text: l.corrected_text, llm_agree_count: l.llm_agree_count }))
      // Both read every line alike, and two is not three.
      expect(await agreement()).toEqual(Array(6).fill({ corrected_text: null, llm_agree_count: 2 }))
      expect((await llmStats()).total).toBe(2)

      // The setting is saved as it is - the same call the read dialog makes...
      await patchJob(jobId, { llm_consensus_min: 2 })
      expect((await getJob(jobId)).llm_consensus_min).toBe(2)
      // ...and saving it settles nothing on its own.
      expect(await agreement()).toEqual(Array(6).fill({ corrected_text: null, llm_agree_count: 2 }))

      // Settling again is an explicit step on the dataset, and it says what it would touch
      // before it touches it.
      await page.goto(`/jobs/${jobId}`)
      const more = await openDatasetMenu(page, 'dataset-more')
      await expect(more.getByTestId('llm-settle-again')).toHaveAccessibleName('Re-apply LLM agreement…')
      await more.getByTestId('llm-settle-again').click()
      // The rules it applies are spelled out, from the dataset's own settings.
      await expect(page.getByTestId('llm-settle-again-rules')).toHaveText(
        "A line takes the language models' reading when at least 2 of them read it the same way, "
        + 'and stays unchecked for review. A line whose agreement no longer holds goes back to its OCR text.')
      await expect(page.getByTestId('llm-settle-again-count')).toHaveText('6 lines would change: 6 would take the LLM reading.')
      await page.getByTestId('llm-settle-again-confirm').click()

      await expect.poll(async () => (await pageLines(jobId, pageId)).map((l) => ({
        corrected_text: l.corrected_text, corrected_by: l.corrected_by,
        llm_agree_count: l.llm_agree_count, checked: l.checked,
      })), { timeout: 20_000 }).toEqual(STUB_LINES.map((text) => ({
        corrected_text: text, corrected_by: 'llm:consensus@2', llm_agree_count: 2, checked: false,
      })))
      // Settled from the readings on file: no model was asked again.
      expect((await llmStats()).total).toBe(2)
    })
})

test.describe('Scenario: removing language model readings', () => {
  test("one line's reading, then one model's, then every model's - a checked line keeps its own",
    async ({ page }) => {
      test.setTimeout(120_000)
      const jobId = await seedDistinctPagesJob(uniqueName('Readings removed'), 1, 250)
      const connection = uniqueName('Removable pair')
      await seedLlmConnection(connection, [PERFECT, SECOND], DEV)
      await resetLlmStats()
      await startLlmRead(page, jobId, connection, [PERFECT, SECOND])
      const [pageId] = await jobPageIds(jobId)
      const lines = await pageLines(jobId, pageId)
      const [header1, header2] = lines
      expect(await lineState(jobId, pageId, header1.id)).toMatchObject(
        { corrected_text: 'Sample Header line 1', llm_agree_count: 2, checked: false })
      // A person checks the second line on the models' word.
      await backendFetch(`/api/lines/${header2.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checked: true }),
      })
      const llmOn = async (lineId: number) => (await backendFetch(`/api/pages/${pageId}/candidates`))
        .candidates.filter((c: { line_id: number; source: string }) => c.line_id === lineId && c.source === 'llm')
        .map((c: { author: string }) => c.author).sort()

      // One line's reading, from the readings kept open on its agreement badge.
      await openViewer(page, jobId, pageId)
      const rowOf = (lineId: number) => page.locator(`[data-testid="line-row"][data-line-id="${lineId}"]`)
      await rowOf(header1.id).getByTestId('agree-badge').click()
      const popover = page.getByTestId('line-readings')
      await expect(popover.getByTestId('remove-reading')).toHaveCount(2)
      await popover.getByTestId('line-reading').filter({ hasText: PERFECT }).getByTestId('remove-reading').click()
      await expect.poll(() => llmOn(header1.id)).toEqual([`llm:${connection} ${SECOND}`])
      // One model left is not two agreeing: the line is back to its OCR text.
      await expect.poll(() => lineState(jobId, pageId, header1.id)).toMatchObject({ corrected_text: null })
      // The checked line's readings are not offered for deleting.
      await rowOf(header2.id).getByTestId('agree-badge').click()
      await expect(popover.getByTestId('line-reading')).toHaveCount(3)
      await expect(popover.getByTestId('remove-reading')).toHaveCount(0)
      await page.getByTestId('line-readings-backdrop').click()
      await expect(popover).toHaveCount(0)

      // One model's readings, from the dataset.
      await page.goto(`/jobs/${jobId}`)
      await datasetAction(page, 'remove-readings')
      await expect(page.getByTestId('remove-readings-option')).toHaveCount(3)
      await page.locator('[data-testid="remove-readings-option"]').filter({ hasText: SECOND }).getByRole('radio').check()
      await expect(page.getByTestId('remove-readings-warning')).toContainText('1 reading is deleted for good')
      await page.getByTestId('remove-readings-confirm').click()
      await expect(page.getByTestId('remove-readings-result')).toHaveText('Removed 1 reading.')
      const left = async () => (await backendFetch(`/api/jobs/${jobId}/llm/readings`)).models
        .map((m: { label: string }) => m.label)
      expect(await left()).toEqual([`${connection} ${PERFECT}`])
      expect(await llmOn(header1.id)).toEqual([])
      // Every unchecked line lost its agreement; the checked one kept text, tick and readings.
      const after = await pageLines(jobId, pageId)
      expect(after.filter((l) => l.id !== header2.id).map((l) => l.corrected_text)).toEqual(Array(5).fill(null))
      expect(await lineState(jobId, pageId, header2.id)).toMatchObject(
        { corrected_text: 'Sample Header line 2', checked: true })
      expect(await llmOn(header2.id)).toHaveLength(2)

      // And every model's.
      await page.getByRole('button', { name: 'Close' }).click()
      await datasetAction(page, 'remove-readings')
      await page.getByTestId('remove-readings-confirm').click()
      await expect(page.getByTestId('remove-readings-result')).toHaveText('Removed 1 reading.')
      expect(await left()).toEqual([])
      expect(await lineState(jobId, pageId, header2.id)).toMatchObject(
        { corrected_text: 'Sample Header line 2', checked: true })
      // Deleting asked no model anything.
      expect((await llmStats()).total).toBe(2)
    })
})

test.describe("Scenario: removing one page's readings", () => {
  test("from the viewer's Run menu, one model's, counted first - the dataset's other page keeps its own",
    async ({ page }) => {
      test.setTimeout(120_000)
      const jobId = await seedDistinctPagesJob(uniqueName('Page readings removed'), 2, 260)
      const connection = uniqueName('Page pair')
      await seedLlmConnection(connection, [PERFECT, SECOND], DEV)
      await startLlmRead(page, jobId, connection, [PERFECT, SECOND], { pages: 2 })
      const [first, second] = await jobPageIds(jobId)
      const onPage = async (pageId: number) => ((await backendFetch(`/api/pages/${pageId}/llm/readings`)).models as
        { label: string; readings: number }[]).map((m) => [m.label, m.readings])
      const both = [[`${connection} ${PERFECT}`, 1], [`${connection} ${SECOND}`, 1]]
      expect(await onPage(first)).toEqual(both)
      expect(await onPage(second)).toEqual(both)

      await openViewer(page, jobId, first)
      await page.getByTestId('run-menu').click()
      const remove = page.getByTestId('run-llm-remove')
      await expect(remove).toContainText('2 readings by 2 models on this page')
      await remove.click()
      const dialog = page.getByRole('dialog', { name: 'Remove LLM readings - scan_1.png' })
      await expect(dialog.getByTestId('remove-readings-option')).toHaveCount(3)
      await dialog.locator('[data-testid="remove-readings-option"]').filter({ hasText: SECOND }).getByRole('radio').check()
      await expect(dialog.getByTestId('remove-readings-warning')).toContainText('1 reading is deleted for good')
      await dialog.getByTestId('remove-readings-confirm').click()
      await expect(dialog.getByTestId('remove-readings-result')).toHaveText('Removed 1 reading.')

      expect(await onPage(first)).toEqual([[`${connection} ${PERFECT}`, 1]])
      expect(await onPage(second)).toEqual(both)
      await dialog.getByRole('button', { name: 'Close' }).click()
      await page.getByTestId('run-menu').click()
      await expect(remove).toContainText('1 reading by 1 model on this page')
    })
})
