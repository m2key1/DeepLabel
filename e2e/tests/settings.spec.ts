import { test, expect } from '../helpers/test'
import {
  correctLine, jobPageIds, pageLines, seedCompletedJob, setKeyboardSource, setPageOverlays,
  uniqueName,
} from '../helpers/api'
import { LANDSCAPE, openViewer } from '../helpers/viewer'

test.describe('Scenario: customizing hotkeys', () => {
  test('a remapped key works in the page viewer', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Hotkeys'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)

    await page.goto('/settings?section=keys')
    const row = page.getByTestId('hotkey-row').filter({ hasText: 'Next line' })
    await row.getByTestId('hotkey-bind').click()
    await expect(row.getByTestId('hotkey-bind')).toHaveText('press a key…')
    await page.keyboard.press('n')
    await expect(row.getByTestId('hotkey-bind')).toHaveText('N')

    await openViewer(page, jobId, pageId)
    await page.mouse.move(2, 2)
    await page.keyboard.press('n')
    await expect(
      page.getByTestId('line-row').filter({ hasText: 'Sample Header line 1' }),
    ).toHaveAttribute('data-hot', 'true')
  })

  test('the virtual keyboard can be pinned, hidden, or shown only while editing', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Vkbd'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)

    const keys = page.getByRole('button', { name: /^Keys/ })
    const glyph = page.getByTitle('Insert ä', { exact: true })

    await expect(glyph).toHaveCount(0) // auto: hidden while not editing
    await keys.click() // show: always visible
    await expect(glyph).toBeVisible()
    await keys.click() // hide: never, not even while editing
    await expect(glyph).toHaveCount(0)
    await page.getByTestId('line-text').first().click()
    await expect(glyph).toHaveCount(0)
    await keys.click() // back to auto, with an active edit -> visible
    await page.getByTestId('line-text').first().click()
    await expect(glyph).toBeVisible()
  })

  test('the keyboard is resized by its corner, and stays that size', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Vkbd size'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)
    // Start an edit rather than pinning the keyboard: the mode is one setting shared by
    // every spec, and leaving it changed takes the keyboard away from all of them.
    await page.getByTestId('line-text').first().click()

    const glyph = page.getByTitle('Insert ä', { exact: true })
    await expect(glyph).toBeVisible()
    const grip = page.getByTestId('keyboard-grip')
    const board = page.locator('div').filter({ has: grip }).last()
    const before = { key: (await glyph.boundingBox())!, board: (await board.boundingBox())! }

    // Up and to the left: wider, with bigger keys. The grip sits at the top-left corner,
    // and the board is centred, so moving out widens it from both sides.
    const at = (await grip.boundingBox())!
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2)
    await page.mouse.down()
    await page.mouse.move(at.x - 120, at.y - 40, { steps: 10 })
    await page.mouse.up()

    await expect.poll(async () => (await glyph.boundingBox())!.height)
      .toBeGreaterThan(before.key.height)
    expect((await board.boundingBox())!.width).toBeGreaterThan(before.board.width)

    // Smaller keys are the lever that shortens it: the same board, less of it.
    const wide = (await board.boundingBox())!
    const now = (await grip.boundingBox())!
    await page.mouse.move(now.x + now.width / 2, now.y + now.height / 2)
    await page.mouse.down()
    await page.mouse.move(now.x, now.y + 60, { steps: 10 })
    await page.mouse.up()
    await expect.poll(async () => (await board.boundingBox())!.height)
      .toBeLessThan(wide.height)

    // It is remembered, so the shape is settled once rather than every page.
    const settled = (await glyph.boundingBox())!.height
    await openViewer(page, jobId, pageId)
    await page.getByTestId('line-text').first().click()
    await expect.poll(async () =>
      (await page.getByTitle('Insert ä', { exact: true }).boundingBox())!.height)
      .toBeCloseTo(settled, 0)
  })

  test('a character typed into Settings joins the palette and reaches the line editor', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Glyphs'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    const palette = async () => (await (await page.request.get('/api/settings')).json()).keyboard

    await page.goto('/settings?section=characters')
    await page.getByTestId('palette-reset').click()
    await expect.poll(palette).toContain('ä') // the save landed; now the palette is known
    const base = await palette()

    // Ꙭ is in no group below: the model reads bytes, so the grid is a starting point
    // rather than the set of characters a palette may hold.
    await page.getByTestId('custom-glyphs').fill('Ꙭ')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect.poll(palette).toEqual([...base, 'Ꙭ'])
    const own = page.getByTestId('own-glyphs').getByRole('button', { name: 'Ꙭ' })
    await expect(own).toBeVisible()

    await openViewer(page, jobId, pageId)
    await page.getByTestId('line-text').first().click()
    await expect(page.getByTitle('Insert Ꙭ', { exact: true })).toBeVisible()

    // and the row it lands in is how it comes back off again
    await page.goto('/settings?section=characters')
    await own.click()
    await expect.poll(palette).toEqual(base)
    await expect(page.getByTestId('own-glyphs')).toHaveCount(0)
  })

  test('an empty palette still says where the keyboard is set up', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('No glyphs'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    const palette = async () => (await (await page.request.get('/api/settings')).json()).keyboard

    await page.goto('/settings?section=characters')
    await page.getByTestId('palette-clear').click()
    await expect.poll(palette).toEqual([])

    // With no keys there is nothing to show - but taking the control away too is what
    // left the keyboard with no way back from the page that wants it.
    await openViewer(page, jobId, pageId)
    const keys = page.getByRole('button', { name: /^Keys/ })
    await expect(keys).toHaveText('Keys none')
    await expect(page.getByTitle('Insert ä', { exact: true })).toHaveCount(0)

    // And it leads to the one place that can fill it.
    await keys.click()
    await expect(page).toHaveURL(/\/people\/dev\?section=characters/)
    await page.getByTestId('palette-reset').click()
    await expect.poll(palette).toContain('ä')

    // Paired: with keys again the same control goes back to cycling the keyboard, and
    // the bar it cycles is there to be shown.
    await openViewer(page, jobId, pageId)
    await expect(page.getByRole('button', { name: /^Keys/ })).toHaveText('Keys auto')
    await page.getByTestId('line-text').first().click()
    await expect(page.getByTitle('Insert ä', { exact: true })).toBeVisible()
  })
})

