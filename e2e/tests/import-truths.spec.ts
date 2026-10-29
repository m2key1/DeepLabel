import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import {
  BACKEND, correctLine, datasetInfo, exportText, getJob, getPageDetail, jobPageIds, pageLines,
  seedCompletedJob, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { scanPng } from '../helpers/image'
import { wizardStep } from '../helpers/new-dataset'
import { makeZip, zipEntries } from '../helpers/zip'

const HEADERS = {
  'X-Frontend-Secret': 'e2e-secret',
  'X-Auth-User': 'e2e-seeder',
  'X-Auth-Role': 'admin',
}

// The same transcribed folio import-dataset.spec drops on the form: two regions, three
// lines, declared 600x800.
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

// What Transkribus writes for a blank verso: the page is there, nothing was transcribed.
const blankPageXml = (image: string) => `<?xml version="1.0" encoding="UTF-8"?>
<PcGts xmlns="http://schema.primaresearch.org/PAGE/gts/pagecontent/2019-07-15">
  <Page imageFilename="${image}" imageWidth="600" imageHeight="800"/>
</PcGts>`

// eScriptorium's other format: one block, two lines, a word broken at the line end with
// the hyphen as its own HYP element.
const altoXml = (image: string) => `<?xml version="1.0" encoding="UTF-8"?>
<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#">
  <Description>
    <MeasurementUnit>pixel</MeasurementUnit>
    <sourceImageInformation><fileName>${image}</fileName></sourceImageInformation>
  </Description>
  <Layout>
    <Page ID="p1" PHYSICAL_IMG_NR="1" WIDTH="600" HEIGHT="800">
      <PrintSpace HPOS="0" VPOS="0" WIDTH="600" HEIGHT="800">
        <TextBlock ID="b1" HPOS="60" VPOS="40" WIDTH="480" HEIGHT="80">
          <TextLine ID="l1" HPOS="60" VPOS="40" WIDTH="480" HEIGHT="40">
            <String CONTENT="Pfarre" HPOS="60" VPOS="40" WIDTH="150" HEIGHT="40"/>
            <SP HPOS="210" VPOS="40" WIDTH="10"/>
            <String CONTENT="Hei" HPOS="220" VPOS="40" WIDTH="80" HEIGHT="40"
                    SUBS_TYPE="HypPart1" SUBS_CONTENT="Heiligenstadt"/>
            <HYP CONTENT="-"/>
          </TextLine>
          <TextLine ID="l2" HPOS="60" VPOS="80" WIDTH="480" HEIGHT="40">
            <String CONTENT="ligenstadt" HPOS="60" VPOS="80" WIDTH="300" HEIGHT="40"
                    SUBS_TYPE="HypPart2" SUBS_CONTENT="Heiligenstadt"/>
          </TextLine>
        </TextBlock>
      </PrintSpace>
    </Page>
  </Layout>
</alto>`

interface ImportReply {
  job_id: string
  format: string
  pages: number
  lines: number
}

/** Drops the archive on the new-dataset form as the signed-in dev admin - the way an import
 *  is actually made - and hands the dataset back once its renditions are built. */
async function importThroughForm(page: Page, name: string, zip: Buffer) {
  await page.goto('/new')
  await page.getByLabel('Job name').fill(name)
  await page.locator('input[type="file"]').setInputFiles({
    name: 'export.zip', mimeType: 'application/zip', buffer: zip,
  })
  await expect(page.getByTestId('import-notice')).toContainText('Zip archive')
  // The form's default: the transcriptions are final, so every imported line is reviewed.
  await expect(page.getByTestId('import-reviewed')).toBeChecked()
  await wizardStep(page, 'review')
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/jobs/import')),
    page.getByRole('button', { name: 'Import dataset' }).click(),
  ])
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
  const jobId = page.url().split('/').pop()!
  await waitForJobStatus(jobId, 'done')
  return { jobId, reply: (await response.json()) as ImportReply }
}

async function pageFilenames(jobId: string): Promise<string[]> {
  const job = await getJob(jobId)
  return [...job.pages]
    .sort((a: { idx: number }, b: { idx: number }) => a.idx - b.idx)
    .map((p: { filename: string }) => p.filename)
}

interface DetailLine {
  id: number
  text: string
  checked: boolean
  polygon: number[][]
}

interface DetailElement {
  class_name: string
  bbox: number[]
  lines: DetailLine[]
}

