import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import {
  OCR_AUTHOR, OCR_READER, backendFetch, correctLine, getPageDetail, identity, jobPageIds,
  pageCandidates, pageLines, seedCompletedJob, seedDistinctPagesJob, seedLlmConnection,
  uniqueName, type PageLine,
} from '../helpers/api'
import { startLlmRead } from '../helpers/llm'
import { LANDSCAPE, openViewer } from '../helpers/viewer'

const DEV = identity('dev', 'admin')

// 'stub-perfect' and 'stub-second' both return the stub runner's own six lines verbatim;
// 'stub-typo' returns the same six with 'Paragraph line 2' misread as 'Paragraf line 2'.
const PERFECT = 'stub-perfect'
const SECOND = 'stub-second'
const TYPO = 'stub-typo'
const DISPUTED = 'Sample Paragraph line 2'
const TYPO_READING = 'Sample Paragraf line 2'

// The identity helpers/api.ts seeds under, which is who a correction made there is by.
const SEEDER = 'e2e-seeder'
// Who the browser is signed in as: the auth service's dev bypass (DEV_USER, 'dev' unless
// set), which is who a correction typed in the editor is by.
const DEV_USER = 'dev'

const HEADER_LINES = ['Sample Header line 1', 'Sample Header line 2', 'Sample Header line 3']
const PARAGRAPH_LINES = ['Sample Paragraph line 1', 'Sample Paragraph line 2', 'Sample Paragraph line 3']
const READING_ORDER = [...HEADER_LINES, ...PARAGRAPH_LINES]

// run_job.py's CONFIDENCES, by line text.
const CONFIDENCES: Record<string, number> = {
  'Sample Header line 1': 0.97, 'Sample Header line 2': 0.92, 'Sample Header line 3': 0.9,
  'Sample Paragraph line 1': 0.55, 'Sample Paragraph line 2': 0.82, 'Sample Paragraph line 3': 0.95,
}

type LineDetail = PageLine & { order_idx: number; confidence: number | null; text_author: string }

interface Element {
  order_idx: number
  class_name: string
  lines: LineDetail[]
}

/** The page's lines as the viewer lists them: elements in order, lines in order. */
async function linesInReadingOrder(jobId: string, pageId: number): Promise<LineDetail[]> {
  const detail = await getPageDetail(jobId, pageId)
  return [...(detail.elements as Element[])]
    .sort((a, b) => a.order_idx - b.order_idx)
    .flatMap((e) => [...e.lines].sort((a, b) => a.order_idx - b.order_idx))
}

const paragraphLines = async (jobId: string, pageId: number): Promise<LineDetail[]> =>
  (await getPageDetail(jobId, pageId)).elements
    .find((e: Element) => e.class_name === 'Paragraph')!.lines

/** What a correction leaves on a line - the three fields every oracle here reads. */
async function settled(jobId: string, pageId: number, lineId: number) {
  const line = (await pageLines(jobId, pageId)).find((l) => l.id === lineId)!
  return { corrected_text: line.corrected_text, checked: line.checked, check_source: line.check_source }
}

/** Open a line's editor from its row, type over it, and save with Enter. */
// Enter saves the text unchecked; Shift+Enter saves and checks it.
async function correctInEditor(page: Page, shown: string, text: string, { check = false } = {}) {
  await page.getByTestId('line-row').filter({ hasText: shown }).getByTestId('line-text').click()
  await page.getByTestId('line-editor').fill(text)
  await page.keyboard.press(check ? 'Shift+Enter' : 'Enter')
}

