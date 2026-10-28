import { test, expect } from '../helpers/test'
import { getPageDetail, jobPageIds, uniqueName, waitForJobStatus } from '../helpers/api'
import { scanPng } from '../helpers/image'
import { makeZip } from '../helpers/zip'

// PAGE XML puts text in more places than a TextRegion directly under the Page: a table's
// cells hold lines of their own, and a region may nest regions inside it. Transkribus and
// eScriptorium both write either, so an import that skips them loses transcribed lines
// without saying so.
const nestedPageXml = (image: string) => `<?xml version="1.0" encoding="UTF-8"?>
<PcGts xmlns="http://schema.primaresearch.org/PAGE/gts/pagecontent/2019-07-15">
  <Page imageFilename="${image}" imageWidth="600" imageHeight="800">
    <TextRegion id="r1" type="heading">
      <Coords points="60,40 540,40 540,120 60,120"/>
      <TextLine id="l1">
        <Coords points="60,40 540,40 540,120 60,120"/>
        <TextEquiv><Unicode>Schematismus 1837</Unicode></TextEquiv>
      </TextLine>
    </TextRegion>
    <TableRegion id="t1">
      <Coords points="60,200 540,200 540,400 60,400"/>
      <TableCell id="c1" row="0" col="0">
        <Coords points="60,200 300,200 300,280 60,280"/>
        <TextLine id="l2">
          <Coords points="60,200 300,200 300,280 60,280"/>
          <TextEquiv><Unicode>Pfarre Wien</Unicode></TextEquiv>
        </TextLine>
      </TableCell>
    </TableRegion>
    <TextRegion id="r2" type="paragraph">
      <Coords points="60,500 540,500 540,700 60,700"/>
      <TextRegion id="r2a" type="paragraph">
        <Coords points="60,500 540,500 540,600 60,600"/>
        <TextLine id="l3">
          <Coords points="60,520 540,520 540,580 60,580"/>
          <TextEquiv><Unicode>Kaplan Johann Huber</Unicode></TextEquiv>
        </TextLine>
      </TextRegion>
    </TextRegion>
  </Page>
</PcGts>`

test.describe('Scenario: importing an export whose lines sit in tables and nested regions', () => {
  test('every transcribed line arrives, wherever the export put it', async ({ page }) => {
    const zip = makeZip({
      'export/page/folio_1.xml': nestedPageXml('folio_1.png'),
      'export/folio_1.png': scanPng(),
    })
    await page.goto('/new')
    await page.getByLabel('Job name').fill(uniqueName('Nested import'))
    await page.locator('input[type="file"]').setInputFiles({
      name: 'export.zip', mimeType: 'application/zip', buffer: zip,
    })
    await expect(page.getByTestId('import-notice')).toContainText('Zip archive')
    await page.getByRole('button', { name: 'Import dataset' }).click()

    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!
    await waitForJobStatus(jobId, 'done')

    const [pageId] = await jobPageIds(jobId)
    const detail = await getPageDetail(jobId, pageId)
    const lines = detail.elements.flatMap(
      (e: { lines: { text: string; polygon: number[][] }[] }) => e.lines)
    expect(lines.map((l: { text: string }) => l.text).sort()).toEqual([
      'Kaplan Johann Huber', 'Pfarre Wien', 'Schematismus 1837'])
    // Normalized against the declared 600x800, like any other imported line.
    const cell = lines.find((l: { text: string }) => l.text === 'Pfarre Wien')!
    expect(cell.polygon).toEqual([[0.1, 0.25], [0.5, 0.25], [0.5, 0.35], [0.1, 0.35]])
  })
})