test.describe('Scenario: arranging the character keyboard', () => {
  const palette = async (page: import('@playwright/test').Page): Promise<string[]> =>
    (await (await page.request.get('/api/settings')).json()).keyboard

  // These tests rearrange the palette, so "it contains ä" would already be true before
  // the reset landed. The defaults' own opening is what proves it did.
  async function resetPalette(page: import('@playwright/test').Page) {
    await page.getByTestId('palette-reset').click()
    await expect.poll(async () => (await palette(page)).slice(0, 3)).toEqual(['ä', 'ö', 'ü'])
  }

  test('a key is moved along the bar, and the bar under the editor follows', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Order'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)

    await page.goto('/settings?section=characters')
    await resetPalette(page)
    const start = await palette(page)

    // Focus the first key and walk it two places to the right.
    const first = page.getByTestId('palette-key').first()
    await first.focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => palette(page)).toEqual(['ö', 'ä', ...start.slice(2)])
    // Focus survives the move, so the next press keeps moving the same character.
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => palette(page)).toEqual(['ö', 'ü', 'ä', ...start.slice(3)])

    // The strip shows the stored order, and so does the bar under the line editor.
    await expect(page.getByTestId('palette-key').first()).toHaveAttribute('data-char', 'ö')
    await openViewer(page, jobId, pageId)
    await page.getByTestId('line-text').first().click()
    const keys = page.locator('[title^="Insert "]')
    await expect(keys.nth(0)).toHaveAttribute('title', 'Insert ö')
    await expect(keys.nth(1)).toHaveAttribute('title', 'Insert ü')
    await expect(keys.nth(2)).toHaveAttribute('title', 'Insert ä')
  })

  test('a key is dragged to a new place', async ({ page }) => {
    await page.goto('/settings?section=characters')
    await resetPalette(page)
    const start = await palette(page)

    const keys = page.getByTestId('palette-key')
    await keys.first().dragTo(keys.nth(2))
    await expect.poll(() => palette(page)).toEqual([start[1], start[2], start[0], ...start.slice(3)])
  })

  test('Backspace takes a key off the bar', async ({ page }) => {
    await page.goto('/settings?section=characters')
    await resetPalette(page)
    const start = await palette(page)

    await page.getByTestId('palette-key').first().focus()
    await page.keyboard.press('Backspace')
    await expect.poll(() => palette(page)).toEqual(start.slice(1))
    await expect(page.getByTestId('palette-key')).toHaveCount(start.length - 1)
  })
})

