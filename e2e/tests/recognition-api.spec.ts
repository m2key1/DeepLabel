import { test, expect } from '../helpers/test'
import type { Page } from '@playwright/test'
import { backendFetch, slowOcrModelId, uniqueName } from '../helpers/api'
import { FRONTEND } from '../helpers/frontend'
import { scanPng } from '../helpers/image'
import { seedSession, useSession } from '../helpers/session'

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

interface Offered { id: number; name: string; default: boolean; default_decode?: string }

async function defaults(token: string) {
  const offered = await (await asToken(token, '/api/recognize')).json()
  const lines = offered.models.lines.find((m: Offered) => m.default)
  const ocr = offered.models.ocr.find((m: Offered) => m.default)
  return {
    lines: { id: lines.id, name: lines.name },
    ocr: { id: ocr.id, name: ocr.name, decode: ocr.default_decode },
  }
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
      expect(offered.limits).toEqual({ pages: 10, lines: 500, megabytes: 100 })
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

      const username = uniqueName('member').replace(/\s/g, '-')
      const session = seedSession('member', username)
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
