import { test, expect } from '../helpers/test'
import { getPageDetail, jobPageIds, markLinesChecked, seedCompletedJob, uniqueName } from '../helpers/api'
import { LANDSCAPE, openViewer } from '../helpers/viewer'

async function seedReview(pageCount = 1) {
  const jobId = await seedCompletedJob(uniqueName('Review'), pageCount, LANDSCAPE)
  const pageIds = await jobPageIds(jobId)
  return { jobId, pageIds }
}

const paragraphLine = async (jobId: string, pageId: number, orderIdx: number) =>
  (await getPageDetail(jobId, pageId)).elements
    .find((e: { class_name: string }) => e.class_name === 'Paragraph')
    .lines.find((l: { order_idx: number }) => l.order_idx === orderIdx)

test.describe('Scenario: reviewing OCR text', () => {
  test('correcting a line with typed text and a palette glyph, then reverting hands it back for review',
    async ({ page }) => {
      const { jobId, pageIds } = await seedReview()
      await openViewer(page, jobId, pageIds[0])
      const stateOf = async () => {
        const line = await paragraphLine(jobId, pageIds[0], 0)
        return { corrected_text: line.corrected_text?.normalize('NFC') ?? null, checked: line.checked }
      }

      await page.getByText('Sample Paragraph line 1', { exact: true }).click()
      const editor = page.getByTestId('line-editor')
      await editor.fill('Grüße from e2e')
      await page.getByTitle('Insert ä', { exact: true }).click()
      await page.keyboard.press('Enter')

      // Saving is not a review: the correction lands unchecked, and checking it is a click.
      await expect(page.getByText('edited', { exact: true })).toBeVisible()
      await expect.poll(stateOf).toEqual({ corrected_text: 'Grüße from e2eä', checked: false })
      const corrected = page.getByTestId('line-row').filter({ has: page.getByTitle('Revert to OCR text') })
      await expect(corrected.getByRole('checkbox')).not.toBeChecked()
      await corrected.getByRole('checkbox').check()
      await expect.poll(stateOf).toEqual({ corrected_text: 'Grüße from e2eä', checked: true })

      await corrected.getByTestId('edited-badge').click()
      await expect(page.getByText('edited', { exact: true })).not.toBeVisible()
      // README: "Reverting hands the line back for review: the check goes with the
      // correction, and approving the OCR text as it stands is a second, explicit click."
      // A revert withdraws the person's judgement; it is not an approval of the OCR text.
      await expect.poll(stateOf).toEqual({ corrected_text: null, checked: false })
      const reverted = page.getByTestId('line-row').filter({ hasText: 'Sample Paragraph line 1' })
      await expect(reverted.getByRole('checkbox')).not.toBeChecked()

      // The second, explicit click is what checks the OCR text off.
      await reverted.getByRole('checkbox').check()
      await expect.poll(stateOf).toEqual({ corrected_text: null, checked: true })
      await expect(reverted.getByRole('checkbox')).toBeChecked()
    })

  test('escape leaves the editor without throwing the edit away', async ({ page }) => {
    const { jobId, pageIds } = await seedReview()
    await openViewer(page, jobId, pageIds[0])

    await page.getByText('Sample Paragraph line 1', { exact: true }).click()
    const editor = page.getByTestId('line-editor')
    await expect(editor).toBeVisible()
    await editor.fill('Typed, then escaped')
    await page.keyboard.press('Escape')

    await expect(editor).toHaveCount(0)
    await expect.poll(async () => (await paragraphLine(jobId, pageIds[0], 0)).corrected_text)
      .toBe('Typed, then escaped')
    // Escape left the editor, not the page: one press does not also walk out of the scan.
    await expect(page).toHaveURL(new RegExp(`/pages/${pageIds[0]}$`))
  })

  test('shift+enter checks the active line and advances to the next', async ({ page }) => {
    const { jobId, pageIds } = await seedReview()
    await openViewer(page, jobId, pageIds[0])

    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Shift+Enter')

    await expect
      .poll(async () => {
        const detail = await getPageDetail(jobId, pageIds[0])
        const header = detail.elements.find((e: { class_name: string }) => e.class_name === 'Header')
        return header.lines.find((l: { order_idx: number }) => l.order_idx === 0).checked
      })
      .toBe(true)
    await expect(
      page.getByTestId('line-row').filter({ hasText: 'Sample Header line 2' }),
    ).toHaveAttribute('data-hot', 'true')
  })

  test('shift+enter out of the editor saves, checks and moves on in one press',
    async ({ page }) => {
      const { jobId, pageIds } = await seedReview()
      await openViewer(page, jobId, pageIds[0])
      const stateOf = async (orderIdx: number) => {
        const line = await paragraphLine(jobId, pageIds[0], orderIdx)
        return { text: line.corrected_text, checked: line.checked }
      }
      const editor = page.getByTestId('line-editor')

      await page.getByText('Sample Paragraph line 1', { exact: true }).click()
      await expect(editor).toBeVisible()
      await editor.fill('Corrected and done with')
      await page.keyboard.press('Shift+Enter')

      // One press is the whole gesture. It used to take two: the first only closed the
      // editor, because the key never reached the list behind it.
      await expect(editor).toHaveCount(0)
      await expect.poll(() => stateOf(0))
        .toEqual({ text: 'Corrected and done with', checked: true })
      await expect(page.getByTestId('line-row').filter({ hasText: 'Sample Paragraph line 2' }))
        .toHaveAttribute('data-hot', 'true')

      // A line the OCR already had right is the same gesture with nothing typed: it is
      // checked off as it stands, which a save alone would never do.
      expect(await stateOf(1)).toEqual({ text: null, checked: false })
      await page.getByText('Sample Paragraph line 2', { exact: true }).click()
      await expect(editor).toBeVisible()
      await page.keyboard.press('Shift+Enter')

      await expect.poll(() => stateOf(1)).toEqual({ text: null, checked: true })
      await expect(page.getByTestId('line-row').filter({ hasText: 'Sample Paragraph line 3' }))
        .toHaveAttribute('data-hot', 'true')
    })

  test('shift+enter on a line somebody already checked leaves it checked, and moves on',
    async ({ page }) => {
      const { jobId, pageIds } = await seedReview()
      // The first line in reading order was checked earlier - by alignment, a colleague,
      // or a previous sitting.
      expect(await markLinesChecked(jobId, 1)).toBe(1)
      const headerLine = async (orderIdx: number) =>
        (await getPageDetail(jobId, pageIds[0])).elements
          .find((e: { class_name: string }) => e.class_name === 'Header')
          .lines.find((l: { order_idx: number }) => l.order_idx === orderIdx)
      expect((await headerLine(0)).checked).toBe(true)

      await openViewer(page, jobId, pageIds[0])
      await page.mouse.move(2, 2)
      await page.keyboard.press('ArrowDown')
      await expect(page.getByTestId('line-row').filter({ hasText: 'Sample Header line 1' }))
        .toHaveAttribute('data-hot', 'true')
      await page.keyboard.press('Shift+Enter')
      await expect(page.getByTestId('line-row').filter({ hasText: 'Sample Header line 2' }))
        .toHaveAttribute('data-hot', 'true')

      // Done with the next line too. Its check is written after whatever the first press
      // wrote, so once it has landed the first line's state is settled.
      await page.keyboard.press('Shift+Enter')
      await expect.poll(async () => (await headerLine(1)).checked).toBe(true)
      await expect(page.getByTestId('line-row').filter({ hasText: 'Sample Header line 3' }))
        .toHaveAttribute('data-hot', 'true')
      // "Have done with" is not "undo": the line stays checked off.
      expect((await headerLine(0)).checked).toBe(true)
    })

  test('checking off the last line carries on to the next page', async ({ page }) => {
    const { jobId, pageIds } = await seedReview(2)
    const linesOf = async (pageId: number): Promise<{ id: number; checked: boolean }[]> =>
      (await getPageDetail(jobId, pageId)).elements
        .flatMap((e: { lines: { id: number; checked: boolean }[] }) => e.lines)

    await openViewer(page, jobId, pageIds[0])
    const onFirst = await linesOf(pageIds[0])
    expect(onFirst.length).toBeGreaterThan(1)

    // Walk the page: one Shift+Enter per line, the last of which has nowhere left to go.
    await page.keyboard.press('ArrowDown')
    for (let i = 0; i < onFirst.length; i++) await page.keyboard.press('Shift+Enter')

    await expect(page).toHaveURL(new RegExp(`/pages/${pageIds[1]}$`))
    // Backend oracle: the whole page was checked off on the way through.
    await expect
      .poll(async () => (await linesOf(pageIds[0])).every((l) => l.checked))
      .toBe(true)

    // And the next page arrives with its first line already focused, ready to type.
    await expect(page.getByTestId('line-row').first()).toHaveAttribute('data-hot', 'true')
    await expect(page.getByTestId('line-row').filter({ hasText: 'Sample Header line 1' }))
      .toHaveAttribute('data-hot', 'true')
  })

  test('the last page has nowhere to go, and stays put', async ({ page }) => {
    const { jobId, pageIds } = await seedReview(1)
    await openViewer(page, jobId, pageIds[0])
    const total = (await getPageDetail(jobId, pageIds[0])).elements
      .flatMap((e: { lines: unknown[] }) => e.lines).length

    await page.keyboard.press('ArrowDown')
    for (let i = 0; i < total + 1; i++) await page.keyboard.press('Shift+Enter')

    await expect(page).toHaveURL(new RegExp(`/pages/${pageIds[0]}$`))
    await expect(page.getByTestId('line-row').last()).toHaveAttribute('data-hot', 'true')
  })

  test('review mode walks flagged lines across page boundaries', async ({ page }) => {
    const { jobId, pageIds } = await seedReview(2)
    await page.goto(`/jobs/${jobId}`)

    // 2 Paragraph lines per page sit under the 0.85 threshold.
    await page.getByRole('button', { name: 'Review 4 flagged' }).click()
    await expect(page).toHaveURL(new RegExp(`/pages/${pageIds[0]}\\?review=0.85$`))
    await expect(page.getByText(/Review 1 \/ 4/)).toBeVisible()
    // Park the cursor so hover cannot fake the highlight, then wait until review
    // mode has activated the first flagged line - keystrokes before that get lost.
    await page.mouse.move(2, 2)
    await expect(
      page.getByTestId('line-row').filter({ hasText: 'Sample Paragraph line 1' }),
    ).toHaveAttribute('data-hot', 'true')
    // Arrow keys stay inert until the viewer leaves its brief 'enter' stage, and the
    // active line lights up before that. The loupe mounts on the same condition, so
    // wait for it - openViewer() waits on it for exactly this reason.
    await expect(page.getByTestId('line-loupe')).toBeVisible()

    await page.keyboard.press('ArrowDown')
    await expect(page.getByText(/Review 2 \/ 4/)).toBeVisible()

    await page.keyboard.press('ArrowDown')
    await expect(page).toHaveURL(new RegExp(`/pages/${pageIds[1]}\\?review=0.85$`))
    await expect(page.getByText(/Review 3 \/ 4/)).toBeVisible()

    // Tightening the threshold shrinks the queue to the 0.55 lines only.
    await page.locator('header').getByTitle('Confidence threshold').selectOption('0.7')
    await expect(page).toHaveURL(/review=0\.7$/)
    await expect(page.getByText(/Review \d \/ 2/)).toBeVisible()
  })
})