test.describe('Scenario: reading the Schematismus printer marks', () => {
  // The corpus writes its marks as stand-in codepoints - U+2690 for the flag, U+33CB for
  // the ligature - whose ordinary Unicode shapes look nothing like the page. A subset of
  // the project's own face carries those 27 and no others.
  const MARKS = ['⚐', '㏋', 'Ⓑ', '⬯', 'ʘ']
  const MARKS_IN_ORDER = ['ʘ', '⊕', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', 'Ⓑ', 'Ⓒ', 'Ⓚ', 'Ⓜ', '⚇', '⚐', '✕', '⬯', '㊵', '㏋']

  /** What the face draws for each character against what the fallback draws: a stamp of
   *  the rendered pixels, not the advance width. A hinted face rounds its advance to whole
   *  pixels, and on a machine whose fallback happens to round to the same figure the two
   *  widths agree while the glyphs do not - which is exactly the case that has to count. */
  async function glyphStamps(page: import('@playwright/test').Page, chars: string[],
                             face = 'Schematismus Marks') {
    return page.evaluate(async ({ probe, family }: { probe: string[]; family: string }) => {
      // A face with a unicode-range is fetched only once something in range is drawn, and
      // measuring does not wait for it: ask for it outright.
      await document.fonts.load(`40px "${family}"`, probe.join(''))
      await document.fonts.ready
      const canvas = document.createElement('canvas')
      canvas.width = 64
      canvas.height = 64
      const ctx = canvas.getContext('2d')!
      const stamp = (ch: string, font: string) => {
        ctx.clearRect(0, 0, 64, 64)
        ctx.font = font
        ctx.fillText(ch, 4, 48)
        const data = ctx.getImageData(0, 0, 64, 64).data
        let hash = 2166136261
        for (let i = 3; i < data.length; i += 4) hash = Math.imul(hash ^ data[i], 16777619) >>> 0
        return hash
      }
      return probe.map((ch) => ({
        ch,
        withFace: stamp(ch, `40px "${family}", monospace`),
        fallback: stamp(ch, '40px monospace'),
      }))
    }, { probe: chars, family: face })
  }

  test('the marks render in the project face, and nothing else does', async ({ page }) => {
    await page.goto('/settings?section=characters')
    await expect(page.getByRole('heading', { name: 'Schematismus', exact: true })).toBeVisible()

    expect(await page.evaluate(() => document.fonts.check('16px "Schematismus Marks"'))).toBe(true)

    // Each mark is drawn by the face, so what lands on the canvas differs from the fallback's.
    for (const { ch, withFace, fallback } of await glyphStamps(page, MARKS)) {
      expect(withFace, `${ch} should be drawn by the Schematismus face`).not.toBe(fallback)
    }
    // The subset stops there: ordinary text falls straight through to the reading font,
    // which is what keeps the face out of the way of every other character.
    for (const { ch, withFace, fallback } of await glyphStamps(page, ['a', 'ä', 'ſ', '§'])) {
      expect(withFace, `${ch} should be left to the reading font`).toBe(fallback)
    }
  })

  // The palette has offered the Latin Extended-D abbreviation letters all along with no
  // font behind them: JetBrains Mono's latin-ext declares U+A720-A7FF in its unicode-range
  // and ships none of it, so each of these was drawn by whatever the reader's machine
  // happened to carry, or by nothing at all.
  test('the abbreviation letters have a face of their own to fall back on', async ({ page }) => {
    await page.goto('/settings?section=characters')
    await expect(page.getByRole('heading', { name: 'Schematismus', exact: true })).toBeVisible()

    expect(await page.evaluate(() => document.fonts.check('16px "Abbreviation Marks"'))).toBe(true)

    // The suspension mark the Zollbuecher use, and the neighbours it sits with.
    for (const { ch, withFace, fallback } of
      await glyphStamps(page, ['ꝫ', 'ꝑ', 'ꝓ', 'ꝗ', 'ꝟ', 'ꝭ', 'ꝯ', 'ꝰ'], 'Abbreviation Marks')) {
      expect(withFace, `${ch} should be drawn by the abbreviation face`).not.toBe(fallback)
    }
    // And it stops there, so it cannot take ordinary text off the reading font.
    for (const { ch, withFace, fallback } of
      await glyphStamps(page, ['a', 'ä', 'ſ', '§', '€'], 'Abbreviation Marks')) {
      expect(withFace, `${ch} should be left to the reading font`).toBe(fallback)
    }

    // It is on the palette to be typed, in the group its neighbours are in.
    const special = page.locator('[data-testid="vocab-group"][data-group="Latin - special"]')
    await expect(special.getByRole('button', { name: 'ꝫ', exact: true })).toHaveCount(1)
  })

  test('the marks are a set of their own, and reach the line editor', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Marks'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    const palette = async () => (await (await page.request.get('/api/settings')).json()).keyboard

    await page.goto('/settings?section=characters')
    await page.getByTestId('palette-reset').click()
    await expect.poll(palette).toContain('ä')
    const base = await palette()

    const group = page.locator('[data-testid="vocab-group"][data-group="Schematismus"]')
    await expect(group.getByTestId('group-note')).toContainText('stand-in codepoints')
    // Listed once: the marks left the generic groups, where the same glyph would show twice.
    await expect(page.getByRole('button', { name: '⚐', exact: true })).toHaveCount(1)

    await group.getByRole('button', { name: 'Add all' }).click()
    await expect.poll(palette).toEqual([...base, ...MARKS_IN_ORDER])

    await openViewer(page, jobId, pageId)
    await page.getByTestId('line-text').first().click()
    await expect(page.getByTitle('Insert ⚐', { exact: true })).toBeVisible()
  })
})

