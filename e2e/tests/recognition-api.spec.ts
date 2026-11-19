import { test, expect } from '../helpers/test'
import type { Page } from '@playwright/test'
import {
  backendFetch, getJob, getPageDetail, importStubModel, jobPageIds, pageLines, slowOcrModelId, uniqueName,
} from '../helpers/api'
import { FRONTEND } from '../helpers/frontend'
import { scanPng } from '../helpers/image'
import { seedSession, useSession } from '../helpers/session'
import { openViewer } from '../helpers/viewer'

// The stub finds three lines in each of its two layout boxes, full width, so a page comes
// back as six lines top to bottom, and it reads a line as "Sample Text line <n>" from the
// line's place in the request (no layout class is sent). The outlines below are the stub's
// own, in the pixels of a 600x800 and a 500x400 scan.
const LINES_600x800 = [
  [[60, 44], [540, 44], [540, 63], [60, 63]],
  [[60, 71], [540, 71], [540, 89], [60, 89]],
  [[60, 97], [540, 97], [540, 116], [60, 116]],
  [[60, 186], [540, 186], [540, 307], [60, 307]],
  [[60, 359], [540, 359], [540, 481], [60, 481]],
  [[60, 533], [540, 533], [540, 654], [60, 654]],
]
const LINES_500x400 = [
  [[50, 22], [450, 22], [450, 31], [50, 31]],
  [[50, 35], [450, 35], [450, 45], [50, 45]],
  [[50, 49], [450, 49], [450, 58], [50, 58]],
  [[50, 93], [450, 93], [450, 154], [50, 154]],
  [[50, 180], [450, 180], [450, 240], [50, 240]],
  [[50, 266], [450, 266], [450, 327], [50, 327]],
]
const READ = (n: number) => Array.from({ length: n }, (_, i) => `Sample Text line ${i + 1}`)
// With a layout model the stub finds those two boxes, a Header and a Paragraph, and inside
// each the same three lines; a line is then read as "Sample <class> line <n>", by its
// region's class and its place there, at the confidence the stub gives that class.
const REGIONS_600x800 = [
  { class: 'Header', role: 'content', polygon: [[60, 40], [540, 40], [540, 120], [60, 120]], confidence: 0.9 },
  { class: 'Paragraph', role: 'content', polygon: [[60, 160], [540, 160], [540, 680], [60, 680]], confidence: 0.9 },
]
const READ_BY_REGION = [
  ...[0.97, 0.92, 0.9].map((confidence, i) => ({ text: `Sample Header line ${i + 1}`, confidence, region: 0 })),
  ...[0.55, 0.82, 0.95].map((confidence, i) => ({ text: `Sample Paragraph line ${i + 1}`, confidence, region: 1 })),
]
const STUB_CONFIDENCE = 0.9

interface Image { name: string; png: Buffer | Uint8Array }

async function mint(page: Page, name: string, body: { scope?: string; readonly?: boolean } = {}) {
  const response = await page.request.post('/api/tokens', { data: { name, expires_days: 1, ...body } })
  expect(response.status()).toBe(200)
  return (await response.json()).token as string
}

/** Through nginx and the auth service with nothing but the token, as a script would. */
function recognize(token: string, route: 'pages' | 'lines', images: Image[], fields: Record<string, string> = {}) {
  const form = new FormData()
  for (const { name, png } of images) form.append('files', new Blob([new Uint8Array(png)], { type: 'image/png' }), name)
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  return fetch(`${FRONTEND}/api/recognize/${route}`, {
    method: 'POST', body: form, redirect: 'manual', headers: { Authorization: `Bearer ${token}` },
  })
}

function asToken(token: string, path: string, init: RequestInit = {}) {
  return fetch(`${FRONTEND}${path}`, { ...init, redirect: 'manual', headers: { Authorization: `Bearer ${token}` } })
}

interface Offered { id: number; name: string; default: boolean; default_decode?: string; template?: string }