test.describe('Scenario: the page measuring the model against the people checking it', () => {
  // README: "The page header carries the model's live error rate: CER and WER over the lines
  // a person has checked off, measured against what they settled on, recomputed as each
  // correction lands. Lines language models checked among themselves do not count".
  test('the error rate counts only lines a person checked, and moves without a reload',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Live error rate'), 1, 90)
      const connection = uniqueName('Agreeing pair')
      await seedLlmConnection(connection, [PERFECT, SECOND], DEV)
      await startLlmRead(page, jobId, connection, [PERFECT, SECOND], { minAgree: 2, autocheck: true })

      const [pageId] = await jobPageIds(jobId)
      await expect.poll(async () =>
        (await pageLines(jobId, pageId)).filter((l) => l.checked && l.check_source === 'llm').length,
      { timeout: 20_000 }).toBe(6)

      await openViewer(page, jobId, pageId)
      // Six checked lines, none of them a person's: nothing to measure. The pill is asserted
      // present further down, so a broken selector cannot pass this.
      await expect(page.getByTestId('viewer-header')).toBeVisible()
      await expect(page.getByTestId('line-row')).toHaveCount(6)
      await expect(page.getByTestId('page-error-rate')).toHaveCount(0)

      // One letter swapped: one character error over twenty, one word over four.
      await correctInEditor(page, 'Sample Header line 1', 'Sample Header line X', { check: true })
      const pill = page.getByTestId('page-error-rate')
      await expect(pill).toHaveAttribute('data-lines', '1')
      await expect(pill).toHaveAttribute('data-cer', '0.0500')
      await expect(pill).toHaveAttribute('data-wer', '0.2500')
      await expect(pill).toContainText('CER 5.00%')
      await expect(pill).toContainText('WER 25.00%')

      const corrected = (await pageLines(jobId, pageId)).find((l) => l.text === 'Sample Header line 1')!
      await expect.poll(() => settled(jobId, pageId, corrected.id)).toEqual({
        corrected_text: 'Sample Header line X', checked: true, check_source: null,
      })
      // Read once the correction has landed, so this is what it left behind and not what
      // preceded it: the five nobody touched are still the models'.
      const lines = await pageLines(jobId, pageId)
      expect(lines.filter((l) => l.id !== corrected.id).map((l) => l.check_source))
        .toEqual(['llm', 'llm', 'llm', 'llm', 'llm'])

      // Ticking a line off by hand, exactly as the model read it, makes it a person's at no
      // errors - and its twenty characters now dilute the rate.
      const second = lines.find((l) => l.text === 'Sample Header line 2')!
      const tick = page.getByTestId('line-row').filter({ hasText: 'Sample Header line 2' })
        .getByRole('checkbox')
      await tick.uncheck()
      await expect.poll(() => settled(jobId, pageId, second.id)).toEqual({
        corrected_text: 'Sample Header line 2', checked: false, check_source: null,
      })
      await expect(pill).toHaveAttribute('data-lines', '1')
      await tick.check()
      await expect.poll(() => settled(jobId, pageId, second.id)).toEqual({
        corrected_text: 'Sample Header line 2', checked: true, check_source: null,
      })
      await expect(pill).toHaveAttribute('data-lines', '2')
      await expect(pill).toHaveAttribute('data-cer', '0.0250')
      await expect(pill).toHaveAttribute('data-wer', '0.1250')
      await expect(pill).toContainText('CER 2.50%')
      await expect(pill).toContainText('WER 12.50%')
    })
})

test.describe('Scenario: ordering the lines by how sure the model was', () => {
  // README: "Review tooling: confidence-driven review mode" - the list under the scan is
  // sorted by the line's own confidence, or by the worst or average of its entry.
  test('each sort order puts the lines exactly where the confidences say', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Sort orders'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    // Oracle: the confidences the orders below are derived from are what the stub wrote.
    const lines = await linesInReadingOrder(jobId, pageId)
    expect(Object.fromEntries(lines.map((l) => [l.text, l.confidence]))).toEqual(CONFIDENCES)

    await openViewer(page, jobId, pageId)
    const shown = page.getByTestId('line-text')
    await expect(shown).toHaveText(READING_ORDER)

    const sort = page.getByTitle('Sort the lines')
    // Lowest line confidence first: 0.55, 0.82, 0.90, 0.92, 0.95, 0.97.
    await sort.selectOption('line')
    await expect(shown).toHaveText([
      'Sample Paragraph line 1', 'Sample Paragraph line 2', 'Sample Header line 3',
      'Sample Header line 2', 'Sample Paragraph line 3', 'Sample Header line 1',
    ])
    // By entry, the Paragraph's worst (0.55) is under the Header's (0.90), and its average
    // (0.7733) under the Header's (0.93) - each entry's lines keep their reading order.
    await sort.selectOption('min')
    await expect(shown).toHaveText([...PARAGRAPH_LINES, ...HEADER_LINES])
    await sort.selectOption('avg')
    await expect(shown).toHaveText([...PARAGRAPH_LINES, ...HEADER_LINES])
    await sort.selectOption('reading')
    await expect(shown).toHaveText(READING_ORDER)
  })
})