test.describe('Scenario: putting keys on the buttons', () => {
  const bindings = (page: import('@playwright/test').Page) => async () =>
    (await (await page.request.get('/api/settings')).json()).hotkeys ?? {}

  const row = (page: import('@playwright/test').Page, command: string) =>
    page.locator(`[data-testid="hotkey-row"][data-command="${command}"]`)

  async function bind(page: import('@playwright/test').Page, command: string, key: string) {
    await row(page, command).getByTestId('hotkey-bind').click()
    await page.keyboard.press(key)
  }

  // Settings load before anything renders, and the bindings arrive with them - a key
  // pressed before that lands on a page that has not been told what it means yet.
  async function ready(page: import('@playwright/test').Page, path: string) {
    await page.goto(path)
    await expect(page.getByRole('link', { name: 'Models' })).toBeVisible()
  }

  test('a key bound to a button runs it, and only where the button is', async ({ page }) => {
    await page.goto('/settings?section=keys')
    await bind(page, 'goModels', 'F2')
    await expect.poll(bindings(page)).toMatchObject({ goModels: 'f2' })

    // The nav is on every page, so this one works from anywhere.
    await ready(page, '/')
    await page.keyboard.press('F2')
    await expect(page).toHaveURL(/\/models$/)

    // Dataset commands are offered by the dataset page alone. Bound, but with no button
    // on screen to run, the key does nothing rather than something surprising.
    await page.goto('/settings?section=keys')
    await bind(page, 'transcript', 'F4')
    await expect.poll(bindings(page)).toMatchObject({ transcript: 'f4' })
    await ready(page, '/models')
    await page.keyboard.press('F4')
    await expect(page).toHaveURL(/\/models$/)
  })

  test('the same key cannot run two commands: binding it moves it', async ({ page }) => {
    await page.goto('/settings?section=keys')
    await bind(page, 'goQueue', 'F7')
    await expect.poll(bindings(page)).toMatchObject({ goQueue: 'f7' })

    await bind(page, 'goSettings', 'F7')
    await expect.poll(bindings(page)).toMatchObject({ goSettings: 'f7', goQueue: '' })
    await expect(row(page, 'goQueue').getByTestId('hotkey-bind')).toHaveText('-')
    await expect(row(page, 'goSettings').getByTestId('hotkey-bind')).toHaveText('F7')

    await ready(page, '/')
    await page.keyboard.press('F7')
    await expect(page).toHaveURL(/\/people\/dev$/)
  })

  test('the page viewer and the map editor may put one key on different things', async ({ page }) => {
    await page.goto('/settings?section=keys')
    // A viewer command and a map command are never on screen together, so both keep F9.
    await bind(page, 'mapReduce', 'F9')
    await bind(page, 'rotateCw', 'F9')
    await expect.poll(bindings(page)).toMatchObject({ mapReduce: 'f9', rotateCw: 'f9' })
    await expect(row(page, 'mapReduce').getByTestId('hotkey-bind')).toHaveText('F9')
    await expect(row(page, 'rotateCw').getByTestId('hotkey-bind')).toHaveText('F9')
    await expect(row(page, 'rotateCw')).toContainText('also Map editor: Reduce polygons')

    // A command of both editors could meet either of them, so it takes the key off both.
    await bind(page, 'toolDraw', 'F9')
    await expect.poll(bindings(page)).toMatchObject({ toolDraw: 'f9', mapReduce: '', rotateCw: '' })
    await expect(row(page, 'mapReduce').getByTestId('hotkey-bind')).toHaveText('-')
  })

  test('a cleared key stops running its command', async ({ page }) => {
    await page.goto('/settings?section=keys')
    await bind(page, 'goModels', 'F8')
    await ready(page, '/')
    await page.keyboard.press('F8')
    await expect(page).toHaveURL(/\/models$/)

    await page.goto('/settings?section=keys')
    await row(page, 'goModels').getByTestId('hotkey-clear').click()
    await expect.poll(bindings(page)).toMatchObject({ goModels: '' })
    await ready(page, '/')
    await page.keyboard.press('F8')
    await expect(page).toHaveURL(/\/$/)
  })

  test('a plain letter typed into a field is text, not a command', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Typing'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)

    await page.goto('/settings?section=keys')
    await bind(page, 'goModels', 'q')
    await expect.poll(bindings(page)).toMatchObject({ goModels: 'q' })

    await openViewer(page, jobId, pageId)
    await page.getByTestId('line-text').first().click()
    const field = page.getByTestId('line-editor')
    await field.fill('')
    await field.pressSequentially('quer')
    await expect(field).toHaveValue('quer')
    await expect(page).toHaveURL(new RegExp(`/pages/${pageId}`))
  })
})