async function defaults(token: string) {
  const offered = await (await asToken(token, '/api/recognize')).json()
  const lines = offered.models.lines.find((m: Offered) => m.default)
  const ocr = offered.models.ocr.find((m: Offered) => m.default)
  return {
    lines: { id: lines.id, name: lines.name },
    ocr: { id: ocr.id, name: ocr.name, decode: ocr.default_decode },
  }
}

async function layoutModel(token: string): Promise<Offered> {
  const offered = await (await asToken(token, '/api/recognize')).json()
  return offered.models.layout.find((m: Offered) => m.default)
}

const pageOf = (id: string, width: number, height: number, outlines: number[][][]) => ({
  id, width, height,
  lines: outlines.map((polygon, i) => ({ polygon, text: `Sample Text line ${i + 1}`, confidence: STUB_CONFIDENCE })),
})

test.describe('Scenario: reading scans through the recognition API', () => {
  test('a batch of pages comes back as their lines in reading order, each read, in pixels', async ({ page }) => {
    const token = await mint(page, uniqueName('pages'))
    const used = await defaults(token)

    const response = await recognize(token, 'pages', [
      { name: 'scan_a.png', png: scanPng(600, 800, 0) },
      { name: 'scan_b.png', png: scanPng(500, 400, 1) },
    ])

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      models: used,
      pages: [pageOf('scan_a.png', 600, 800, LINES_600x800), pageOf('scan_b.png', 500, 400, LINES_500x400)],
    })
  })

  test('line images come back as their text, in the order sent', async ({ page }) => {
    const token = await mint(page, uniqueName('lines'))
    const { ocr } = await defaults(token)

    const response = await recognize(token, 'lines', [1, 2, 3].map((n) => ({
      name: `line_${n}.png`, png: scanPng(400, 40, n),
    })), { decode: 'greedy' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      models: { ocr: { ...ocr, decode: 'greedy' } },
      lines: READ(3).map((text, i) => ({ id: `line_${i + 1}.png`, text, confidence: STUB_CONFIDENCE })),
    })
  })

  test('with characters, each line comes back with the confidence bands it was read with', async ({ page }) => {
    const token = await mint(page, uniqueName('characters'))
    const { ocr } = await defaults(token)

    const response = await recognize(token, 'lines', [1, 2].map((n) => ({
      name: `line_${n}.png`, png: scanPng(400, 40, n),
    })), { characters: 'true' })

    // The stub reads a line in 20 even bands, each at the line's own confidence.
    const bands = Array.from({ length: 20 }, (_, i) => ({ x0: i / 20, x1: (i + 1) / 20, confidence: STUB_CONFIDENCE }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      models: { ocr },
      lines: READ(2).map((text, i) => ({ id: `line_${i + 1}.png`, text, confidence: STUB_CONFIDENCE, characters: bands })),
    })
  })

  test('a page sent with its own line outlines is only read, in the order given', async ({ page }) => {
    const token = await mint(page, uniqueName('own lines'))
    const used = await defaults(token)
    // Lower line first: the order given is the order read, never re-sorted.
    const own = [[[60, 500], [540, 500], [540, 540], [60, 540]], [[60, 100], [540, 100], [540, 140], [60, 140]]]

    const response = await recognize(token, 'pages', [
      { name: 'own.png', png: scanPng(600, 800, 2) },
      { name: 'found.png', png: scanPng(500, 400, 3) },
    ], { lines: JSON.stringify({ 'own.png': own }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      models: used,
      pages: [pageOf('own.png', 600, 800, own), pageOf('found.png', 500, 400, LINES_500x400)],
    })
  })

  test('the standard formats come back per page beside the lines', async ({ page }) => {
    const token = await mint(page, uniqueName('formats'))
    const scan = [{ name: 'leaf.png', png: scanPng(500, 400, 4) }]
    const document = async (format: string) => {
      const response = await recognize(token, 'pages', scan, { format })
      expect(response.status).toBe(200)
      const answer = await response.json()
      expect(answer.pages[0].lines.map((l: { text: string }) => l.text)).toEqual(READ(6))
      return answer.pages[0].document as string
    }

    const pageXml = await document('page')
    expect(pageXml).toContain('<Page imageFilename="leaf.png" imageWidth="500" imageHeight="400">')
    expect(pageXml.match(/<TextLine /g)).toHaveLength(6)
    expect(pageXml).toContain('<Coords points="50,22 450,22 450,31 50,31"/>')
    expect(pageXml).toContain('<Unicode>Sample Text line 6</Unicode>')

    const alto = await document('alto')
    expect(alto).toContain('<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#">')
    expect(alto.match(/<TextLine /g)).toHaveLength(6)
    expect(alto).toContain('HPOS="50" VPOS="22" WIDTH="400" HEIGHT="9"')

    const hocr = await document('hocr')
    expect(hocr.match(/class='ocr_line'/g)).toHaveLength(6)
    expect(hocr).toContain("title='bbox 50 22 450 31'")

    expect(await document('txt')).toBe(READ(6).join('\n'))

    const plain = await (await recognize(token, 'pages', scan)).json()
    expect(Object.keys(plain.pages[0]).sort()).toEqual(['height', 'id', 'lines', 'width'])
  })

  test('an unreadable image fails alone, and a request over a limit is refused with the limit',
    async ({ page }) => {
      const token = await mint(page, uniqueName('limits'))

      const mixed = await recognize(token, 'pages', [
        { name: 'fine.png', png: scanPng(500, 400, 5) },
        { name: 'broken.png', png: new TextEncoder().encode('not an image') },
      ])
      expect(mixed.status).toBe(200)
      const pages = (await mixed.json()).pages
      expect(pages[0].lines.map((l: { text: string }) => l.text)).toEqual(READ(6))
      expect(pages[1]).toEqual({ id: 'broken.png', error: 'the image could not be read' })

      const elevenPages = await recognize(token, 'pages', Array.from({ length: 11 }, (_, i) => ({
        name: `p${i}.png`, png: scanPng(50, 40, i),
      })))
      expect(elevenPages.status).toBe(413)
      expect((await elevenPages.json()).detail).toBe('at most 10 pages per request, this one has 11')

      const manyLines = await recognize(token, 'lines', Array.from({ length: 501 }, (_, i) => ({
        name: `l${i}.png`, png: scanPng(20, 8, i),
      })))
      expect(manyLines.status).toBe(413)
      expect((await manyLines.json()).detail).toBe('at most 500 lines per request, this one has 501')

      const offered = await (await asToken(token, '/api/recognize')).json()
      expect(offered.limits).toEqual({
        pages: 10, lines: 500, megabytes: 100,
        async: { pages: 1000, lines: 20000, megabytes: 2048, unfinished: 5, kept_hours: 24 },
      })
    })
})

