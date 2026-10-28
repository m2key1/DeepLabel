import { test, expect } from '../helpers/test'
import {
  createGroup,
  createJob,
  datasetInfo,
  getJob,
  getPageDetail,
  getReocrPreview,
  identity,
  jobPageIds,
  listJobs,
  listRegistryModels,
  markLinesChecked,
  moveJobToGroup,
  seedCompletedJob,
  setOcrConvention,
  shareJob,
  uniqueName,
  waitForJobStatus,
} from '../helpers/api'
import { seedMapJob } from '../helpers/map'
import { seedSession } from '../helpers/session'

test.describe('Scenario: managing datasets from the list', () => {
  test('an admin shares a dataset with a member from the card menu', async ({ page }) => {
    const name = uniqueName('Shareable')
    await seedCompletedJob(name, 1)
    const username = `colleague-${Date.now()}`
    seedSession('member', username)

    await page.goto('/')
    const card = page.getByTestId('job-card').filter({ hasText: name })
    await card.getByTestId('job-menu').click()
    await card.getByRole('button', { name: 'Share…' }).click()
    await page.getByRole('checkbox', { name: username }).check()
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(card.getByText('shared with 1')).toBeVisible()
  })

  test('changing ocr settings offers a safe immediate re-run', async ({ page }) => {
    const name = uniqueName('Model pick')
    const jobId = await seedCompletedJob(name, 1)
    await markLinesChecked(jobId, 2)
    const [pageId] = await jobPageIds(jobId)
    const before = (await getPageDetail(jobId, pageId)).elements.flatMap(
      (e: { lines: { id: number; text: string; checked: boolean }[] }) => e.lines)
    const checkedBefore = before.filter((l: { checked: boolean }) => l.checked)
    expect(checkedBefore).toHaveLength(2)
    const builtinOcr = (await listRegistryModels()).find((m) => m.task === 'ocr' && m.source === 'backend')!

    await page.goto('/')
    const card = page.getByTestId('job-card').filter({ hasText: name })
    await card.getByTestId('job-menu').click()
    await card.getByRole('button', { name: 'Models…' }).click()

    // Fresh datasets follow the task defaults for every stage, and the LM beam decode.
    await expect(page.getByTestId('model-pick-ocr')).toHaveValue('')
    await expect(page.getByTestId('pick-decode')).toHaveValue('beam')
    await page.getByTestId('model-pick-ocr').selectOption(String(builtinOcr.id))
    await page.getByTestId('pick-decode').selectOption('greedy')
    await page.getByRole('button', { name: 'Save' }).click()

    // Saving a changed OCR setup offers the re-run with exact numbers.
    await expect(page.getByTestId('apply-summary')).toHaveText(
      /4 unchecked lines will be re-read with the new OCR settings\. 2 checked lines keep their text\./)
    await page.getByRole('button', { name: 'Re-run OCR now' }).click()

    // The picks are pinned and the re-run walks the queue back to done.
    await expect.poll(async () => {
      const job = await getJob(jobId)
      return { model: job.model_ocr_id, decode: job.ocr_decode }
    }).toEqual({ model: builtinOcr.id, decode: 'greedy' })
    // The job is already 'done' when the re-run is queued, so waiting for that status
    // can return before the worker has even picked it up. Wait for the re-read itself -
    // once provenance shows the greedy pass, the job is genuinely past OCR.
    await expect
      .poll(async () => {
        const p = await getReocrPreview(jobId)
        return p.authors.find((a) => a.author.endsWith('#greedy'))?.lines ?? 0
      })
      .toBe(4)
    await waitForJobStatus(jobId, 'done')

    // The OCR bar must land exactly on total: a re-run reprocesses lines that
    // already had text, which must not be double-counted (6 lines on 1 page).
    const counters = (await getJob(jobId)).counters
    expect(counters.lines_total).toBe(6)
    expect(counters.lines_ocr_done).toBe(6)

    // Checked lines kept their exact text; the other 4 were re-read with greedy
    // decoding, which the provenance records per line.
    const after = (await getPageDetail(jobId, pageId)).elements.flatMap(
      (e: { lines: { id: number; text: string; checked: boolean }[] }) => e.lines)
    for (const line of checkedBefore) {
      expect(after.find((l: { id: number }) => l.id === line.id)!.text).toBe(line.text)
    }
    const preview = await getReocrPreview(jobId)
    const greedy = preview.authors.find((a) => a.author.endsWith('#greedy'))
    const original = preview.authors.find((a) => !a.author.endsWith('#greedy'))
    expect(greedy?.lines).toBe(4)
    expect(original?.lines).toBe(2)

    // Reopening shows the pinned picks and flags the mixed provenance.
    await card.getByTestId('job-menu').click()
    await card.getByRole('button', { name: 'Models…' }).click()
    await expect(page.getByTestId('model-pick-ocr')).toHaveValue(String(builtinOcr.id))
    await expect(page.getByTestId('pick-decode')).toHaveValue('greedy')
    await expect(page.getByTestId('ocr-provenance')).toContainText('mixed provenance')
  })

  test('the transcription convention is chosen per dataset and re-reads unchecked lines', async ({ page }) => {
    const name = uniqueName('Convention')
    const jobId = await seedCompletedJob(name, 1)
    await markLinesChecked(jobId, 2)
    const [pageId] = await jobPageIds(jobId)
    const linesOf = async () => (await getPageDetail(jobId, pageId)).elements.flatMap(
      (e: { lines: { id: number; text: string; checked: boolean }[] }) => e.lines)
    const checkedBefore = (await linesOf()).filter((l: { checked: boolean }) => l.checked)
    expect(checkedBefore).toHaveLength(2)
    const builtinOcr = (await listRegistryModels()).find((m) => m.task === 'ocr' && m.source === 'backend')!

    await page.goto('/')
    const card = page.getByTestId('job-card').filter({ hasText: name })
    const openModels = async () => {
      await card.getByTestId('job-menu').click()
      await card.getByRole('button', { name: 'Models…' }).click()
    }
    await openModels()
    await page.getByTestId('model-pick-ocr').selectOption(String(builtinOcr.id))

    // One switch per flag the stub model knows, in its order, all off for a new dataset.
    const flags = page.getByTestId('convention-flag')
    await expect(flags).toHaveCount(4)
    expect(await flags.evaluateAll((els) => els.map((el) => el.getAttribute('data-flag')))).toEqual(
      ['long_s', 'oblique_hyphen', 'typographic_punctuation', 'abbreviations'])
    for (const box of await flags.getByRole('checkbox').all()) await expect(box).not.toBeChecked()
    await expect(page.getByTestId('convention-read')).toHaveText('Last read normalized.')

    await flags.filter({ hasText: 'Long s' }).getByRole('checkbox').check()
    await flags.filter({ hasText: 'Abbreviations' }).getByRole('checkbox').check()
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByTestId('apply-summary')).toHaveText(
      /4 unchecked lines will be re-read with the new OCR settings\. 2 checked lines keep their text\./)
    await page.getByRole('button', { name: 'Re-run OCR now' }).click()

    await expect.poll(async () => (await getJob(jobId)).ocr_convention)
      .toEqual({ long_s: true, abbreviations: true })
    await expect.poll(async () => (await getJob(jobId)).ocr_convention_read)
      .toEqual(['long_s', 'abbreviations'])
    await expect.poll(async () => (await linesOf())
      .filter((l: { text: string }) => l.text.endsWith(' [long_s] [abbreviations]')).length).toBe(4)
    await waitForJobStatus(jobId, 'done')
    const after = await linesOf()
    for (const line of checkedBefore) {
      expect(after.find((l: { id: number }) => l.id === line.id)!.text).toBe(line.text)
    }

    // A flag the model does not know stays set and says so.
    await setOcrConvention(jobId, { long_s: true, ligatures: true })
    await page.reload()
    await openModels()
    await expect(flags).toHaveCount(5)
    const unknown = flags.filter({ hasText: 'Ligatures' })
    await expect(unknown).toHaveAttribute('data-supported', 'false')
    await expect(unknown).toContainText('not supported by this model')
    await expect(unknown.getByRole('checkbox')).toBeChecked()
    const known = flags.filter({ hasText: 'Long s' })
    await expect(known).toHaveAttribute('data-supported', 'true')
    await expect(known.getByRole('checkbox')).toBeChecked()
    await expect(page.getByTestId('convention-read')).toHaveText('Last read with long s, abbreviations.')
  })

  test('a finished dataset carries no status chip and offers downloads', async ({ page }) => {
    const name = uniqueName('Finished')
    const jobId = await seedCompletedJob(name)

    await page.goto('/')
    const card = page.getByTestId('job-card').filter({ hasText: name })
    // Done is the ordinary state, so it is left unsaid; running and cancelled keep their chip below.
    await expect(card).toHaveAttribute('data-status', 'done')
    await expect(card.getByTestId('status-badge')).toHaveCount(0)

    // Timestamps render in European 24h format, converted from the backend's UTC. They
    // live in the Info panel now, with the rest of a dataset's provenance.
    const createdAt = (await getJob(jobId)).created_at as string
    const expected = new Date(`${createdAt.replace(' ', 'T')}Z`).toLocaleString('de-AT', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    })
    expect(expected).toMatch(/^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/)
    await card.getByTestId('job-info-toggle').click()
    await expect(page.getByTestId('job-info')).toContainText(expected)
    await card.getByTestId('job-info-toggle').click()
    // Layout progress counts pages, OCR progress counts lines (2 pages x 6 lines).
    await expect(card.getByText('0/2')).toBeVisible()
    await expect(card.getByText('0/12')).toBeVisible()

    const download = card.getByRole('button', { name: 'Download' })
    await expect(download).toBeEnabled()
    await download.click()
    for (const format of ['page', 'alto', 'hocr', 'tei', 'zip', 'json', 'md', 'txt']) {
      const link = card.locator(`[data-testid="export-format"][data-format="${format}"]`)
      await expect(link).toBeVisible()
      // The export must really produce content, not just render a link.
      const res = await page.request.get((await link.getAttribute('href'))!)
      expect(res.status()).toBe(200)
      const body = await res.body()
      // Not just "non-empty": an export that answered "{}" would pass that. The stub
      // reads every page the same way, so the transcription has to be in there.
      if (['json', 'md', 'txt'].includes(format)) expect(body.toString()).toContain('Sample Header line 1')
      else expect(body.subarray(0, 2).toString()).toBe('PK')
    }
  })

  // A map job runs no line detection and no OCR, so its ocr bar could only ever read 0/0,
  // and its link pointed at a filter that matches no tile.
  test('a map dataset shows review progress without an OCR bar', async ({ page }) => {
    const name = uniqueName('Map progress')
    await seedMapJob(name, 2)

    await page.goto('/')
    const card = page.getByTestId('job-card').filter({ hasText: name })
    // The one bar counts tiles marked reviewed, and says so - the same pages.layout_checked
    // column the job page labels "Reviewed" for a map job.
    await expect(card.getByTestId('layout-progress-link')).toContainText('reviewed')
    await expect(card.getByText('0/2')).toBeVisible()
    await expect(card.getByTestId('ocr-progress-link')).toHaveCount(0)
  })

  test('the info panel says where a dataset came from and what it holds', async ({ page }) => {
    const name = uniqueName('Provenance')
    const jobId = await seedCompletedJob(name, 2)
    await markLinesChecked(jobId, 3)
    const group = await createGroup(uniqueName('Project'))
    await moveJobToGroup(jobId, group.id)

    // Two uploaded PNGs, six lines each, three of them checked by the seeding account.
    const info = await datasetInfo(jobId)
    expect({ pages: info.pages, images: info.images, lines: info.lines, checked: info.lines_checked })
      .toEqual({ pages: 2, images: 2, lines: 12, checked: 3 })
    expect(info.editors.map((e) => ({ author: e.author, edits: e.edits })))
      .toEqual([{ author: 'e2e-seeder', edits: 3 }])
    expect(info.editors[0].last_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

    await page.goto('/')
    const card = page.getByTestId('job-card').filter({ hasText: name })
    await card.getByTestId('job-info-toggle').click()

    const panel = card.getByTestId('job-info')
    const field = (key: string) => panel.locator(`[data-field="${key}"]`)
    await expect(field('owner')).toContainText('e2e-seeder')
    await expect(field('group')).toContainText(group.name)
    await expect(field('pages')).toContainText('2 pages')
    await expect(field('sources')).toContainText('2 images')
    await expect(field('lines')).toContainText('12 lines · 3 reviewed')
    // Two elements per page over two pages - the stub reads every page the same way.
    expect(info.elements).toBe(4)
    await expect(field('elements')).toContainText('4 elements')
    await expect(field('editors')).toContainText('e2e-seeder (3)')

    // The size is broken down by where the bytes sit, and matches the directories the
    // backend actually walked.
    // Compression makes the absolute size vary, so what is pinned is that the total is
    // the breakdown: a directory counted twice, or missed, shows up here.
    expect(info.disk_bytes).toBe(
      Object.values(info.disk).reduce((total: number, bytes) => total + (bytes as number), 0))
    await expect(panel.getByTestId('info-size')).toHaveText(/^\d+(\.\d+)? (B|KB|MB)$/)
    await expect
      .poll(async () => (await panel.getByTestId('info-area').evaluateAll(
        (els) => els.map((el) => el.getAttribute('data-area')))).sort())
      .toEqual(Object.keys(info.disk).sort())
  })

  test('a running job can be cancelled', async ({ page }) => {
    const name = uniqueName('[slow] Cancellable')
    const jobId = await createJob(name, 1)
    await waitForJobStatus(jobId, 'running')

    await page.goto('/')
    const card = page.getByTestId('job-card').filter({ hasText: name })
    await expect(card.getByTestId('status-badge')).toHaveText('running')
    await card.getByTestId('job-menu').click()
    await card.getByRole('button', { name: 'Cancel run' }).click()
    await expect(card.getByTestId('status-badge')).toHaveText('cancelled')
  })

  test('deleting a dataset removes it after confirmation', async ({ page }) => {
    const name = uniqueName('Doomed')
    await seedCompletedJob(name, 1)

    await page.goto('/')
    const link = page.getByRole('link', { name, exact: true })
    await expect(link).toBeVisible()

    const card = page.getByTestId('job-card').filter({ hasText: name })
    page.on('dialog', (dialog) => dialog.accept())
    await card.getByTestId('job-menu').click()
    await card.getByRole('button', { name: 'Delete' }).click()
    await expect(link).not.toBeVisible()
  })
})

