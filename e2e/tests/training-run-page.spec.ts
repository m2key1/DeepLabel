import type { Locator, Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import {
  backendFetch, createTraining, getPageDetail, getTrainingProgress, jobPageIds, listEvaluations, listTrainings,
  markLinesChecked, seedCompletedJob, uniqueName,
} from '../helpers/api'

interface Bin { lo: number; hi: number | null; n: number }
interface StoredChar { char: string; codepoints: string[]; name: string; total: number; train: number; val: number }
interface StoredPreflight {
  status: string
  result: {
    crops: { height: { bins: Bin[] } }
    text: { characters: StoredChar[] }
  }
}

// One finished stub run whose valid split spans two datasets, so the page has six charts
// (cer, loss, train/grad_norm, cer by dataset, and the time per epoch and throughput worked
// out from its stamped points) and a two-line legend to click. The stub
// trainer writes loss 2.5 / 1.5 / 0.5 and cer 0.5 / 0.3 / 0.1 for epochs 1-3, and each
// valid dataset's cer is the overall one plus 0.01 times its rank by job id.
let runId: number
let validIds: [string, string]

test.beforeAll(async () => {
  test.setTimeout(120_000)
  const trainJob = await seedCompletedJob(uniqueName('Run page train'), 1)
  const validA = await seedCompletedJob(uniqueName('Run page valid A'), 1)
  const validB = await seedCompletedJob(uniqueName('Run page valid B'), 1)
  await markLinesChecked(trainJob, 3)
  await markLinesChecked(validA, 2)
  await markLinesChecked(validB, 2)
  const name = uniqueName('Run page')
  await createTraining({ task: 'ocr', name, dataset_job_ids: [trainJob], target: 'local',
                         split_strategy: 'holdout', valid_job_ids: [validA, validB], epochs: 3 })
  await expect.poll(async () => (await listTrainings()).find((t) => t.name === name)?.status,
                    { timeout: 60_000 }).toBe('done')
  runId = (await listTrainings()).find((t) => t.name === name)!.id
  validIds = [validA, validB].sort() as [string, string]
  await expect.poll(async () => (await backendFetch(`/api/trainings/${runId}/preflight`) as StoredPreflight).status,
                    { timeout: 30_000 }).toBe('done')
})

const chart = (page: Page, metric: string) => page.locator(`[data-testid="metric-chart"][data-metric="${metric}"]`)

/** Hovers a chart at a fraction of its plot's width, 0 the left edge and 1 the right. */
async function hoverAt(target: Locator, fraction: number) {
  const box = (await target.getByTestId('plot-area').boundingBox())!
  await target.page().mouse.move(box.x + box.width * fraction, box.y + box.height / 2)
}

async function openCurvesOnEpochs(page: Page) {
  await page.goto(`/models/runs/${runId}?tab=curves`)
  await page.getByTestId('curve-toolbar').getByRole('button', { name: 'epoch', exact: true }).click()
  await expect(chart(page, 'cer')).toHaveAttribute('data-axis', 'epoch')
}

test.describe('Scenario: a run page in tabs', () => {
  test('each tab has its own address and the strip is driven from the keyboard', async ({ page }) => {
    await page.goto(`/models/runs/${runId}`)
    const tabs = page.getByRole('tablist', { name: 'Run sections' })
    await expect(tabs.getByRole('tab')).toHaveText(['Overview', 'Curves', 'Data', 'Evaluations', 'Settings'])
    await expect(tabs.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    // The overview leads with the headline curves only.
    await expect(page.getByTestId('metric-chart')).toHaveCount(2)
    await expect(chart(page, 'cer')).toBeVisible()
    await expect(chart(page, 'loss')).toBeVisible()

    await tabs.getByRole('tab', { name: 'Curves' }).click()
    await expect(page).toHaveURL(new RegExp(`/models/runs/${runId}\\?tab=curves$`))
    await expect(page.getByTestId('metric-chart')).toHaveCount(6)
    await expect(chart(page, 'time/epoch_seconds')).toBeVisible()
    await expect(chart(page, 'time/items_per_s')).toBeVisible()

    await tabs.getByRole('tab', { name: 'Curves' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page).toHaveURL(/\?tab=data$/)
    await expect(tabs.getByRole('tab', { name: 'Data' })).toBeFocused()
    await expect(page.getByTestId('preflight-report')).toBeVisible()
    await page.keyboard.press('End')
    await expect(page).toHaveURL(/\?tab=settings$/)
    await expect(page.getByTestId('run-settings')).toBeVisible()
    await expect(page.getByTestId('preflight-report')).toHaveCount(0)

    // The header stays on every tab, with the best CER the stub reported at epoch 3.
    await page.reload()
    await expect(tabs.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('stat-best-cer')).toContainText('10.00%')
    await expect(page.getByTestId('stat-best-cer')).toContainText('e3')

    // The new model in each of the three decodes; trained from scratch, it has no base to score.
    expect((await listTrainings()).find((t) => t.id === runId)!.base_model_id).toBeNull()
    await expect.poll(async () => (await listEvaluations()).filter((e) => e.training_id === runId).length,
                      { timeout: 30_000 }).toBe(3)
    await page.goto(`/models/runs/${runId}?tab=evaluations`)
    await expect(page.getByTestId('run-evaluation')).toHaveCount(3)
    await page.goto(`/models/runs/${runId}?tab=nonsense`)
    await expect(tabs.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
  })
})

test.describe('Scenario: reading curves like TensorBoard', () => {
  test('the crosshair snaps to a step on every chart and reads out each series', async ({ page }) => {
    // Backend oracle: the points the readout is about.
    expect((await getTrainingProgress(runId)).points).toMatchObject([
      { epoch: 1, loss: 2.5, cer: 0.5 }, { epoch: 2, loss: 1.5, cer: 0.3 }, { epoch: 3, loss: 0.5, cer: 0.1 },
    ])
    await openCurvesOnEpochs(page)
    const cer = chart(page, 'cer')
    await hoverAt(cer, 0.55)

    const readout = cer.getByTestId('chart-readout')
    await expect(readout.getByTestId('readout-epoch')).toHaveText('epoch 2')
    await expect(readout.getByTestId('readout-time')).toHaveText(/^\d+(\.\d+)?[smhd]$/)
    const row = readout.locator('[data-testid="readout-row"][data-series="cer"]')
    await expect(row.getByTestId('readout-smoothed')).toHaveText('30.00%')
    await expect(row.getByTestId('readout-raw')).toHaveText('30.00%')

    // The other charts follow the same step.
    await expect(chart(page, 'loss')).toHaveAttribute('data-cursor', '2')
    await expect(chart(page, 'loss').getByTestId('chart-footer')).toHaveText('epoch 2 · 1.5')
    const perDataset = chart(page, 'cer_by_dataset')
    await expect(perDataset.getByTestId('chart-footer')).toContainText('30.00%')
    await expect(perDataset.getByTestId('chart-footer')).toContainText('31.00%')

    await page.mouse.move(0, 0)
    await expect(chart(page, 'loss')).not.toHaveAttribute('data-cursor', /./)
    await expect(cer.getByTestId('chart-readout')).toHaveCount(0)
  })

  test('one smoothing slider draws the debiased average, with the raw value beside it', async ({ page }) => {
    await openCurvesOnEpochs(page)
    // A range input cannot be filled; it is moved the way a keyboard user moves it.
    const slider = page.getByTestId('smoothing')
    await slider.focus()
    await page.keyboard.press('Home')
    for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowRight')
    await expect(slider).toHaveValue('0.6')
    const cer = chart(page, 'cer')
    await hoverAt(cer, 0.99)
    const row = cer.getByTestId('chart-readout').locator('[data-testid="readout-row"][data-series="cer"]')
    // 0.5, 0.3, 0.1 at weight 0.6, debiased: 0.2346939 at epoch 3.
    await expect(row.getByTestId('readout-smoothed')).toHaveText('23.47%')
    await expect(row.getByTestId('readout-raw')).toHaveText('10.00%')
    // The raw line is drawn faint behind the smoothed one.
    await expect(cer.locator('path[data-line="raw"]')).toHaveCount(1)
    await expect(cer.locator('path[data-line="smoothed"]')).toHaveCount(1)
    // Loss is declared a plain number, so its readout keeps three figures: 1.1735 at epoch 3.
    await hoverAt(chart(page, 'loss'), 0.99)
    await expect(chart(page, 'loss').getByTestId('chart-readout').getByTestId('readout-smoothed')).toHaveText('1.17')
    // The latest reading in the legend is the run's own, not the average.
    await expect(cer.getByTestId('metric-latest')).toHaveText('10.00%')

    // The toolbar is remembered for the next visit.
    await page.reload()
    await expect(page.getByTestId('smoothing')).toHaveValue('0.6')
    await expect(page.getByTestId('curve-toolbar').getByRole('button', { name: 'epoch', exact: true }))
      .toHaveAttribute('aria-pressed', 'true')
  })

  test('a legend click hides a series and an alt-click shows only it', async ({ page }) => {
    await openCurvesOnEpochs(page)
    const perDataset = chart(page, 'cer_by_dataset')
    const [first, second] = validIds
    const lines = perDataset.locator('path[data-line="smoothed"]')
    await expect(lines).toHaveCount(2)
    const legend = (id: string) => perDataset.locator(`[data-testid="legend-item"][data-series="${id}"]`)

    await legend(second).click()
    await expect(legend(second)).toHaveAttribute('aria-pressed', 'false')
    await expect(lines).toHaveCount(1)
    await hoverAt(perDataset, 0.99)
    const rows = perDataset.getByTestId('chart-readout').getByTestId('readout-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toHaveAttribute('data-series', first)
    await expect(rows.first().getByTestId('readout-raw')).toHaveText('10.00%')

    await legend(second).click()
    await expect(lines).toHaveCount(2)
    await legend(second).click({ modifiers: ['Alt'] })
    await expect(legend(first)).toHaveAttribute('aria-pressed', 'false')
    await expect(legend(second)).toHaveAttribute('aria-pressed', 'true')
    await hoverAt(perDataset, 0.99)
    await expect(rows).toHaveCount(1)
    await expect(rows.first().getByTestId('readout-raw')).toHaveText('11.00%')
    // Alt-clicking the only series left shows them all again.
    await legend(second).click({ modifiers: ['Alt'] })
    await expect(lines).toHaveCount(2)
  })

  test('dragging a box zooms a chart and a double-click resets it', async ({ page }) => {
    await openCurvesOnEpochs(page)
    const cer = chart(page, 'cer')
    const readEdge = async () => {
      await hoverAt(cer, 0.01)
      return cer.getByTestId('chart-readout').locator('[data-series="cer"]').getByTestId('readout-raw')
    }
    await expect(await readEdge()).toHaveText('50.00%')

    // From 45% of the way along to the right edge: epochs 1.9 to 3, so epoch 1 is out of view.
    const box = (await cer.getByTestId('plot-area').boundingBox())!
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.99, box.y + box.height * 0.8, { steps: 5 })
    await page.mouse.up()
    await expect(cer).toHaveAttribute('data-zoomed', 'true')
    await expect(chart(page, 'loss')).toHaveAttribute('data-zoomed', 'false')
    await expect(await readEdge()).toHaveText('30.00%')

    await cer.getByTestId('plot-area').dblclick()
    await expect(cer).toHaveAttribute('data-zoomed', 'false')
    await expect(await readEdge()).toHaveText('50.00%')
  })

  test('the move tool slides the view by what the pointer travelled, keeping its span', async ({ page }) => {
    await openCurvesOnEpochs(page)
    const cer = chart(page, 'cer')
    const readAt = async (fraction: number) => {
      await hoverAt(cer, fraction)
      return cer.getByTestId('chart-readout').locator('[data-series="cer"]').getByTestId('readout-raw')
    }
    const dragAcross = async (from: number, to: number) => {
      const box = (await cer.getByTestId('plot-area').boundingBox())!
      await page.mouse.move(box.x + box.width * from, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width * to, box.y + box.height / 2, { steps: 5 })
      await page.mouse.up()
    }
    await expect(await readAt(0.01)).toHaveText('50.00%')

    await page.getByTestId('curve-toolbar').getByRole('button', { name: 'move', exact: true }).click()
    await expect(cer).toHaveAttribute('data-tool', 'move')
    // Half the plot to the left: epochs 1-3 become 2-4, so the left edge is epoch 2 and
    // 30% along is epoch 2.6, nearest to 3. A zoom would have narrowed the span instead.
    await dragAcross(0.75, 0.25)
    await expect(cer).toHaveAttribute('data-panning', 'false')
    await expect(cer).toHaveAttribute('data-zoomed', 'true')
    await expect(chart(page, 'loss')).toHaveAttribute('data-zoomed', 'false')
    await expect(await readAt(0.01)).toHaveText('30.00%')
    await expect(await readAt(0.3)).toHaveText('10.00%')

    await cer.getByTestId('plot-area').dblclick()
    await expect(cer).toHaveAttribute('data-zoomed', 'false')

    // With the zoom tool, shift-drag moves the view too.
    await page.getByTestId('curve-toolbar').getByRole('button', { name: 'zoom', exact: true }).click()
    await expect(cer).toHaveAttribute('data-tool', 'zoom')
    await page.keyboard.down('Shift')
    await dragAcross(0.75, 0.25)
    await page.keyboard.up('Shift')
    await expect(await readAt(0.01)).toHaveText('30.00%')
    await expect(await readAt(0.3)).toHaveText('10.00%')
  })

  test('a focused chart moves its crosshair with the arrow keys and expands to full width', async ({ page }) => {
    await openCurvesOnEpochs(page)
    const cer = chart(page, 'cer')
    await cer.getByRole('img').focus()
    await page.keyboard.press('End')
    const raw = cer.getByTestId('chart-readout').locator('[data-series="cer"]').getByTestId('readout-raw')
    await expect(raw).toHaveText('10.00%')
    await page.keyboard.press('ArrowLeft')
    await expect(raw).toHaveText('30.00%')
    await expect(chart(page, 'loss')).toHaveAttribute('data-cursor', '2')
    await page.keyboard.press('Home')
    await expect(raw).toHaveText('50.00%')

    // The grid the CER chart sits in; the detail metrics have a grid of their own.
    const grid = page.getByTestId('curve-grid').filter({ has: cer })
    const gridWidth = (await grid.boundingBox())!.width
    const before = (await cer.boundingBox())!.width
    expect(before).toBeLessThan(gridWidth * 0.6)
    await cer.getByTestId('chart-expand').click()
    await expect(cer.getByTestId('chart-expand')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await cer.boundingBox())!.width).toBeCloseTo(gridWidth, -1)
    await cer.getByTestId('chart-expand').click()
    await expect.poll(async () => (await cer.boundingBox())!.width).toBeCloseTo(before, -1)
  })

  test('a log axis is offered, and step derives from the pre-flight steps per epoch', async ({ page }) => {
    const stored = await backendFetch(`/api/trainings/${runId}/preflight`) as { result: { settings: { steps_per_epoch: number } } }
    const perEpoch = stored.result.settings.steps_per_epoch
    await page.goto(`/models/runs/${runId}?tab=curves`)
    const toolbar = page.getByTestId('curve-toolbar')
    await toolbar.getByRole('button', { name: 'step', exact: true }).click()
    const cer = chart(page, 'cer')
    await hoverAt(cer, 0.99)
    await expect(cer.getByTestId('chart-readout').getByTestId('readout-step')).toHaveText(`step ${3 * perEpoch}`)
    await expect(cer.getByTestId('chart-readout').getByTestId('readout-epoch')).toHaveText('epoch 3')

    await toolbar.getByRole('button', { name: 'log', exact: true }).click()
    await expect(cer).toHaveAttribute('data-scale', 'log')
    await expect(cer.locator('path[data-line="smoothed"]')).toHaveCount(1)
    await expect(cer.getByTestId('log-dropped')).toHaveCount(0)
    await expect(toolbar.getByRole('button', { name: 'ignore outliers' })).toHaveAttribute('aria-pressed', 'false')
  })
})

test.describe('Scenario: the data tab explains what is under the pointer', () => {
  test('the distributions stand in one block and a bar tells its range, count and share', async ({ page }) => {
    const stored = await backendFetch(`/api/trainings/${runId}/preflight`) as StoredPreflight
    const bins = stored.result.crops.height.bins
    const total = bins.reduce((sum, b) => sum + b.n, 0)
    const bin = bins.find((b) => b.n > 0)!
    const range = bin.hi === null ? `${bin.lo}+` : `${bin.lo}-${bin.hi}`
    const share = `${((bin.n / total) * 100).toFixed(1)}%`

    await page.goto(`/models/runs/${runId}?tab=data`)
    const block = page.getByTestId('preflight-distributions')
    await expect(block.getByTestId('preflight-histogram')).toHaveCount(4)
    await expect(block.getByTestId('preflight-histogram').evaluateAll((els) => els.map((e) => e.getAttribute('data-metric'))))
      .resolves.toEqual(['height', 'width', 'aspect', 'characters per line'])

    const height = block.locator('[data-testid="preflight-histogram"][data-metric="height"]')
    const bar = height.locator(`[data-testid="preflight-bin"][data-lo="${bin.lo}"]`)
    await bar.hover()
    await expect(bar).toHaveAttribute('data-highlighted', 'true')
    const detail = height.getByTestId('preflight-bin-detail')
    await expect(detail).toHaveText(`${range} px · ${bin.n} · ${share}`)

    // A click pins it, so the pointer can leave; another click lets go.
    await bar.click()
    await page.mouse.move(0, 0)
    await expect(detail).toHaveText(`${range} px · ${bin.n} · ${share}`)
    await expect(bar).toHaveAttribute('data-pinned', 'true')
    await bar.click()
    await page.mouse.move(0, 0)
    await expect(bar).toHaveAttribute('data-pinned', 'false')
    await expect(detail).toHaveText(/^min [\d.]+ · median [\d.]+ · max [\d.]+ px$/)
  })

  test('a character is highlighted in the table and the grid together', async ({ page }) => {
    const stored = await backendFetch(`/api/trainings/${runId}/preflight`) as StoredPreflight
    const capitalS = stored.result.text.characters.find((c) => c.char === 'S')!
    expect(capitalS.total).toBeGreaterThan(0)

    await page.goto(`/models/runs/${runId}?tab=data`)
    const cell = (cp: string) => page.locator(`[data-testid="preflight-charset"] [data-char="${cp}"]`)
    const row = (cp: string) => page.locator(`[data-testid="preflight-char"][data-char="${cp}"]`)

    await cell('U+0053').hover()
    await expect(row('U+0053')).toHaveAttribute('data-highlighted', 'true')
    await expect(cell('U+0053')).toHaveAttribute('data-highlighted', 'true')
    await expect(row('U+0061')).toHaveAttribute('data-highlighted', 'false')
    await expect(page.getByTestId('preflight-char-detail'))
      .toHaveText(`U+0053 ${capitalS.name} · ${capitalS.total} · train ${capitalS.train} · valid ${capitalS.val}`)

    await row('U+0061').hover()
    await expect(cell('U+0061')).toHaveAttribute('data-highlighted', 'true')
    await expect(cell('U+0053')).toHaveAttribute('data-highlighted', 'false')
  })
})

// A run of its own whose lines land in different bars: on the 600 x 800 train scan the
// three header lines crop to 480 x 23 px and the three paragraph lines to 480 x 150; on
// the 1200 x 800 valid scan the two checked header lines crop to 960 x 23.
test.describe('Scenario: the distributions are linked through their lines', () => {
  let linkedRunId: number
  let trainJob: string
  let headerLines: { id: number; jobId: string; pageId: number }[]

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    trainJob = await seedCompletedJob(uniqueName('Linked bars train'), 1)
    const validJob = await seedCompletedJob(uniqueName('Linked bars valid'), 1, { width: 1200, height: 800 })
    await markLinesChecked(trainJob, 6)
    await markLinesChecked(validJob, 2)
    headerLines = []
    for (const jobId of [trainJob, validJob]) {
      for (const pageId of await jobPageIds(jobId)) {
        const detail = await getPageDetail(jobId, pageId) as {
          elements: { class_name: string; lines: { id: number; checked: boolean }[] }[]
        }
        for (const line of detail.elements.filter((e) => e.class_name === 'Header').flatMap((e) => e.lines)) {
          if (line.checked) headerLines.push({ id: line.id, jobId, pageId })
        }
      }
    }
    expect(headerLines).toHaveLength(5)
    const name = uniqueName('Linked bars')
    await createTraining({ task: 'ocr', name, dataset_job_ids: [trainJob], target: 'local',
                           split_strategy: 'holdout', valid_job_ids: [validJob], epochs: 1 })
    await expect.poll(async () => (await listTrainings()).find((t) => t.name === name)?.status,
                      { timeout: 60_000 }).toBe('done')
    linkedRunId = (await listTrainings()).find((t) => t.name === name)!.id
    await expect.poll(async () => (await backendFetch(`/api/trainings/${linkedRunId}/preflight`) as StoredPreflight).status,
                      { timeout: 30_000 }).toBe('done')
  })

  const row = (page: Page, metric: string) =>
    page.locator(`[data-testid="preflight-histogram"][data-metric="${metric}"]`)
  const bar = (page: Page, metric: string, lo: number) =>
    row(page, metric).locator(`[data-testid="preflight-bin"][data-lo="${lo}"]`)

  test('hovering a height bar shows in the width row how many of its lines each bar holds', async ({ page }) => {
    await page.goto(`/models/runs/${linkedRunId}?tab=data`)
    await bar(page, 'height', 16).hover()
    await expect(row(page, 'height').getByTestId('preflight-bin-detail')).toHaveText('16-24 px · 5 · 62.5%')
    await expect(bar(page, 'width', 256)).toHaveAttribute('data-linked', '3')
    await expect(bar(page, 'width', 512)).toHaveAttribute('data-linked', '2')
    await expect(bar(page, 'width', 128)).toHaveAttribute('data-linked', '0')
    await expect(row(page, 'width').getByTestId('preflight-bin-detail'))
      .toHaveText('of these 5: 3 at 256-512 px, 2 at 512-1024 px')
    await expect(row(page, 'characters per line').getByTestId('preflight-bin-detail'))
      .toHaveText('of these 5: 5 at 20-40')

    await bar(page, 'height', 128).hover()
    await expect(bar(page, 'width', 256)).toHaveAttribute('data-linked', '3')
    await expect(bar(page, 'width', 512)).toHaveAttribute('data-linked', '0')
    await expect(row(page, 'width').getByTestId('preflight-bin-detail')).toHaveText('of these 3: 3 at 256-512 px')
    // The row under the pointer is not linked to itself.
    await expect(bar(page, 'height', 16)).not.toHaveAttribute('data-linked')
    await expect(bar(page, 'width', 256)).toHaveAttribute('data-linked')
  })

  test('a pinned bar lists its lines, and clicking one opens it in the page viewer', async ({ page }) => {
    await page.goto(`/models/runs/${linkedRunId}?tab=data`)
    await bar(page, 'height', 16).click()
    await page.mouse.move(0, 0)
    const examples = page.getByTestId('preflight-bin-examples').getByTestId('preflight-bin-example')
    const ids = headerLines.map((l) => l.id).sort((a, b) => a - b)
    await expect.poll(() => examples.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-line-id')))))
      .toEqual(ids)
    await expect(examples).toHaveText(['Sample Header line 1', 'Sample Header line 2', 'Sample Header line 3',
                                       'Sample Header line 1', 'Sample Header line 2'])
    await expect(examples.first().getByRole('img')).toHaveAttribute('src', `/api/lines/${ids[0]}/crop`)
    await expect(bar(page, 'width', 512)).toHaveAttribute('data-linked', '2')

    const first = headerLines.find((l) => l.id === ids[0])!
    expect(first.jobId).toBe(trainJob)
    await examples.first().getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`/jobs/${first.jobId}/pages/${first.pageId}\\?line=${first.id}$`))
    await expect(page.getByTestId('line-row').filter({ hasText: 'Sample Header line 1' }))
      .toHaveAttribute('data-hot', 'true')
    await expect(page.getByTestId('line-row').filter({ hasText: 'Sample Header line 2' }))
      .not.toHaveAttribute('data-hot', 'true')
  })

  test('a pre-flight stored before bars were linked still shows its bars, without lines or links', async ({ page }) => {
    await page.route(`**/api/trainings/${linkedRunId}/preflight`, async (route) => {
      const body = await (await route.fetch()).json()
      delete body.result.joint
      for (const dist of [body.result.crops.height, body.result.crops.width, body.result.crops.aspect,
                          body.result.text.chars_per_line]) {
        for (const b of dist.bins) delete b.examples
      }
      await route.fulfill({ json: body })
    })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`/models/runs/${linkedRunId}?tab=data`)
    await bar(page, 'height', 16).click()
    await expect(row(page, 'height').getByTestId('preflight-bin-detail')).toHaveText('16-24 px · 5 · 62.5%')
    await expect(bar(page, 'height', 16)).toHaveAttribute('data-pinned', 'true')
    await expect(bar(page, 'width', 256)).not.toHaveAttribute('data-linked')
    await expect(page.getByTestId('preflight-bin-examples')).toHaveCount(0)
    await expect(row(page, 'width').getByTestId('preflight-bin-detail'))
      .toHaveText(/^min [\d.]+ · median [\d.]+ · max [\d.]+ px$/)
    expect(errors).toEqual([])
  })
})