test.describe('Scenario: an export is imported as it is', () => {
  // The README promises pages "as they are". A blank verso in a Transkribus export is a
  // page whose XML holds no text region; dropping it shifts every page number after it,
  // and nobody is told.
  test('a blank leaf in the export is imported as a page of its own', async ({ page }) => {
    const zip = makeZip({
      'export/page/folio_1.xml': pageXml('folio_1.png'),
      'export/page/folio_2.xml': blankPageXml('folio_2.png'),
      'export/folio_1.png': scanPng(),
      'export/folio_2.png': scanPng(600, 800, 1),
    })
    const { jobId } = await importThroughForm(page, uniqueName('Blank verso import'), zip)

    await expect.poll(() => pageFilenames(jobId)).toEqual(['folio_1.png', 'folio_2.png'])
    expect((await datasetInfo(jobId)).pages).toBe(2)
    const [, verso] = await jobPageIds(jobId)
    expect((await getPageDetail(jobId, verso)).elements).toEqual([])

    await page.goto(`/jobs/${jobId}`)
    const row = (filename: string) => page.getByRole('row').filter({ hasText: filename })
    await expect(row('folio_1.png')).toHaveCount(1)
    await expect(row('folio_2.png')).toHaveCount(1)
  })

  // The Info panel names the people who edited a dataset; the pipeline, alignment and the
  // LLM are provenance and are left out. Taking over an export is provenance too - the
  // import wrote two regions and three lines, and nobody has edited anything yet.
  test('importing is not editing: an untouched import has no editors', async ({ page }) => {
    const name = uniqueName('Import editors')
    const { jobId } = await importThroughForm(page, name, makeZip({
      'export/page/folio_1.xml': pageXml('folio_1.png'),
      'export/folio_1.png': scanPng(),
    }))
    expect((await datasetInfo(jobId)).editors).toEqual([])

    await page.goto('/')
    const card = page.getByTestId('job-card').filter({ hasText: name })
    await card.getByTestId('job-info-toggle').click()
    const editors = card.getByTestId('job-info').locator('[data-field="editors"] dd')
    await expect(editors).toHaveText('nobody yet')

    // A person's correction is what makes somebody an editor - the same single edit
    // dataset-editors.spec counts for a pipeline-read line.
    const [pageId] = await jobPageIds(jobId)
    const [heading] = await pageLines(jobId, pageId)
    expect(heading.text).toBe('Schematismus 1837')
    await correctLine(heading.id, 'Schematismus 1838')
    expect((await datasetInfo(jobId)).editors.map((e) => [e.author, e.edits]))
      .toEqual([['e2e-seeder', 1]])

    await page.goto('/')
    await card.getByTestId('job-info-toggle').click()
    await expect(editors).toHaveText('e2e-seeder (1)')
  })

  test('an ALTO export arrives with its block, line boxes and words, the hyphen kept on its word',
    async ({ page }) => {
      const zip = makeZip({
        'export/alto/folio_1.xml': altoXml('folio_1.png'),
        'export/folio_1.png': scanPng(),
      })
      const { jobId, reply } = await importThroughForm(page, uniqueName('ALTO import'), zip)
      expect(reply).toMatchObject({ job_id: jobId, format: 'alto', pages: 1, lines: 2 })

      const [pageId] = await jobPageIds(jobId)
      const detail = await getPageDetail(jobId, pageId)
      const elements: DetailElement[] = detail.elements
      expect(elements.map((e) => e.class_name)).toEqual(['Paragraph'])
      // The block's HPOS/VPOS/WIDTH/HEIGHT normalized against the declared 600x800.
      expect(elements[0].bbox).toEqual([0.1, 0.05, 0.9, 0.15])
      const lines = elements.flatMap((e) => e.lines)
      expect(lines.map((l) => l.text)).toEqual(['Pfarre Hei-', 'ligenstadt'])
      expect(lines[0].polygon).toEqual([[0.1, 0.05], [0.9, 0.05], [0.9, 0.1], [0.1, 0.1]])
      expect(lines.map((l) => l.checked)).toEqual([true, true])

      const job = await getJob(jobId)
      expect(job.counters.lines_total).toBe(2)
      expect(job.run_layout).toBe(false)
      expect(job.run_ocr).toBe(false)
    })
})

interface ExportLine {
  id: number
  corrected_text: string | null
  checked: boolean
}

interface ExportPage {
  idx: number
  filename: string
  elements: { lines: ExportLine[] }[]
}