/** Datasets the helpers seed are owned by this account, not by the signed-in dev admin. */
const SEEDER = 'e2e-seeder'

test.describe('Scenario: dividing and narrowing the list', () => {
  test('the list can be grouped by owner, or not at all', async ({ page }) => {
    const mine = uniqueName('Divided mine')
    const theirs = uniqueName('Divided theirs')
    const other = `divider-${Date.now()}`
    seedSession('member', other)
    await seedCompletedJob(mine, 1)
    await createJob(theirs, 1, undefined, identity(other, 'member'))
    await waitForJobStatus((await listJobs()).find((j) => j.name === theirs)!.id, 'done')

    // By owner: two headings, each holding only that person's datasets.
    await page.goto('/?by=owner')
    const section = (owner: string) =>
      page.locator(`[data-testid="list-section"][data-title="${owner}"]`)
    await expect(section(SEEDER).getByTestId('job-card').filter({ hasText: mine })).toHaveCount(1)
    await expect(section(SEEDER).getByTestId('job-card').filter({ hasText: theirs })).toHaveCount(0)
    await expect(section(other).getByTestId('job-card').filter({ hasText: theirs })).toHaveCount(1)

    // Not at all: one list, both datasets, no owner heading left to scope by.
    await page.goto('/?by=none')
    await expect(page.getByTestId('job-card').filter({ hasText: mine })).toHaveCount(1)
    await expect(page.getByTestId('job-card').filter({ hasText: theirs })).toHaveCount(1)
    await expect(page.locator(`[data-testid="list-section"][data-title="${other}"]`)).toHaveCount(0)
  })

  test('the lens shows what one person reaches, and says so', async ({ page }) => {
    const watcher = `lens-watcher-${Date.now()}`
    seedSession('member', watcher)
    const reachable = uniqueName('Lens shared')
    const hidden = uniqueName('Lens private')
    const sharedId = await seedCompletedJob(reachable, 1)
    await seedCompletedJob(hidden, 1)
    await shareJob(sharedId, [watcher])

    await page.goto(`/?as=${watcher}`)
    // The strip is the point: a narrowed list that does not say so is a lie.
    await expect(page.getByTestId('lens-strip')).toContainText(watcher)
    await expect(page.getByTestId('job-card').filter({ hasText: reachable })).toHaveCount(1)
    await expect(page.getByTestId('job-card').filter({ hasText: hidden })).toHaveCount(0)

    // Backend oracle: that is what the person's own session is actually served.
    const theirs = await listJobs(identity(watcher, 'member'))
    expect(theirs.map((j) => j.name)).toContain(reachable)
    expect(theirs.map((j) => j.name)).not.toContain(hidden)

    // And clearing it puts the hidden one back, so the absence above was the lens.
    await page.getByRole('button', { name: 'Show all datasets' }).click()
    await expect(page.getByTestId('job-card').filter({ hasText: hidden })).toHaveCount(1)
  })
})

