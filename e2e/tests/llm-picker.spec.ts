import { test, expect } from '../helpers/test'
import {
  backendFetch, identity, jobPageIds, pageCandidates, pageLines, resetLlmStats,
  seedDistinctPagesJob, seedLlmConnection, uniqueName,
} from '../helpers/api'
import { startLlmRead } from '../helpers/llm'
import { openViewer } from '../helpers/viewer'

const DEV = identity('dev', 'admin')
const PERFECT = 'stub-perfect'
const SECOND = 'stub-second'
const TYPO = 'stub-typo'
// The same words in the two Unicode forms a provider may answer in.
const COMPOSED = 'stub-composed'
const DECOMPOSED = 'stub-decomposed'

const DISPUTED = 'Sample Paragraph line 2'
const TYPO_READING = 'Sample Paragraf line 2'

test.describe('Scenario: choosing between what the readers said', () => {
  test('every reading of a line is offered, and one click makes it the correction',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Picker'), 1)
      const connection = uniqueName('Disagreeing pair')
      await seedLlmConnection(connection, [PERFECT, TYPO], DEV)
      await resetLlmStats()
      await startLlmRead(page, jobId, connection, [PERFECT, TYPO])

      const [pageId] = await jobPageIds(jobId)
      const disputed = (await pageLines(jobId, pageId)).find((l) => l.text === DISPUTED)!
      await openViewer(page, jobId, pageId)

      const row = page.getByTestId('line-row').filter({ hasText: DISPUTED })
      await row.click()

      // Only what the line does not already say is offered: one model read it as the page
      // has it, and that reading is the line itself rather than a choice to make.
      const candidates = page.getByTestId('line-candidate')
      await expect(candidates).toHaveCount(1)
      await expect(candidates.filter({ hasText: DISPUTED })).toHaveCount(0)
      await expect(candidates.filter({ hasText: TYPO_READING })).toHaveAttribute('data-source', 'llm')
      // Which reader said it: models disagreeing is only useful if they are named.
      await expect(candidates.filter({ hasText: TYPO_READING }).getByTestId('candidate-reader'))
        .toHaveText(`${connection} ${TYPO}`)
      await expect(candidates.filter({ hasText: TYPO_READING }).getByTestId('candidate-reader'))
        .toHaveAttribute('title', `llm:${connection} ${TYPO}`)
      // Models are told apart by reading them side by side, so neither the reading nor a
      // long reader name is cut short: what does not fit wraps.
      for (const id of ['candidate-text', 'candidate-reader']) {
        const shown = candidates.filter({ hasText: TYPO_READING }).getByTestId(id)
        expect(await shown.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0)
      }

      // Who read it is the right-hand column, so every reading starts at the same edge and
      // the column can be read straight down against the line's own text.
      const typo = candidates.filter({ hasText: TYPO_READING })
      const reading = (await typo.locator('[data-testid="candidate-reader"]').boundingBox())!
      const text = (await typo.getByTestId('candidate-text').boundingBox())!
      expect(reading.x).toBeGreaterThanOrEqual(Math.floor(text.x + text.width))

      // And the odd reading out points at the character it differs in rather than lighting
      // up the whole word: Paragraph against Paragraf parts at the last letter.
      await expect(typo.locator('[data-changed]')).toHaveText('f')
      await expect(candidates.filter({ hasText: DISPUTED }).locator('[data-changed]'))
        .toHaveCount(0)

      await candidates.filter({ hasText: TYPO_READING }).getByTestId('accept-candidate').click()

      // Backend oracle: choosing is the same as typing it - corrected, not yet checked, and
      // recorded as a person's doing rather than the models'.
      await expect.poll(async () =>
        (await pageLines(jobId, pageId)).find((l) => l.id === disputed.id),
      ).toMatchObject({
        corrected_text: TYPO_READING, checked: false, check_source: null,
      })

      // And they have swapped: the reading taken is the line now, so it is no longer one
      // of the choices, and what it displaced has taken its place among them.
      await expect(candidates.filter({ hasText: TYPO_READING })).toHaveCount(0)
      await expect(candidates.filter({ hasText: DISPUTED })).toHaveCount(1)

      // Putting it back is the same gesture again, and lands the line where it started.
      await candidates.filter({ hasText: DISPUTED }).getByTestId('accept-candidate').click()
      await expect.poll(async () =>
        (await pageLines(jobId, pageId)).find((l) => l.id === disputed.id)!.corrected_text,
      ).toBe(DISPUTED)
      await expect(candidates.filter({ hasText: TYPO_READING })).toHaveCount(1)
      await expect(candidates.filter({ hasText: DISPUTED })).toHaveCount(0)
    })

  test('where the models agree is marked, and marked louder where the OCR model differs',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Badges'), 1)
      const connection = uniqueName('Agreeing pair')
      await seedLlmConnection(connection, [PERFECT, 'stub-second'], DEV)
      await resetLlmStats()
      await startLlmRead(page, jobId, connection, [PERFECT, 'stub-second'])

      const [pageId] = await jobPageIds(jobId)
      await openViewer(page, jobId, pageId)

      // Both models read all six lines the same way as the OCR model did, so every line
      // is badged and none of them is in dispute.
      await expect(page.getByTestId('agree-badge')).toHaveCount(6)
      await expect(page.getByTestId('agree-badge').first()).toHaveText('2×')
      await expect(page.locator('[data-testid="agree-badge"][data-disputed="true"]')).toHaveCount(0)

      // A line the models read differently from the OCR model is called out.
      const first = (await pageLines(jobId, pageId))[0]
      await backendFetch(`/api/lines/${first.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...DEV },
        body: JSON.stringify({ corrected_text: 'Something else entirely', checked: false }),
      })
      await page.reload()
      await expect(page.locator('[data-testid="agree-badge"][data-disputed="true"]')).toHaveCount(1)
    })

  test('a reading that matches no line says so rather than disappearing', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Unmatched'), 1)
    const connection = uniqueName('Extra reader')
    // 'stub-extra' returns the six lines plus one the segmentation never found.
    await seedLlmConnection(connection, ['stub-extra'], DEV)
    await resetLlmStats()
    await startLlmRead(page, jobId, connection, ['stub-extra'])

    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)

    await expect(page.getByTestId('unmatched-readings'))
      .toContainText('1 reading matched no line')
    // It is held, not lost: the pool still has it, waiting for a line to be drawn.
    const unplaced = (await backendFetch(`/api/pages/${pageId}/candidates`, { headers: DEV }))
      .candidates.filter((c: { line_id: number | null }) => c.line_id === null)
    expect(unplaced.map((c: { text: string }) => c.text)).toEqual(['Marginal note the segmenter missed'])
  })

  test('the arrows walk into a line\'s readings, and Enter takes the one they rest on',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Arrow keys'), 1)
      const connection = uniqueName('Disagreeing pair')
      await seedLlmConnection(connection, [PERFECT, TYPO], DEV)
      await resetLlmStats()
      await startLlmRead(page, jobId, connection, [PERFECT, TYPO])

      const [pageId] = await jobPageIds(jobId)
      const disputed = (await pageLines(jobId, pageId)).find((l) => l.text === DISPUTED)!
      await openViewer(page, jobId, pageId)

      // Down from nothing lands on the first line, and keeps walking into the readings of
      // whichever line it is on. The odd reader out said this once on the whole page, so
      // the cursor arriving on it is unambiguous.
      const onReading = page.locator('[data-testid="line-candidate"][data-cursor="true"]')
      await expect(onReading).toHaveCount(0)
      const reached = async () =>
        (await onReading.count()) === 1
        && (await onReading.getByTestId('candidate-text').innerText()).trim() === TYPO_READING
      for (let press = 0; press < 40 && !(await reached()); press++) {
        await page.keyboard.press('ArrowDown')
      }
      await expect(onReading.getByTestId('candidate-text')).toHaveText(TYPO_READING)

      await page.keyboard.press('Enter')

      // Enter on a reading is clicking it: that text becomes the line's correction, and
      // only that line's - the arrows never left it.
      await expect.poll(async () =>
        (await pageLines(jobId, pageId)).find((l) => l.id === disputed.id)!.corrected_text)
        .toBe(TYPO_READING)
    })

  test('the arrows take the keyboard back from the button that was last clicked',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Arrow focus'), 1)
      const connection = uniqueName('Disagreeing pair')
      await seedLlmConnection(connection, [PERFECT, TYPO], DEV)
      await resetLlmStats()
      await startLlmRead(page, jobId, connection, [PERFECT, TYPO])

      const [pageId] = await jobPageIds(jobId)
      const disputed = (await pageLines(jobId, pageId)).find((l) => l.text === DISPUTED)!
      await openViewer(page, jobId, pageId)

      // Everything in the header is a button, and clicking one leaves the keyboard on it.
      // Once the arrows are walking the lines, the keyboard belongs to the list: Enter has
      // to take the reading under the cursor rather than press the header again.
      await page.getByRole('button', { name: 'Labels' }).click()

      const onReading = page.locator('[data-testid="line-candidate"][data-cursor="true"]')
      await expect(onReading).toHaveCount(0)
      const reached = async () =>
        (await onReading.count()) === 1
        && (await onReading.getByTestId('candidate-text').innerText()).trim() === TYPO_READING
      for (let press = 0; press < 40 && !(await reached()); press++) {
        await page.keyboard.press('ArrowDown')
      }
      await expect(onReading.getByTestId('candidate-text')).toHaveText(TYPO_READING)

      await page.keyboard.press('Enter')

      await expect.poll(async () =>
        (await pageLines(jobId, pageId)).find((l) => l.id === disputed.id)!.corrected_text)
        .toBe(TYPO_READING)
    })

  test('the badge says what each reader made of the line, and where they part',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Readings'), 1)
      const connection = uniqueName('Trio')
      await seedLlmConnection(connection, [PERFECT, SECOND, TYPO], DEV)
      await resetLlmStats()
      await startLlmRead(page, jobId, connection, [PERFECT, SECOND, TYPO])

      const [pageId] = await jobPageIds(jobId)
      const disputed = (await pageLines(jobId, pageId)).find((l) => l.text === DISPUTED)!
      await openViewer(page, jobId, pageId)

      await page.getByTestId('line-row').filter({ hasText: DISPUTED })
        .getByTestId('agree-badge').hover()

      const readings = page.getByTestId('line-readings')
      const of = (reader: string) =>
        readings.locator(`[data-testid="line-reading"][data-reader="${reader}"]`)
      // Three models and the local OCR, each with what it read.
      await expect(readings.getByTestId('line-reading')).toHaveCount(4)
      await expect(of(`${connection} ${TYPO}`)).toContainText(TYPO_READING)
      await expect(of(`${connection} ${PERFECT}`)).toContainText(DISPUTED)
      await expect(of(`${connection} ${SECOND}`)).toContainText(DISPUTED)
      await expect(of('OCR')).toContainText(DISPUTED)

      // Only the character the odd reader out got wrong is marked, and only on its row:
      // Paragraph against Paragraf parts at the last letter, so that is what lights up.
      await expect(of(`${connection} ${TYPO}`).locator('[data-changed]')).toHaveText('f')
      await expect(of(`${connection} ${PERFECT}`).locator('[data-changed]')).toHaveCount(0)
      await expect(of('OCR').locator('[data-changed]')).toHaveCount(0)

      // Oracle: those are the readings the pool actually holds for that line.
      const held = (await pageCandidates(pageId)).filter((c) => c.line_id === disputed.id)
      expect(held.map((c) => c.text).sort()).toEqual([DISPUTED, DISPUTED, TYPO_READING].sort())
    })

  test('readers spelling the same word in different Unicode forms are not shown as differing',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Forms'), 1)
      const connection = uniqueName('Both forms')
      await seedLlmConnection(connection, [COMPOSED, DECOMPOSED], DEV)
      await resetLlmStats()
      await startLlmRead(page, jobId, connection, [COMPOSED, DECOMPOSED])

      const [pageId] = await jobPageIds(jobId)
      await openViewer(page, jobId, pageId)

      await page.getByTestId('line-row').filter({ hasText: 'Header line 1' })
        .getByTestId('agree-badge').hover()

      const readings = page.getByTestId('line-readings')
      const of = (reader: string) =>
        readings.locator(`[data-testid="line-reading"][data-reader="${reader}"]`)
      // They agreed - the backend settled it - so neither may be marked against the other.
      await expect(of(`${connection} ${COMPOSED}`).locator('[data-changed]')).toHaveCount(0)
      await expect(of(`${connection} ${DECOMPOSED}`).locator('[data-changed]')).toHaveCount(0)
      // A real difference on the same row is still marked: the OCR model read no umlaut,
      // and the single letter it read instead is what carries the mark.
      await expect(of('OCR').locator('[data-changed]')).toHaveText('a')
    })
})