test.describe('Scenario: layout before the lines', () => {
  test('with a layout model a page comes back with its regions, each line found and read inside its own',
    async ({ page }) => {
      const token = await mint(page, uniqueName('layout'))
      const used = await defaults(token)
      const layout = await layoutModel(token)
      // The stub's layout model belongs to no template, so it reads by the default one.
      expect(layout).toEqual({ id: expect.any(Number), name: expect.any(String), default: true, template: 'Schematismus' })
      const scan = [{ name: 'leaf.png', png: scanPng(600, 800, 50) }]

      const response = await recognize(token, 'pages', scan, { layout_model: String(layout.id) })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        models: { layout: { id: layout.id, name: layout.name }, ...used },
        pages: [{
          id: 'leaf.png', width: 600, height: 800, regions: REGIONS_600x800,
          lines: LINES_600x800.map((polygon, i) => ({ polygon, ...READ_BY_REGION[i] })),
        }],
      })

      const xml = (await (await recognize(token, 'pages', scan, { layout_model: String(layout.id), format: 'page' }))
        .json()).pages[0].document as string
      expect(xml.match(/<TextRegion /g)).toHaveLength(2)
      expect(xml).toContain('structure {type:Header;}')
      expect(xml).toContain('<Coords points="60,160 540,160 540,680 60,680"/>')
      expect(xml).toContain('<Unicode>Sample Paragraph line 3</Unicode>')
    })
})

