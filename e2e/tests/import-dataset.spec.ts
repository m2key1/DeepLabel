import { test, expect } from '../helpers/test'
import { getJob, getPageDetail, jobPageIds, uniqueName, waitForJobStatus } from '../helpers/api'
import { scanPng } from '../helpers/image'
import { makeZip } from '../helpers/zip'

// A Transkribus/eScriptorium-shaped export: one PAGE XML per page, the images
// alongside, plus the METS manifest those tools always add.
const pageXml = (image: string) => `<?xml version="1.0" encoding="UTF-8"?>
<PcGts xmlns="http://schema.primaresearch.org/PAGE/gts/pagecontent/2019-07-15">
  <Page imageFilename="${image}" imageWidth="600" imageHeight="800">
    <TextRegion id="r1" type="heading">
      <Coords points="60,40 540,40 540,120 60,120"/>
      <TextLine id="l1">
        <Coords points="60,40 540,40 540,120 60,120"/>
        <TextEquiv><Unicode>Schematismus 1837</Unicode></TextEquiv>
      </TextLine>
    </TextRegion>
    <TextRegion id="r2" type="paragraph">
      <Coords points="60,200 540,200 540,400 60,400"/>
      <TextLine id="l2">
        <Coords points="60,200 540,200 540,280 60,280"/>
        <TextEquiv><Unicode>Pfarre Wien</Unicode></TextEquiv>
      </TextLine>
      <TextLine id="l3">
        <Coords points="60,320 540,320 540,400 60,400"/>
        <TextEquiv><Unicode>Kaplan Johann Huber</Unicode></TextEquiv>
      </TextLine>
    </TextRegion>
  </Page>
</PcGts>`

test.describe('Scenario: importing an existing dataset', () => {
  test('a PAGE XML export becomes a reviewable dataset without any recognition', async ({ page }) => {
    const zip = makeZip({
      'export/page/folio_1.xml': pageXml('folio_1.png'),
      'export/folio_1.png': scanPng(),
      'export/mets.xml': '<mets/>',
    })
    const name = uniqueName('Transkribus import')

    await page.goto('/new')
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles({
      name: 'export.zip', mimeType: 'application/zip', buffer: zip,
    })

    // The form recognizes the archive and drops the recognition choices.
    await expect(page.getByTestId('import-notice')).toContainText('Zip archive')
    await expect(page.getByTestId('ocr-decode-greedy')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Import dataset' })).toBeEnabled()
    await page.getByRole('button', { name: 'Import dataset' }).click()

    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!
    await waitForJobStatus(jobId, 'done')

    // The geometry and text of the export arrived intact, normalized against the
    // page size the XML declared (600x800).
    const [pageId] = await jobPageIds(jobId)
    const detail = await getPageDetail(jobId, pageId)
    expect(detail.elements.map((e: { class_name: string }) => e.class_name)).toEqual([
      'Header', 'Paragraph'])
    expect(detail.elements[0].bbox).toEqual([0.1, 0.05, 0.9, 0.15])
    const lines = detail.elements.flatMap(
      (e: { lines: { text: string; checked: boolean; polygon: number[][] }[] }) => e.lines)
    expect(lines.map((l: { text: string }) => l.text)).toEqual([
      'Schematismus 1837', 'Pfarre Wien', 'Kaplan Johann Huber'])
    expect(lines[0].polygon).toEqual([[0.1, 0.05], [0.9, 0.05], [0.9, 0.15], [0.1, 0.15]])
    // Default is "transcriptions are final", so every line counts as reviewed.
    expect(lines.every((l: { checked: boolean }) => l.checked)).toBe(true)

    const job = await getJob(jobId)
    expect(job.counters.lines_total).toBe(3)
    expect(job.run_layout).toBe(false)
    expect(job.run_ocr).toBe(false)
  })

  test('a zip that is neither an export nor scans explains itself', async ({ page }) => {
    await page.goto('/new')
    await page.getByLabel('Job name').fill(uniqueName('Bad import'))
    await page.locator('input[type="file"]').setInputFiles({
      name: 'paperwork.zip',
      mimeType: 'application/zip',
      buffer: makeZip({ 'minutes.xml': Buffer.from('<minutes>nothing to see</minutes>') }),
    })
    await page.getByRole('button', { name: 'Import dataset' }).click()
    await expect(page.getByText(/no PAGE XML, ALTO, hOCR or TEI with matching images/)).toBeVisible()
    await expect(page).toHaveURL(/\/new$/)
  })
})