test.describe('Scenario: the row fits the column it is in', () => {
  test('no cell paints over the one beside it', async ({ page }) => {
    // Deliberately awkward: a long name, a share list, and counters with digits in them.
    const name = uniqueName('A dataset with a generously long name for the column')
    const jobId = await seedCompletedJob(name, 2)
    const watchers: string[] = []
    for (let i = 0; i < 5; i++) {
      const u = `fits${i}-${Date.now()}`
      seedSession('member', u)
      watchers.push(u)
    }
    await shareJob(jobId, watchers)
    await markLinesChecked(jobId, 4)

    await page.goto('/')
    const row = page.getByTestId('job-card').filter({ hasText: name })
    await expect(row).toHaveCount(1)

    // The table is fixed-layout, so a cell that outgrows its column used to paint over
    // its neighbour rather than be clipped by it - which is what put the access avatars
    // on top of the progress bars.
    const spills = await row.evaluate((tr) =>
      [...tr.querySelectorAll('td[data-col]')]
        .map((td) => {
          const cell = td.getBoundingClientRect()
          const kid = td.firstElementChild?.getBoundingClientRect()
          return { col: (td as HTMLElement).dataset.col,
                   over: kid ? Math.round(kid.right - cell.right) : 0,
                   clipped: getComputedStyle(td).overflowX === 'hidden' }
        })
        .filter((c) => c.over > 0 || !c.clipped))
    expect(spills).toEqual([])

    // And the progress figures are readable rather than cut off: both counts are whole.
    const ocr = row.getByTestId('ocr-progress-link')
    await expect(ocr).toContainText('/')
    const cut = await ocr.evaluate((el) => {
      const n = el.lastElementChild as HTMLElement
      return n.scrollWidth > n.clientWidth + 1
    })
    expect(cut, 'the line count is shown in full, not clipped').toBe(false)
  })
})