test.describe('Scenario: a token that can only recognize', () => {
  test('a recognition-only token, made on the tokens tab, reaches recognition and nothing else',
    async ({ page }) => {
      await page.goto('/settings?section=tokens')
      const name = uniqueName('ocr only')
      await page.getByLabel('Token name').fill(name)
      await page.getByLabel('Access').selectOption({ label: 'Recognition only' })
      await page.getByRole('button', { name: 'Create token' }).click()
      const token = await page.getByTestId('token-secret').locator('code').innerText()
      await expect(page.getByTestId('token-row').filter({ hasText: name })).toContainText('recognition only')

      const read = await recognize(token, 'lines', [{ name: 'one.png', png: scanPng(400, 40, 9) }])
      expect(read.status).toBe(200)
      expect((await read.json()).lines.map((l: { text: string }) => l.text)).toEqual(READ(1))

      for (const path of ['/api/jobs', '/api/queue', '/api/me', '/api/settings']) {
        const refused = await asToken(token, path)
        expect(refused.status, path).toBe(403)
        expect((await refused.json()).detail, path).toBe('recognition-only API token')
      }
    })

  test('a key limited to chosen models is offered them alone, reads with them and is refused the rest, until widened',
    async ({ page }) => {
      const guestOcrName = uniqueName('Guest OCR')
      const guestOcr = importStubModel('ocr', guestOcrName, 'stub-misread')
      const everything = await (await page.request.get('/api/recognize')).json()
      const lines = everything.models.lines.find((m: Offered) => m.default) as Offered
      const ocr = everything.models.ocr.find((m: Offered) => m.default) as Offered

      await page.goto('/settings?section=tokens')
      const name = uniqueName('guest key')
      await page.getByLabel('Token name').fill(name)
      await page.getByLabel('Access').selectOption({ label: 'Recognition only' })
      const chooser = page.getByTestId('token-models')
      await expect(chooser.getByRole('button', { name: 'All models', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await chooser.getByRole('button', { name: 'Chosen models', exact: true }).click()
      // Chosen starts from the deployment's own line and OCR models.
      const chip = (task: string, model: string) =>
        chooser.locator(`[data-task="${task}"]`).getByRole('button', { name: model, exact: true })
      await expect(chip('lines', lines.name)).toHaveAttribute('aria-pressed', 'true')
      await expect(chip('ocr', ocr.name)).toHaveAttribute('aria-pressed', 'true')
      await expect(chip('layout', everything.models.layout[0].name)).toHaveAttribute('aria-pressed', 'false')
      await chip('ocr', ocr.name).click()
      await expect(page.getByText('Pick at least one OCR model.')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Create token' })).toBeDisabled()
      await chip('ocr', guestOcrName).click()
      await page.getByRole('button', { name: 'Create token' }).click()
      const token = await page.getByTestId('token-secret').locator('code').innerText()

      const stored = async () => ((await (await page.request.get('/api/tokens')).json()).tokens as
        { name: string; models: number[] | null }[]).find((t) => t.name === name)!.models
      await expect.poll(stored).toEqual([lines.id, guestOcr].sort((a, b) => a - b))
      const row = page.getByTestId('token-row').filter({ hasText: name })
      await expect(row.getByTestId('token-models-label')).toHaveText(`${lines.name}, ${guestOcrName}`)

      const offered = await (await asToken(token, '/api/recognize')).json()
      const listed = (task: string) => offered.models[task].map((m: Offered) => [m.name, m.default])
      expect([listed('layout'), listed('lines'), listed('ocr')]).toEqual([[], [[lines.name, true]], [[guestOcrName, true]]])
      const read = await recognize(token, 'lines', [{ name: 'one.png', png: scanPng(400, 40, 12) }])
      expect(read.status).toBe(200)
      expect((await read.json()).models.ocr.id).toBe(guestOcr)
      const refused = await recognize(token, 'lines', [{ name: 'one.png', png: scanPng(400, 40, 13) }],
                                      { ocr_model: String(ocr.id) })
      expect(refused.status).toBe(400)
      expect((await refused.json()).detail).toBe('not an available ocr model')

      // Widened again from its row: the key handed out reaches every model.
      await row.getByRole('button', { name: 'Change models' }).click()
      const editor = page.getByTestId('token-models-editor')
      await editor.getByRole('button', { name: 'All models', exact: true }).click()
      await editor.getByRole('button', { name: 'Save' }).click()
      await expect.poll(stored).toBeNull()
      await expect(row.getByTestId('token-models-label')).toHaveText('all')
      const widened = await recognize(token, 'lines', [{ name: 'one.png', png: scanPng(400, 40, 14) }],
                                      { ocr_model: String(ocr.id) })
      expect(widened.status).toBe(200)
      expect((await widened.json()).models.ocr.id).toBe(ocr.id)
    })

  test('a read-only token may recognize, as that writes nothing', async ({ page }) => {
    const token = await mint(page, uniqueName('read only'), { readonly: true })
    const read = await recognize(token, 'lines', [{ name: 'one.png', png: scanPng(400, 40, 10) }])
    expect(read.status).toBe(200)
    expect((await read.json()).lines.map((l: { text: string }) => l.text)).toEqual(READ(1))
  })

  test('recognizing needs the recognize permission, which only admins have by default',
    async ({ page, browser }) => {
      await page.goto('/settings?section=tokens')
      await expect(page.getByLabel('Access').locator('option', { hasText: 'Recognition only' })).toHaveCount(1)

      const username = uniqueName('manager').replace(/\s/g, '-')
      const session = seedSession('manager', username)
      const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
      await useSession(context, session)
      const member = await context.newPage()
      await member.goto('/settings?section=tokens')
      const access = member.getByLabel('Access')
      await expect(access.locator('option', { hasText: 'Read-only' })).toHaveCount(1)
      await expect(access.locator('option', { hasText: 'Recognition only' })).toHaveCount(0)

      const token = await mint(member, uniqueName('member token'))
      const refused = await recognize(token, 'lines', [{ name: 'one.png', png: scanPng(400, 40, 11) }])
      expect(refused.status).toBe(403)
      expect((await refused.json()).detail).toBe('not permitted: recognize')
      await context.close()
    })
})

test.describe('Scenario: a recognition request on the queue', () => {
  test('a request shows on the queue while it reads, without its owner, and the account waits its turn',
    async ({ page }) => {
      const me = (await (await page.request.get('/api/me')).json()).user as string
      const token = await mint(page, uniqueName('slow'))
      // The slow reader takes 15 s over every batch, which keeps the request in flight.
      const answered = recognize(token, 'pages', [{ name: 'slow.png', png: scanPng(500, 400, 12) }],
                                 { ocr_model: String(slowOcrModelId()) })

      await expect.poll(async () => (await backendFetch('/api/queue')).recognition, { timeout: 10_000 })
        .toEqual([{ id: expect.any(String), pages: 1, lines_total: 6, lines_read: 0, state: 'reading',
                    started_at: expect.any(String) }])

      const second = await recognize(token, 'lines', [{ name: 'one.png', png: scanPng(400, 40, 13) }])
      expect(second.status).toBe(429)
      expect(second.headers.get('retry-after')).toBe('5')
      expect((await second.json()).detail).toBe('this account has a recognition request running already')

      await page.goto('/queue')
      const row = page.getByTestId('queue-recognition')
      await expect(row).toHaveCount(1)
      await expect(row).toContainText('Recognition request')
      await expect(row).toContainText('1 page · reading 0 of 6 lines')
      expect(await row.innerText()).not.toContain(me)

      const response = await answered
      expect(response.status).toBe(200)
      expect((await response.json()).pages[0].lines.map((l: { text: string }) => l.text)).toEqual(READ(6))
      await expect.poll(async () => (await backendFetch('/api/queue')).recognition).toEqual([])
      await expect(row).toHaveCount(0)
    })
})

test.describe('Scenario: a big batch read in its turn', () => {
  test('sent async, pages are answered at once with an id, and once read in their turn come back as an answer at once gives them',
    async ({ page }) => {
      const token = await mint(page, uniqueName('async'))
      const used = await defaults(token)

      const sent = await recognize(token, 'pages', [
        { name: 'scan_a.png', png: scanPng(600, 800, 0) },
        { name: 'scan_b.png', png: scanPng(500, 400, 1) },
      ], { async: 'true' })

      expect(sent.status).toBe(202)
      const queued = await sent.json()
      expect(queued).toEqual({ id: expect.stringMatching(/^[0-9a-f]{12}$/), status: 'queued', place: expect.any(Number),
                               files: 2, done: 0, submitted_at: expect.any(String) })
      expect(sent.headers.get('location')).toBe(`/api/recognize/${queued.id}`)
      await expect.poll(async () => (await asToken(token, `/api/recognize/${queued.id}`)).status,
                        { timeout: 60_000 }).toBe(200)
      expect(await (await asToken(token, `/api/recognize/${queued.id}`)).json()).toEqual({
        id: queued.id, status: 'done', files: 2, done: 2, submitted_at: queued.submitted_at,
        started_at: expect.any(String), finished_at: expect.any(String), expires_at: expect.any(String),
        models: used,
        pages: [pageOf('scan_a.png', 600, 800, LINES_600x800), pageOf('scan_b.png', 500, 400, LINES_500x400)],
      })
    })

  test('a waiting request has its place on the Queue page, where its owner cancels it', async ({ page }) => {
    const token = await mint(page, uniqueName('async queue'))
    const status = async (id: string) => (await asToken(token, `/api/recognize/${id}`)).status
    const state = async (id: string) => (await (await asToken(token, `/api/recognize/${id}`)).json()).status
    // The slow reader takes 15 s over every batch, which holds the GPU for the request behind it.
    const first = await recognize(token, 'pages', [{ name: 'slow.png', png: scanPng(500, 400, 12) }],
                                  { async: 'true', ocr_model: String(slowOcrModelId()) })
    expect(first.status).toBe(202)
    const ahead = (await first.json()).id as string
    const second = await recognize(token, 'lines', [{ name: 'one.png', png: scanPng(400, 40, 13) }], { async: 'true' })
    expect(second.status).toBe(202)
    const behind = (await second.json()).id as string
    await expect.poll(() => state(ahead), { timeout: 30_000 }).toBe('running')
    expect(await state(behind)).toBe('queued')

    await page.goto('/queue')
    const row = (id: string) => page.locator(`[data-testid="queue-row"][data-id="${id}"]`)
    await expect(row(ahead)).toHaveAttribute('data-kind', 'recognition')
    await expect(row(ahead)).toContainText('Recognition request')
    await expect(row(ahead)).toContainText('0 of 1 page read')
    await expect(row(behind)).toContainText('Recognition request')
    await expect(row(behind)).toContainText('1 line image · waiting')
    await row(behind).getByTestId('queue-cancel').click()

    await expect.poll(() => status(behind)).toBe(404)
    await expect(row(behind)).toHaveCount(0)
    await expect(row(ahead)).toHaveCount(1)
    await expect.poll(() => status(ahead), { timeout: 60_000 }).toBe(200)
    const read = await (await asToken(token, `/api/recognize/${ahead}`)).json()
    expect(read.pages[0].lines.map((l: { text: string }) => l.text)).toEqual(READ(6))
    await expect(row(ahead)).toHaveCount(0)
  })
})

test.describe('Scenario: what an account read, and a cap on it', () => {
  test('a request counts on the API usage tab, and a cap set there stops the next one', async ({ page, browser }) => {
    // An account of its own, so no other scenario's requests add to what it read.
    const account = `usage-${Date.now()}`
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    await useSession(context, seedSession('admin', account))
    const token = await mint(await context.newPage(), uniqueName('usage'))

    expect((await recognize(token, 'pages', [{ name: 'u.png', png: scanPng(500, 400, 20) }])).status).toBe(200)

    await page.goto('/admin?tab=usage')
    const row = page.getByTestId('usage-row').filter({ hasText: account })
    await expect(row.locator('[data-stat]')).toHaveText(['1', '1', '6', /^\d/, '0', '0', '0', /^-$/])
    await row.getByLabel(`Monthly cap for ${account}`).fill('6')
    await row.getByLabel(`Monthly cap for ${account}`).press('Enter')
    await expect.poll(async () => (await backendFetch('/api/recognition-usage')).accounts
      .find((a: { account: string }) => a.account === account)?.cap).toBe(6)

    const offered = await (await asToken(token, '/api/recognize')).json()
    expect(offered.usage).toEqual({ month: expect.stringMatching(/^\d{4}-\d{2}$/), lines: 6, cap: 6 })
    const refused = await recognize(token, 'lines', [{ name: 'one.png', png: scanPng(400, 40, 21) }])
    expect(refused.status).toBe(429)
    expect((await refused.json()).detail)
      .toMatch(/^this account has read its 6 lines for this month; it can read again from \d{4}-\d{2}-01$/)
    await context.close()
  })
})


test.describe('Scenario: keeping what a request read as a dataset', () => {
  test('pages read with keep become a dataset of that name, read and unchecked, and the next request adds to it',
    async ({ page }) => {
      const me = (await (await page.request.get('/api/me')).json()).user as string
      const token = await mint(page, uniqueName('keep'))
      const used = await defaults(token)
      const name = uniqueName('Kept pages')
      const scanB = { name: 'scan_b.png', png: scanPng(500, 400, 31) }

      const first = await recognize(token, 'pages', [{ name: 'scan_a.png', png: scanPng(600, 800, 30) }, scanB],
                                    { keep: name })
      expect(first.status).toBe(200)
      const answer = await first.json()
      expect(answer).toEqual({
        models: used,
        pages: [pageOf('scan_a.png', 600, 800, LINES_600x800), pageOf('scan_b.png', 500, 400, LINES_500x400)],
        kept: { dataset: expect.any(String), name, created: true, pages: 2, duplicates: [] },
      })

      const jobId = answer.kept.dataset as string
      const job = await getJob(jobId)
      // What the request chose, so pages added in the app later are read the same way.
      expect(job).toMatchObject({
        name, owner: me, status: 'done', task: 'text', line_mode: 'per_page',
        run_layout: false, run_lines: true, run_ocr: true,
        model_lines_id: null, model_ocr_id: null, ocr_decode: 'auto',
      })
      expect(job.counters).toMatchObject({ pages_total: 2, lines_total: 12, lines_ocr_done: 12 })
      expect(job.pages.map((p: { filename: string; status: string }) => [p.filename, p.status]))
        .toEqual([['scan_a.png', 'done'], ['scan_b.png', 'done']])

      const [pageA, pageB] = await jobPageIds(jobId)
      const keptLines = async (pageId: number, width: number, height: number, outlines: number[][][]) =>
        expect((await pageLines(jobId, pageId)).map((l) => ({
          text: l.text, confidence: l.confidence, checked: l.checked, reader: l.text_author, polygon: l.polygon,
        }))).toEqual(outlines.map((outline, i) => ({
          text: `Sample Text line ${i + 1}`, confidence: STUB_CONFIDENCE, checked: false,
          reader: `model:ocr@${used.ocr.name}`, polygon: outline.map(([x, y]) => [x / width, y / height]),
        })))
      await keptLines(pageA, 600, 800, LINES_600x800)
      await keptLines(pageB, 500, 400, LINES_500x400)

      await openViewer(page, jobId, pageA)
      await expect(page.getByTestId('line-text')).toHaveText(READ(6))

      // In any letter case the name finds the same dataset; a scan it holds already lands
      // as a duplicate, as an upload of it would, and only the new one is read into it.
      const second = await recognize(token, 'pages', [scanB, { name: 'scan_c.png', png: scanPng(500, 400, 32) }],
                                     { keep: name.toUpperCase() })
      expect(second.status).toBe(200)
      expect((await second.json()).kept).toEqual({
        dataset: jobId, name, created: false, pages: 1, duplicates: ['scan_b.png'],
      })
      const grown = await getJob(jobId)
      expect(grown.pages.map((p: { filename: string; status: string }) => [p.filename, p.status])).toEqual([
        ['scan_a.png', 'done'], ['scan_b.png', 'done'], ['scan_b.png', 'duplicate'], ['scan_c.png', 'done'],
      ])
      expect(grown.counters).toMatchObject({ pages_total: 3, lines_total: 18, lines_ocr_done: 18 })
      await keptLines((await jobPageIds(jobId))[3], 500, 400, LINES_500x400)
    })

  test('with layout, a kept page holds its regions as layout elements of their class, each with its lines',
    async ({ page }) => {
      const token = await mint(page, uniqueName('keep layout'))
      const used = await defaults(token)
      const layout = await layoutModel(token)
      const name = uniqueName('Kept with layout')

      const response = await recognize(token, 'pages', [{ name: 'leaf.png', png: scanPng(600, 800, 51) }],
                                       { keep: name, layout_model: String(layout.id) })
      expect(response.status).toBe(200)
      const { kept } = await response.json()
      expect(kept).toEqual({ dataset: expect.any(String), name, created: true, pages: 1, duplicates: [] })

      const job = await getJob(kept.dataset)
      // Pages added in the app later run the same layout model, lines found in each region.
      expect(job).toMatchObject({
        status: 'done', run_layout: true, run_lines: true, run_ocr: true, line_mode: 'per_crop',
        model_layout_id: layout.id, model_lines_id: null, model_ocr_id: null,
      })
      expect(job.counters).toMatchObject({ pages_total: 1, lines_total: 6, lines_ocr_done: 6 })

      const [pageId] = await jobPageIds(kept.dataset)
      const { elements } = await getPageDetail(kept.dataset, pageId)
      type Kept = { id: number; class_name: string; kind: string; bbox: number[]; conf: number
                    lines: { text: string; confidence: number; checked: boolean; text_author: string }[] }
      expect((elements as Kept[]).map((e) => ({
        class: e.class_name, kind: e.kind, bbox: e.bbox, conf: e.conf,
        lines: e.lines.map((l) => [l.text, l.confidence, l.checked, l.text_author]),
      }))).toEqual(REGIONS_600x800.map((region, r) => ({
        class: region.class, kind: 'content', bbox: [0.1, [0.05, 0.2][r], 0.9, [0.15, 0.85][r]], conf: 0.9,
        lines: READ_BY_REGION.filter((l) => l.region === r)
          .map((l) => [l.text, l.confidence, false, `model:ocr@${used.ocr.name}`]),
      })))
      const history = await backendFetch(`/api/elements/${(elements as Kept[])[0].id}/revisions`)
      expect(history.map((r: { author: string; action: string }) => [r.author, r.action]))
        .toEqual([[`model:layout@${layout.name}`, 'create']])

      await openViewer(page, kept.dataset, pageId)
      await expect(page.getByTestId('line-text')).toHaveText(READ_BY_REGION.map((l) => l.text))
    })
})