test.describe('Scenario: what a freshly opened page shows', () => {
  // These are the signed-in user's settings on the backend, and every spec runs as the
  // same user: leaving them changed changes what every later spec's viewer opens with.
  test.afterEach(({ page }) => setPageOverlays(page))

  const overlays = (page: import('@playwright/test').Page) => async () =>
    (await (await page.request.get('/api/settings')).json()).page_overlays ?? null

  test('the overlays a page opens with are the ones chosen in Settings', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Overlays'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)

    await page.goto('/settings?section=opening')
    await page.getByTestId('overlay-default-lines').check()
    await page.getByTestId('overlay-default-layout').uncheck()
    await expect.poll(overlays(page)).toEqual(
      { layout: false, lines: true, labels: true, confidence: false, order: false })

    await openViewer(page, jobId, pageId)
    const overlay = page.getByTestId('overlay-box')
    await expect(overlay.locator('svg polygon')).toHaveCount(6)
    await expect(overlay.locator('rect[data-id]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Lines', exact: true })).toHaveAttribute(
      'aria-pressed', 'true')

    // The same locator finds the boxes once the toolbar turns them on, so the count of
    // zero above is the preference at work rather than a selector that matches nothing.
    await page.getByRole('button', { name: 'Layout', exact: true }).click()
    await expect(overlay.locator('rect[data-id]')).toHaveCount(2)
  })

  test('switching an overlay in the viewer leaves the preference alone', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Overlays'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)

    await page.goto('/settings?section=opening')
    await page.getByTestId('overlay-default-order').check()
    await expect.poll(overlays(page)).toMatchObject({ order: true })

    await openViewer(page, jobId, pageId)
    await expect(page.getByTestId('overlay-box').locator('marker#ro-arrow')).toHaveCount(1)
    await page.getByRole('button', { name: 'Order' }).click()
    await expect(page.getByTestId('overlay-box').locator('marker#ro-arrow')).toHaveCount(0)

    await expect.poll(overlays(page)).toMatchObject({ order: true })
    await page.reload()
    await expect(page.getByTestId('overlay-box').locator('marker#ro-arrow')).toHaveCount(1)
  })
})