test.describe('Scenario: the model\'s own read stays one click away', () => {
  // README: "what it displaced takes its place among the choices - so the model's own read
  // is always one click away, named after the model that wrote it, however many times a
  // line has been corrected."
  test('the read is offered under the model\'s name after every correction, and taken back in one click',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Model read offered'), 1, LANDSCAPE)
      const [pageId] = await jobPageIds(jobId)
      const header = (await linesInReadingOrder(jobId, pageId))
        .find((l) => l.text === 'Sample Header line 1')!
      expect(header.text_author).toBe(OCR_AUTHOR)

      await openViewer(page, jobId, pageId)
      const offered = page.getByTestId('line-candidate')
      const expectOnlyTheModelsRead = async () => {
        await expect(offered).toHaveCount(1)
        await expect(offered).toHaveAttribute('data-source', 'ocr')
        await expect(offered).toHaveAttribute('data-author', OCR_AUTHOR)
        await expect(offered.getByTestId('candidate-text')).toHaveText('Sample Header line 1')
        await expect(offered.getByTestId('candidate-reader')).toHaveText(OCR_READER)
      }

      // Nothing is in the pool: the one reading on offer is the model's, dressed as a row.
      let shown = 'Sample Header line 1'
      for (const text of ['Typed by hand', 'Typed over again', 'And once more']) {
        await correctInEditor(page, shown, text)
        await expect.poll(() => settled(jobId, pageId, header.id))
          .toEqual({ corrected_text: text, checked: false, check_source: null })
        await expectOnlyTheModelsRead()
        shown = text
      }

      await offered.getByTestId('accept-candidate').click()
      await expect.poll(() => settled(jobId, pageId, header.id))
        .toEqual({ corrected_text: 'Sample Header line 1', checked: false, check_source: null })
      // What the line says is the line, and is not offered again.
      await expect(page.getByTestId('line-row').filter({ hasText: 'Sample Header line 1' }))
        .toHaveCount(1)
      await expect(offered).toHaveCount(0)
    })
})