const exportLines = (data: { pages: ExportPage[] }) =>
  data.pages.flatMap((p) => p.elements.flatMap((e) => e.lines))

test.describe('Scenario: downloading only what was reviewed', () => {
  test('reviewed-only json and zip leave out the pages with nothing reviewed on them', async () => {
    const name = uniqueName('Reviewed export shape')
    const jobId = await seedCompletedJob(name, 2)
    const [, second] = await jobPageIds(jobId)
    const [firstOfSecond] = await pageLines(jobId, second)
    await correctLine(firstOfSecond.id, 'Only this was reviewed')

    const reviewed: { pages: ExportPage[] } = JSON.parse(await exportText(jobId, 'json', true))
    expect(reviewed.pages.map((p) => [p.idx, p.filename])).toEqual([[1, 'scan_2.png']])
    expect(exportLines(reviewed)).toEqual([
      expect.objectContaining({
        id: firstOfSecond.id, corrected_text: 'Only this was reviewed', checked: true,
      }),
    ])
    // The full export still carries both pages and all twelve lines the stub read.
    const full: { pages: ExportPage[] } = JSON.parse(await exportText(jobId, 'json'))
    expect(full.pages.map((p) => p.filename)).toEqual(['scan_1.png', 'scan_2.png'])
    expect(exportLines(full)).toHaveLength(12)

    const res = await fetch(
      `${BACKEND}/api/jobs/${jobId}/export?format=zip&checked_only=true`, { headers: HEADERS })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${name}-reviewed.zip"`)
    // One sidecar pair for the reviewed page, numbered by its place in the dataset.
    // One sidecar pair for the reviewed page, numbered by its place in the dataset, and
    // its scan, so the archive imports elsewhere.
    expect(zipEntries(Buffer.from(await res.arrayBuffer())))
      .toEqual(['job.json', 'pages/page_0002.json', 'pages/page_0002.md', 'images/scan_2.png'])
  })
})

test.describe('Scenario: out in a standard format and back in', () => {
  test('a dataset leaves as PAGE XML with its scans and comes back through the form, checks and all',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Round trip'), 2)
      const [first] = await jobPageIds(jobId)
      const [line] = await pageLines(jobId, first)
      await correctLine(line.id, 'Pfarre Heiligenstadt')
      const res = await fetch(`${BACKEND}/api/jobs/${jobId}/export?format=page`, { headers: HEADERS })
      expect(res.status).toBe(200)
      const archive = Buffer.from(await res.arrayBuffer())
      expect(zipEntries(archive)).toEqual(
        ['page/scan_1.xml', 'page/scan_2.xml', 'images/scan_1.png', 'images/scan_2.png'])

      const { jobId: back, reply } = await importThroughForm(page, uniqueName('Back again'), archive)

      expect(reply).toMatchObject({ format: 'page-xml', pages: 2, lines: 12 })
      const [firstBack] = await jobPageIds(back)
      const lines = await pageLines(back, firstBack)
      // The one checked line came back checked, the rest as unchecked readings - the file
      // says which, not the form's review default.
      expect(lines.filter((l) => l.checked).map((l) => l.text)).toEqual(['Pfarre Heiligenstadt'])
      expect(lines.filter((l) => !l.checked)).toHaveLength(5)
    })

  test('a zip of scans alone goes up as pages and is read like any upload', async ({ page }) => {
    const name = uniqueName('Zipped scans')
    const zip = makeZip({ 'volume/scan_2.png': scanPng(600, 800, 71), 'volume/scan_1.png': scanPng(600, 800, 72) })
    await page.goto('/new')
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles({ name: 'scans.zip', mimeType: 'application/zip', buffer: zip })
    await expect(page.getByTestId('import-notice')).toContainText('A zip of scans alone is read like any other upload')
    await wizardStep(page, 'review')
    const [refused, uploaded] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/jobs/import')),
      page.waitForResponse((r) => r.url().endsWith('/api/jobs') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Import dataset' }).click(),
    ])
    expect(refused.status()).toBe(422)
    expect(uploaded.status()).toBe(200)
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!
    await waitForJobStatus(jobId, 'done')
    expect(await pageFilenames(jobId)).toEqual(['scan_1.png', 'scan_2.png'])
    // Read by the pipeline: the stub's six lines on each page.
    expect(await pageLines(jobId, (await jobPageIds(jobId))[0])).toHaveLength(6)
  })
})