test.describe('Scenario: a keyboard that fills itself', () => {
  // The source is the signed-in person's setting, and every spec runs as that person.
  test.afterEach(({ page }) => setKeyboardSource(page))

  const key = (page: import('@playwright/test').Page, char: string) =>
    page.getByTitle(`Insert ${char}`, { exact: true })

  test('the keys are what the dataset writes, not what you picked', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Filled'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    const [first, second] = await pageLines(jobId, pageId)
    // ℥ is in no default palette, ½ is in every one: between them they say which palette
    // is on screen. The two lines spell the same letter the two ways a corpus holds it.
    await correctLine(first.id, 'Mitgl. der Staats-Haupt-Kassen-Pr\u00fcf. ⁊ ℥')
    await correctLine(second.id, 'Kassen-Pru\u0308f.')

    // Backend oracle: what the dataset writes that a keyboard cannot, decomposed - the
    // form the editor inserts - and each letter once however the corpus spells it.
    const held = await (await page.request.get(`/api/jobs/${jobId}/characters`)).json()
    expect(held.characters).toEqual(['u\u0308', '⁊', '℥'])

    await page.goto('/settings?section=characters')
    await page.getByTestId('keyboard-source-dataset').check()
    await openViewer(page, jobId, pageId)
    await page.getByTestId('line-text').first().click()

    await expect(key(page, '℥')).toBeVisible()
    await expect(key(page, '⁊')).toBeVisible()
    await expect(key(page, 'u\u0308')).toHaveCount(1)
    await expect(key(page, '½')).toHaveCount(0)
  })

  test('a character typed into a correction is a key at once', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Growing'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    const [first] = await pageLines(jobId, pageId)
    await correctLine(first.id, 'Pru\u0308f.')

    await page.goto('/settings?section=characters')
    await page.getByTestId('keyboard-source-dataset').check()
    await openViewer(page, jobId, pageId)
    await page.getByTestId('line-text').first().click()
    await expect(key(page, 'u\u0308')).toBeVisible()
    await expect(key(page, '⚠')).toHaveCount(0)

    await page.getByTestId('line-editor').pressSequentially('⚠')

    await expect(key(page, '⚠')).toBeVisible()
  })

  test('your own picks stand in until the dataset has been read', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Unread'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)

    await page.goto('/settings?section=characters')
    await page.getByTestId('keyboard-source-dataset').check()
    await openViewer(page, jobId, pageId)
    await page.getByTestId('line-text').first().click()

    // The stub reads plain ASCII, so the dataset offers nothing and the palette is yours.
    await expect(key(page, '½')).toBeVisible()
  })
})

test.describe('Scenario: adding a character the palette already holds', () => {
  test('a pasted decomposed umlaut is the same key as the one in the grid', async ({ page }) => {
    const palette = async () => (await (await page.request.get('/api/settings')).json()).keyboard
    await page.goto('/settings?section=characters')
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/settings')
                                              && r.request().method() !== 'GET')
    await page.getByTestId('palette-reset').click()
    await saved
    const base = await palette()
    expect(base).toContain('ä')

    // Corpus text arrives decomposed: a, then a combining diaeresis.
    await page.getByTestId('custom-glyphs').fill('ä')
    await page.getByRole('button', { name: 'Add', exact: true }).click()

    await expect(page.getByTestId('custom-glyphs')).toHaveValue('')
    // A character the palette lacks, added after it: once that save has landed, anything
    // the umlaut added would have landed before it.
    await page.getByTestId('custom-glyphs').fill('Ꙭ')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect.poll(palette).toContain('Ꙭ')
    expect(await palette()).toEqual([...base, 'Ꙭ'])

    await page.getByTestId('palette-reset').click()
    await expect.poll(palette).toEqual(base)
  })
})