test.describe('Scenario: a narrow window', () => {
  test('the groups are still reachable, folded rather than gone', async ({ page }) => {
    const name = uniqueName('Narrow')
    await seedCompletedJob(name, 1)
    await page.setViewportSize({ width: 640, height: 800 })
    await page.goto('/')

    // It used to be display:none below the medium breakpoint, with nothing anywhere to
    // bring it back - the groups were simply unreachable on a small window.
    const rail = page.getByTestId('dataset-sidebar')
    await expect(rail).toBeVisible()
    await expect(page.getByTestId('job-card').filter({ hasText: name })).toHaveCount(1)

    // And it folds, so the table can have the room back without losing the way in.
    await rail.getByTestId('sidebar-collapse').click()
    await expect(rail).toHaveAttribute('data-collapsed', '')
    const folded = (await rail.boundingBox())!.width
    expect(folded).toBeLessThan(60)
    await rail.getByTestId('sidebar-expand').click()
    await expect(rail.getByTestId('sidebar-collapse')).toBeVisible()
    expect((await rail.boundingBox())!.width).toBeGreaterThan(folded)
  })
})

test.describe('Scenario: arriving at the dataset list', () => {
  test('cards are stood in for while the first response is on its way', async ({ page }) => {
    const name = uniqueName('Skeleton')
    await seedCompletedJob(name, 1)
    // Hold the listing back so the state before it lands can be looked at at all.
    await page.route('**/api/jobs', async (route) => {
      await new Promise((r) => setTimeout(r, 1500))
      await route.continue()
    })

    await page.goto('/')
    await expect(page.getByTestId('jobs-skeleton')).toBeVisible()
    // The real cards replace it rather than appearing beside it.
    await expect(page.getByTestId('job-card').filter({ hasText: name })).toBeVisible()
    await expect(page.getByTestId('jobs-skeleton')).toHaveCount(0)
  })
})

test.describe('Scenario: downloading from the list', () => {
  test('the download menu shows every format and what it is for, nothing cut off', async ({ page }) => {
    const name = uniqueName('Menu width')
    await seedCompletedJob(name, 1)
    await page.goto(`/?q=${encodeURIComponent(name)}`)
    await page.getByTestId('job-card').filter({ hasText: name }).getByTitle('Download this dataset').click()
    const menu = page.getByTestId('export-menu')
    await expect(menu.getByTestId('export-format')).toHaveCount(8)
    const popover = (await menu.locator('..').boundingBox())!
    // Every format's line, hint included, ends inside the popover rather than under its edge.
    for (const link of await menu.getByTestId('export-format').all()) {
      const hint = (await link.locator('span').last().boundingBox())!
      expect(hint.x + hint.width).toBeLessThanOrEqual(popover.x + popover.width)
      expect(await link.locator('span').last().evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
    }
    await expect(menu.locator('[data-format="page"]')).toContainText('Transkribus, eScriptorium, OCR-D')
  })
})
