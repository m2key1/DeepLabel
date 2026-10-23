import { test, expect } from '../helpers/test'
import {
  correctLine, getPageDetail, jobPageIds, pageCandidates, redetectLines, seedCompletedJob,
  setElementBbox, setElementClass, uniqueName, waitForJobStatus,
} from '../helpers/api'

// The stub layout puts a Paragraph element at these coordinates on every page, and its
// three lines are derived from the box - so resizing the box is how a scenario controls
// how far re-detected lines land from the ones a person corrected.
const PARAGRAPH = [0.1, 0.2, 0.9, 0.85]
// x1 pulled in by 0.02: past the staleness threshold, but the new lines still cover
// almost exactly what the old ones did (IoU about 0.97).
const BARELY_MOVED = [0.1, 0.2, 0.88, 0.85]
// x1 pulled in to 0.55: the new lines cover a little over half of the old ones.
const RESHAPED = [0.1, 0.2, 0.55, 0.85]

async function paragraphOf(jobId: string, pageId: number) {
  const detail = await getPageDetail(jobId, pageId)
  return detail.elements.find((e: { class_name: string }) => e.class_name === 'Paragraph')!
}

test.describe('Scenario: re-detecting lines under a corrected element', () => {
  test('a correction survives re-detection and comes back verified when the line barely moved',
    async ({ page: _page }) => {
      const jobId = await seedCompletedJob(uniqueName('Redetect keeps'), 1)
      const [pageId] = await jobPageIds(jobId)
      const paragraph = await paragraphOf(jobId, pageId)
      expect(paragraph.bbox).toEqual(PARAGRAPH)

      const first = paragraph.lines[0]
      expect(first.text).toBe('Sample Paragraph line 1')
      await correctLine(first.id, 'Corrected by hand')

      await setElementBbox(paragraph.id, BARELY_MOVED)
      await redetectLines(jobId, pageId)
      await waitForJobStatus(jobId, 'done')

      // Fresh line rows, so the id is gone - what must survive is the text on the line
      // that now covers the same part of the page.
      const after = await paragraphOf(jobId, pageId)
      expect(after.lines).toHaveLength(3)
      expect(after.lines[0].id).not.toBe(first.id)
      expect(after.lines[0]).toMatchObject({
        text: 'Sample Paragraph line 1',
        corrected_text: 'Corrected by hand',
        checked: true,
      })
    })

  test('a correction whose line was reshaped is offered, not silently re-verified',
    async ({ page: _page }) => {
      const jobId = await seedCompletedJob(uniqueName('Redetect reshapes'), 1)
      const [pageId] = await jobPageIds(jobId)
      const paragraph = await paragraphOf(jobId, pageId)

      const first = paragraph.lines[0]
      await correctLine(first.id, 'Corrected by hand')

      await setElementBbox(paragraph.id, RESHAPED)
      await redetectLines(jobId, pageId)
      await waitForJobStatus(jobId, 'done')

      const after = await paragraphOf(jobId, pageId)
      // The crop a training pair would be cut from is not the one anyone approved, so
      // the line comes back unverified and uncorrected...
      expect(after.lines[0]).toMatchObject({ corrected_text: null, checked: false })

      // ...but the text itself is kept, attached to that line as a candidate.
      const candidates = await pageCandidates(pageId)
      const human = candidates.filter((c) => c.source === 'human')
      expect(human).toHaveLength(1)
      expect(human[0]).toMatchObject({
        text: 'Corrected by hand', line_id: after.lines[0].id, checked: true,
      })
    })
})

test.describe('Scenario: asking for a re-detection from the dataset page', () => {
  test('the dialog promises the corrections are kept, and they are', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Redetect dialog'), 1)
    const [pageId] = await jobPageIds(jobId)
    const paragraph = await paragraphOf(jobId, pageId)
    await correctLine(paragraph.lines[0].id, 'Corrected by hand')
    await correctLine(paragraph.lines[1].id, 'Also corrected')
    await setElementBbox(paragraph.id, BARELY_MOVED)

    await page.goto(`/jobs/${jobId}`)
    await page.getByRole('button', { name: /Re-detect lines \(1\)/ }).click()
    await expect(page.getByTestId('redetect-corrections'))
      .toContainText('2 correction(s) inside those boxes are kept and re-attached')
    await page.getByRole('button', { name: 'Re-detect', exact: true }).click()

    await waitForJobStatus(jobId, 'done')
    const after = await paragraphOf(jobId, pageId)
    expect(after.lines.map((l: { corrected_text: string | null }) => l.corrected_text))
      .toEqual(['Corrected by hand', 'Also corrected', null])
    expect(after.lines.map((l: { checked: boolean }) => l.checked)).toEqual([true, true, false])
  })
})

test.describe('Scenario: a line read twice by the model', () => {
  test('the newer reading replaces the older one rather than joining it', async ({ page: _page }) => {
    const jobId = await seedCompletedJob(uniqueName('Read again'), 1)
    const [pageId] = await jobPageIds(jobId)
    const paragraph = await paragraphOf(jobId, pageId)
    await correctLine(paragraph.lines[0].id, 'Corrected by hand')

    // The stub reads a line as "Sample <class> line <n>", so re-classing the element is
    // how a scenario makes the next run read the same lines differently.
    await setElementClass(paragraph.id, 'Header')
    await setElementBbox(paragraph.id, BARELY_MOVED)
    await redetectLines(jobId, pageId)
    await waitForJobStatus(jobId, 'done')

    // The element is a Header now, so it is looked up by id rather than by class.
    const after = (await getPageDetail(jobId, pageId)).elements
      .find((e: { id: number }) => e.id === paragraph.id)!
    expect(after.lines[0].text).toBe('Sample Header line 1')

    // Oracle: what the page still offers on its lines. The person's word survives the
    // re-read; the model's earlier one does not, because the line now carries its latest.
    const held = await pageCandidates(pageId)
    expect(held.filter((c) => c.line_id !== null).map((c) => [c.source, c.text]))
      .toEqual([['human', 'Corrected by hand']])
  })
})
