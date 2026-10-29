import { test, expect } from '../helpers/test'
import {
  backendFetch, getPageDetail, identity, jobPageIds, pageLines, seedDistinctPagesJob,
  seedLlmConnection, uniqueName, type PageLine,
} from '../helpers/api'
import { startLlmRead } from '../helpers/llm'
import { openViewer } from '../helpers/viewer'

const DEV = identity('dev', 'admin')

// Both return the stub runner's own six lines verbatim, so with two voices required every
// line on the page settles - and the dialog's autocheck box is left alone, so none is checked.
const PERFECT = 'stub-perfect'
const SECOND = 'stub-second'

// The six lines, in the order every page is read in. run_job.py's confidences put only the
// first two Paragraph lines (0.55, 0.82) under the 0.85 bar.
const STUB_LINES = ['Header', 'Paragraph']
  .flatMap((cls) => [1, 2, 3].map((i) => `Sample ${cls} line ${i}`))

type LineDetail = PageLine & { order_idx: number }

interface Element {
  order_idx: number
  lines: LineDetail[]
}

/** The page's lines as the viewer lists them: elements in order, lines in order. */
async function linesInReadingOrder(jobId: string, pageId: number): Promise<LineDetail[]> {
  const detail = await getPageDetail(jobId, pageId)
  return [...(detail.elements as Element[])]
    .sort((a, b) => a.order_idx - b.order_idx)
    .flatMap((e) => [...e.lines].sort((a, b) => a.order_idx - b.order_idx))
}

/** What the review button and review mode walk: the job-wide queue under the 0.85 bar. */
function reviewQueue(jobId: string): Promise<{ total: number; lines: { id: number; page_id: number }[] }> {
  return backendFetch(`/api/jobs/${jobId}/review?max_conf=0.85`)
}

test.describe('Scenario: lines the models settled without a check', () => {
  // README: "A line the models settled among themselves without a check is flagged like any
  // other unchecked line, badged as settled, so agreement without autocheck is review work
  // rather than a silent pass." And once a person checks such a line "it is theirs and no
  // longer counts as settled by models".
  test('they are the review queue, badged as settled, until a person checks them off',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Settled review'), 1, 310)
      const connection = uniqueName('Agreeing pair')
      await seedLlmConnection(connection, [PERFECT, SECOND], DEV)
      await startLlmRead(page, jobId, connection, [PERFECT, SECOND], { minAgree: 2 })

      const [pageId] = await jobPageIds(jobId)
      await expect.poll(async () =>
        (await pageLines(jobId, pageId)).filter((l) => l.corrected_text !== null).length,
      { timeout: 20_000 }).toBe(6)
      // Settled by agreement and nobody's: the text is filled in, the check is not.
      const lines = await linesInReadingOrder(jobId, pageId)
      expect(lines.map((l) => ({
        text: l.text, corrected_text: l.corrected_text, corrected_by: l.corrected_by,
        checked: l.checked, check_source: l.check_source, llm_agree_count: l.llm_agree_count,
      }))).toEqual(STUB_LINES.map((text) => ({
        text, corrected_text: text, corrected_by: 'llm:consensus@2',
        checked: false, check_source: null, llm_agree_count: 2,
      })))

      // A person ticks the first one off as it stands: that line is theirs, and done with.
      const [approved, ...unchecked] = lines
      await backendFetch(`/api/lines/${approved.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checked: true }),
      })
      await expect.poll(async () => {
        const line = (await pageLines(jobId, pageId)).find((l) => l.id === approved.id)!
        return { checked: line.checked, check_source: line.check_source }
      }).toEqual({ checked: true, check_source: null })

      // Oracle: the queue is every settled line nobody has checked, however sure the OCR
      // model was of it - and not the one a person approved.
      const queue = await reviewQueue(jobId)
      expect(queue.lines.map((l) => l.id)).toEqual(unchecked.map((l) => l.id))
      expect(queue.total).toBe(5)

      await page.goto(`/jobs/${jobId}`)
      await page.getByRole('button', { name: 'Review 5 flagged' }).click()
      await expect(page).toHaveURL(new RegExp(`/pages/${pageId}\\?review=0.85$`))
      await expect(page.getByText(/Review 1 \/ 5/)).toBeVisible()
      const rows = page.getByTestId('line-row')
      await expect(rows).toHaveCount(5)
      await expect(rows.filter({ hasText: 'Sample Header line 1' })).toHaveCount(0)
      await expect(rows.filter({ hasText: 'Sample Header line 2' })).toHaveAttribute('data-hot', 'true')
      // Each flagged row says why it is here.
      for (const text of STUB_LINES.slice(1)) {
        await expect(rows.filter({ hasText: text }).getByTestId('settled-badge')).toBeVisible()
      }

      // The keys walk all five, as they walk any flagged line.
      await page.mouse.move(2, 2)
      await expect(page.getByTestId('line-loupe')).toBeVisible()
      for (let at = 2; at <= 5; at++) {
        await page.keyboard.press('ArrowDown')
        await expect(page.getByText(new RegExp(`Review ${at} / 5`))).toBeVisible()
      }
      await expect(rows.filter({ hasText: 'Sample Paragraph line 3' })).toHaveAttribute('data-hot', 'true')

      // Outside review mode the badge tells the settled lines from the one a person approved.
      await openViewer(page, jobId, pageId)
      await expect(rows).toHaveCount(6)
      await expect(page.getByTestId('settled-badge')).toHaveCount(5)
      await expect(rows.filter({ hasText: 'Sample Header line 1' }).getByTestId('settled-badge')).toHaveCount(0)
      await expect(rows.filter({ hasText: 'Sample Header line 2' }).getByTestId('settled-badge')).toBeVisible()

      // The badge is also the way back: it hands the line the OCR model's text again.
      const settled = unchecked[0]
      await rows.filter({ hasText: 'Sample Header line 2' }).getByTestId('settled-badge').click()
      await expect.poll(async () => {
        const line = (await pageLines(jobId, pageId)).find((l) => l.id === settled.id)!
        return { corrected_text: line.corrected_text, checked: line.checked }
      }).toEqual({ corrected_text: null, checked: false })
      await expect(page.getByTestId('settled-badge')).toHaveCount(4)
    })
})