test.describe('Scenario: a corrected line is cut in two', () => {
  // README: "splitting or merging destroys line rows; everything they carried - what OCR
  // read, what a person corrected [...] - is kept first, with the geometry it was read
  // from, and re-matched against the new lines afterwards. A correction lands back on
  // whichever line now covers the same place: [...] offered as a candidate to accept where
  // it changed shape."
  test('the correction is kept and offered on the half that overlaps it', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Split correction'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    const before = await paragraphLines(jobId, pageId)
    const first = before.find((l) => l.order_idx === 0)!
    expect(first.text).toBe('Sample Paragraph line 1')
    expect(first.polygon.map((p) => p[0])).toEqual([0.1, 0.9, 0.9, 0.1])
    await correctLine(first.id, 'Corrected by hand', true)

    // Cut at x = 0.6: the left piece is 0.5 of the old 0.8 width, so it overlaps the old
    // box at IoU 0.625 (geometry.iou is polygon-area intersection over union, and the
    // heights are equal) - enough to attach (0.5), not enough to restore (0.9). The right
    // piece, at 0.375, is below the bar and gets nothing.
    await backendFetch(`/api/lines/${first.id}/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cut_x: 0.6 }),
    })

    const after = await paragraphLines(jobId, pageId)
    expect(after).toHaveLength(4)
    const kept = after.find((l) => l.id === first.id)!
    expect(kept).toMatchObject({ text: null, corrected_text: null, checked: false })
    const xs = (line: LineDetail) => line.polygon.map((p) => p[0])
    const nearly = (values: number[]) => values.map((v) => expect.closeTo(v, 6))
    expect(xs(kept)).toEqual(nearly([0.1, 0.6, 0.6, 0.1]))
    const rightHalf = after.find((l) => !before.some((b) => b.id === l.id))!
    expect(xs(rightHalf)).toEqual(nearly([0.6, 0.9, 0.9, 0.6]))

    const held = await pageCandidates(pageId)
    expect(held).toHaveLength(2)
    const human = held.find((c) => c.source === 'human')!
    expect(human).toMatchObject({
      text: 'Corrected by hand', line_id: first.id, checked: true, author: SEEDER, dismissed: false,
    })
    expect(human.similarity).toBeCloseTo(0.625, 5)
    const machine = held.find((c) => c.source === 'ocr')!
    expect(machine).toMatchObject({
      text: 'Sample Paragraph line 1', line_id: first.id, author: OCR_AUTHOR, dismissed: false,
    })
    expect(machine.similarity).toBeCloseTo(0.625, 5)
    expect(held.filter((c) => c.line_id === rightHalf.id)).toHaveLength(0)
    expect(held.filter((c) => c.line_id === null)).toHaveLength(0)

    await openViewer(page, jobId, pageId)
    const rows = page.getByTestId('line-row')
    await expect(rows).toHaveCount(7)
    const at = (await linesInReadingOrder(jobId, pageId)).findIndex((l) => l.id === first.id)
    const row = rows.nth(at)
    await expect(row.getByTestId('line-text')).toHaveText('')
    await row.getByTestId('line-text').click()

    const offered = page.getByTestId('line-candidate')
    await expect(offered).toHaveCount(2)
    const humanRow = page.locator('[data-testid="line-candidate"][data-source="human"]')
    const machineRow = page.locator('[data-testid="line-candidate"][data-source="ocr"]')
    await expect(humanRow).toHaveCount(1)
    await expect(humanRow.getByTestId('candidate-text')).toHaveText('Corrected by hand')
    await expect(humanRow.getByTestId('candidate-reader')).toHaveText(SEEDER)
    await expect(machineRow).toHaveCount(1)
    await expect(machineRow.getByTestId('candidate-text')).toHaveText('Sample Paragraph line 1')
    await expect(machineRow.getByTestId('candidate-reader')).toHaveText(OCR_READER)

    await humanRow.getByTestId('accept-candidate').click()
    await expect.poll(() => settled(jobId, pageId, first.id))
      .toEqual({ corrected_text: 'Corrected by hand', checked: false, check_source: null })
  })
})

test.describe('Scenario: a typed correction displaced by a model\'s reading', () => {
  // README: "A reading dragged onto a line becomes that line, so it is taken off from there
  // rather than from the list - and the correction it displaces joins the list under the
  // person's name, so taking a reading is reversible without retyping."
  test('the typed text is offered back under the person\'s name, and one click restores it',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Displaced correction'), 1, 320)
      const connection = uniqueName('Disagreeing pair')
      await seedLlmConnection(connection, [PERFECT, TYPO], DEV)
      await startLlmRead(page, jobId, connection, [PERFECT, TYPO])

      const [pageId] = await jobPageIds(jobId)
      const disputed = (await pageLines(jobId, pageId)).find((l) => l.text === DISPUTED)!
      await openViewer(page, jobId, pageId)

      await correctInEditor(page, DISPUTED, 'Typed by hand')
      await expect.poll(() => settled(jobId, pageId, disputed.id))
        .toEqual({ corrected_text: 'Typed by hand', checked: false, check_source: null })
      // Both readers' words are on offer under the corrected line: the one that read it
      // as the OCR model did, and the one that did not.
      const offered = page.getByTestId('line-candidate')
      await expect(offered).toHaveCount(2)
      await expect(offered.filter({ hasText: TYPO_READING })).toHaveAttribute('data-source', 'llm')

      await offered.filter({ hasText: TYPO_READING }).getByTestId('accept-candidate').click()
      await expect.poll(() => settled(jobId, pageId, disputed.id))
        .toEqual({ corrected_text: TYPO_READING, checked: false, check_source: null })

      // Oracle: the pool now holds what was typed, on this line, under the person's name.
      await expect.poll(async () =>
        (await pageCandidates(pageId))
          .filter((c) => c.line_id === disputed.id && c.source === 'human')
          .map((c) => ({ text: c.text, author: c.author, dismissed: c.dismissed })),
      ).toEqual([{ text: 'Typed by hand', author: DEV_USER, dismissed: false }])

      // And the list offers it, named after who typed it, beside the other model's word.
      const typed = page.locator('[data-testid="line-candidate"][data-source="human"]')
      await expect(typed).toHaveCount(1)
      await expect(typed.getByTestId('candidate-text')).toHaveText('Typed by hand')
      await expect(typed.getByTestId('candidate-reader')).toHaveText(DEV_USER)
      await expect(offered).toHaveCount(2)
      await expect(offered.filter({ hasText: TYPO_READING })).toHaveCount(0)

      // Taking it back is the same gesture, and lands the line where the person left it.
      await typed.getByTestId('accept-candidate').click()
      await expect.poll(() => settled(jobId, pageId, disputed.id))
        .toEqual({ corrected_text: 'Typed by hand', checked: false, check_source: null })
      await expect(typed).toHaveCount(0)
      await expect(offered.filter({ hasText: TYPO_READING })).toHaveCount(1)
    })
})

test.describe('Scenario: a typed correction reverted to the OCR text', () => {
  // README: "Reverting a line to its OCR text offers the typed correction back the same way,
  // under the person's name."
  test('the typed text is offered back under the person\'s name, and one click restores it',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Reverted correction'), 1, LANDSCAPE)
      const [pageId] = await jobPageIds(jobId)
      const header = (await linesInReadingOrder(jobId, pageId))
        .find((l) => l.text === 'Sample Header line 1')!
      await openViewer(page, jobId, pageId)

      await correctInEditor(page, 'Sample Header line 1', 'Typed by hand')
      await expect.poll(() => settled(jobId, pageId, header.id))
        .toEqual({ corrected_text: 'Typed by hand', checked: false, check_source: null })

      await page.getByTestId('line-row').filter({ hasText: 'Typed by hand' })
        .getByTitle('Revert to OCR text').click()
      await expect.poll(() => settled(jobId, pageId, header.id))
        .toEqual({ corrected_text: null, checked: false, check_source: null })

      await expect.poll(async () =>
        (await pageCandidates(pageId))
          .filter((c) => c.line_id === header.id && c.source === 'human')
          .map((c) => ({ text: c.text, author: c.author, dismissed: c.dismissed })),
      ).toEqual([{ text: 'Typed by hand', author: DEV_USER, dismissed: false }])

      const offered = page.getByTestId('line-candidate')
      const typed = page.locator('[data-testid="line-candidate"][data-source="human"]')
      await expect(offered).toHaveCount(1)
      await expect(typed).toHaveCount(1)
      await expect(typed.getByTestId('candidate-text')).toHaveText('Typed by hand')
      await expect(typed.getByTestId('candidate-reader')).toHaveText(DEV_USER)

      await typed.getByTestId('accept-candidate').click()
      await expect.poll(() => settled(jobId, pageId, header.id))
        .toEqual({ corrected_text: 'Typed by hand', checked: false, check_source: null })
      await expect(typed).toHaveCount(0)
      await expect(offered.filter({ hasText: 'Sample Header line 1' })).toHaveCount(1)
    })
})
