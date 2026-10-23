import { test, expect } from '../helpers/test'
import {
  backendFetch, createTraining, getJob, getPageDetail, getTrainingProgress, jobPageIds, listEvaluations,
  listRegistryModels, listTrainings, markLinesChecked, seedCompletedJob, seedDistinctPagesJob, uniqueName,
} from '../helpers/api'

type Line = { id: number; text: string; checked: boolean; order_idx: number }
type Element = { class_name: string; lines: Line[] }

const patch = (path: string, body: Record<string, unknown>) =>
  backendFetch(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

test.describe('Scenario: a model read on its model backend', () => {
  test('OCR and evaluation go over the contract, and the model page says where it runs', async ({ page }) => {
    test.setTimeout(120_000)
    const jobId = await seedCompletedJob(uniqueName('Backend reading'), 1)
    await markLinesChecked(jobId, 3)
    const [pageId] = await jobPageIds(jobId)
    const linesOf = async () => (await getPageDetail(jobId, pageId)).elements.flatMap(
      (e: Element) => e.lines.map((l) => ({ ...l, class_name: e.class_name })))
    const before = await linesOf()

    // A trained model, so the backend has real weights to fetch from the weight store.
    const modelName = uniqueName('Served by stub')
    await createTraining({ task: 'ocr', name: modelName, dataset_job_ids: [jobId], target: 'local', epochs: 1 })
    await expect.poll(async () => (await listRegistryModels()).find((m) => m.name === modelName)?.id,
                      { timeout: 60_000 }).toBeGreaterThan(0)
    const modelId = (await listRegistryModels()).find((m) => m.name === modelName)!.id
    expect((await patch(`/api/models/${modelId}`, { backend: 'stub' })).runs_on).toBe('stub')

    await patch(`/api/jobs/${jobId}`, { model_ocr_id: modelId, ocr_convention: { long_s: true, ligatures: true } })
    await backendFetch(`/api/jobs/${jobId}/reocr`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'unchecked' }),
    })

    // The stub backend reads a line as its element and place, tagged with each flag it
    // was asked for and knows - ligatures it does not, so only long s is honoured.
    const expected = before.map((l: Line & { class_name: string }) => (l.checked
      ? l.text : `Sample ${l.class_name} line ${l.order_idx + 1} [long_s]`))
    await expect.poll(async () => (await linesOf()).map((l: Line) => l.text), { timeout: 30_000 }).toEqual(expected)
    // The in-process stub stores a bare list of numbers; the contract's bands are the
    // backend's own answer (PROFILE_BANDS of them, x as a fraction of the crop).
    const reread = (await linesOf()).filter((l: Line) => !l.checked) as (Line & { conf_profile: unknown[] })[]
    expect(reread).toHaveLength(3)
    for (const line of reread) {
      expect(line.conf_profile[0]).toMatchObject({ x0: 0 })
      expect(line.conf_profile.at(-1)).toMatchObject({ x1: 1 })
    }
    await expect.poll(async () => (await getJob(jobId)).ocr_convention_read).toEqual(['long_s'])
    const provenance = (await getPageDetail(jobId, pageId)).provenance
    expect(provenance.ocr.find((r: { model: { id: number } }) => r.model?.id === modelId)?.lines).toBe(3)

    // What the backend reported on loading the weights is kept on the model row.
    const served = (await listRegistryModels()).find((m) => m.id === modelId) as unknown as {
      target_height: number; max_width: number; conventions: string[]
    }
    expect([served.target_height, served.max_width, served.conventions]).toEqual(
      [256, 6144, ['long_s', 'oblique_hyphen', 'typographic_punctuation', 'abbreviations']])

    // An evaluation runs on the backend too: the stub reads the checked lines back exactly.
    const evaluation = await backendFetch('/api/evaluations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: modelId, job_ids: [jobId], decode: 'beam' }),
    })
    await expect.poll(async () => (await listEvaluations()).find((e) => e.id === evaluation.id)?.status,
                      { timeout: 30_000 }).toBe('done')
    expect((await listEvaluations()).find((e) => e.id === evaluation.id)).toMatchObject({ cer: 0, line_count: 3 })

    await page.goto(`/models/${modelId}`)
    await expect(page.getByTestId('model-runs-on')).toHaveText('model backend "stub"')
    await expect(page.getByTestId('model-conventions'))
      .toHaveText('knows 4: long s, oblique hyphen, typographic punctuation, abbreviations')

    // Handed back to its task's backend, it reads there.
    expect((await patch(`/api/models/${modelId}`, { backend: null })).runs_on).toBe('ocr')
    await page.reload()
    await expect(page.getByTestId('model-runs-on')).toHaveText('model backend "ocr"')
  })

  test('a dataset whose models are all on a backend runs with no model code at all', async () => {
    test.setTimeout(120_000)
    const defaults = (await listRegistryModels()).filter((m) => m.is_default && ['layout', 'lines', 'ocr'].includes(m.task))
    expect(defaults.map((m) => m.task).sort()).toEqual(['layout', 'lines', 'ocr'])
    try {
      for (const model of defaults) {
        expect((await patch(`/api/models/${model.id}`, { backend: 'stub' })).runs_on).toBe('stub')
      }
      // Distinct scans: this is the real ingest, which files a repeated scan as a duplicate.
      const jobId = await seedDistinctPagesJob(uniqueName('All on backends'), 2, 940)
      const byTask = Object.fromEntries(defaults.map((m) => [m.task, m]))

      for (const pageId of await jobPageIds(jobId)) {
        const detail = await getPageDetail(jobId, pageId)
        // The stub backend detects Header and Paragraph; DeepLabel orders them, cuts the
        // crops, maps each crop's three lines back onto the page and reads them.
        expect(detail.elements.map((e: Element) => e.class_name)).toEqual(['Header', 'Paragraph'])
        expect(detail.elements.map((e: Element) => e.lines.map((l) => l.text))).toEqual([
          ['Sample Header line 1', 'Sample Header line 2', 'Sample Header line 3'],
          ['Sample Paragraph line 1', 'Sample Paragraph line 2', 'Sample Paragraph line 3'],
        ])
        expect([detail.provenance.layout?.id, detail.provenance.lines?.id]).toEqual(
          [byTask.layout.id, byTask.lines.id])
        // Written by DeepLabel's own pipeline under the model's name - the stand-in runner
        // the other scenarios use records no layout revision at all.
        const [header] = detail.elements as (Element & { id: number })[]
        const history = await backendFetch(`/api/elements/${header.id}/revisions`)
        expect(history.map((r: { author: string; action: string }) => [r.author, r.action]))
          .toContainEqual([`model:layout@${byTask.layout.name}`, 'create'])
      }
    } finally {
      for (const model of defaults) await patch(`/api/models/${model.id}`, { backend: null })
    }
    for (const model of (await listRegistryModels()).filter((m) => defaults.some((d) => d.id === m.id))) {
      expect((model as unknown as { runs_on: string | null }).runs_on).toBe(model.task)
    }
  })

  test('a model on a backend is fine-tuned there and its successor reads there too', async ({ page }) => {
    test.setTimeout(180_000)
    const jobId = await seedCompletedJob(uniqueName('Backend training'), 1)
    await markLinesChecked(jobId, 6)
    // A base with stored weights, put on the stub backend.
    const baseName = uniqueName('Trained base')
    await createTraining({ task: 'ocr', name: baseName, dataset_job_ids: [jobId], target: 'local', epochs: 1 })
    await expect.poll(async () => (await listRegistryModels()).find((m) => m.name === baseName)?.id,
                      { timeout: 60_000 }).toBeGreaterThan(0)
    const baseId = (await listRegistryModels()).find((m) => m.name === baseName)!.id
    expect((await patch(`/api/models/${baseId}`, { backend: 'stub' })).runs_on).toBe('stub')

    // Picking that base, the form offers the backend's own settings, not the model repo's.
    await page.goto('/models/train?task=ocr')
    await page.getByLabel('Base model').selectOption(String(baseId))
    await page.getByTestId('advanced-toggle').click()
    await expect(page.getByTestId('trains-on-backend')).toHaveText('Trains on model backend "stub", with the settings it offers.')
    // The learning rate sits beside the epochs and the patience beside early stop, as they
    // always do; the backend's other knobs are generic fields.
    await expect(page.getByLabel('Learning rate')).toBeVisible()
    await expect(page.getByLabel('Patience')).toBeVisible()
    await expect(page.getByTestId('tunable-field')).toHaveCount(3)
    // Their placeholders are the defaults the backend declares.
    await expect(page.getByTestId('tunable-field').getByLabel('Warmup epochs', { exact: true })).toHaveAttribute('placeholder', '1')
    await expect(page.getByTestId('tunable-field').getByLabel('Gradient accumulation', { exact: true }))
      .toHaveAttribute('placeholder', '1')
    const offered = await backendFetch(`/api/trainings/options?task=ocr&base_model_id=${baseId}`)
    expect(offered.tunables.map((t: { key: string; default: number }) => [t.key, t.default]))
      .toEqual([['learning_rate', 0.0001], ['warmup_epochs', 1.0], ['grad_accum_steps', 1], ['patience', null],
                ['freeze_backbone', false]])
    // The stub has no card, so a local run takes its declared default and accumulates to
    // the effective batch it declares.
    expect([offered.batch.local, offered.effective_batch]).toEqual([8, 16])

    const name = uniqueName('Fine-tuned on the backend')
    const created = await createTraining({ task: 'ocr', name, dataset_job_ids: [jobId], target: 'local', epochs: 3,
                                           base_model_id: baseId })
    await expect.poll(async () => (await listTrainings()).find((t) => t.id === created.id)?.status,
                      { timeout: 90_000 }).toBe('done')
    const run = (await listTrainings()).find((t) => t.id === created.id)! as unknown as { backend: string; model_id: number }
    expect(run.backend).toBe('stub')

    // The stub trainer's three epochs, mirrored where the run page reads them.
    const progress = await getTrainingProgress(created.id)
    expect(progress.points.filter((p) => p.cer !== undefined).map((p) => p.cer)).toEqual([0.5, 0.3, 0.1])
    expect(progress.log_tail).toContain('stub trainer: epoch 3/3 done')
    // The weights it wrote came back into the store, and the new model reads where its base does.
    const model = (await listRegistryModels()).find((m) => m.id === run.model_id)!
    expect(model.trained_from).toBe(baseId)
    expect((model as unknown as { runs_on: string }).runs_on).toBe('stub')
    expect(model.files.find((f) => f.role === 'weights')?.size).toBe(`stub-checkpoint ${created.id}`.length)

    // The run keeps the metrics the backend declared, and its curves read by them: the
    // headline first, the time per epoch worked out from the stamps, detail folded away.
    const kept = (await listTrainings()).find((t) => t.id === created.id)! as unknown as {
      metric_info: { key: string; headline?: boolean }[] }
    expect(kept.metric_info.find((m) => m.headline)?.key).toBe('cer')
    await page.goto(`/models/runs/${created.id}?tab=curves`)
    const main = page.getByTestId('curve-grid').first()
    await expect(main.getByTestId('metric-chart').first()).toHaveAttribute('data-metric', 'cer')
    await expect(main.locator('[data-metric="time/epoch_seconds"]')).toHaveCount(1)
    const detail = page.getByTestId('detail-metrics')
    await expect(detail).toContainText('1 more the trainer marked as detail')
    await expect(detail.locator('[data-metric="train/grad_norm"]')).toHaveCount(1)
    await expect(main.locator('[data-metric="train/grad_norm"]')).toHaveCount(0)
  })

  test('a run that runs out of GPU memory trains at a smaller batch and says so', async ({ page }) => {
    test.setTimeout(180_000)
    const jobId = await seedCompletedJob(uniqueName('Backend fallback'), 1)
    await markLinesChecked(jobId, 6)
    const baseName = uniqueName('Fallback base')
    await createTraining({ task: 'ocr', name: baseName, dataset_job_ids: [jobId], target: 'local', epochs: 1 })
    await expect.poll(async () => (await listRegistryModels()).find((m) => m.name === baseName)?.id,
                      { timeout: 60_000 }).toBeGreaterThan(0)
    const baseId = (await listRegistryModels()).find((m) => m.name === baseName)!.id
    expect((await patch(`/api/models/${baseId}`, { backend: 'stub' })).runs_on).toBe('stub')

    // [oom] makes the stub trainer run out of memory above a batch of 2, as a dense page
    // does on a small card. The run asks for 8 x 2 = the stub's effective batch of 16.
    const created = await createTraining({ task: 'ocr', name: uniqueName('Too big [oom]'), dataset_job_ids: [jobId],
                                           target: 'local', epochs: 1, base_model_id: baseId })
    expect([created.batch_size, created.grad_accum_steps]).toEqual([8, 2])
    await expect.poll(async () => (await listTrainings()).find((t) => t.id === created.id)?.status,
                      { timeout: 90_000 }).toBe('done')
    // Halved twice, accumulation doubled twice: still 16, and recorded as what it trained at.
    const run = (await listTrainings()).find((t) => t.id === created.id)!
    expect([run.batch_size, run.grad_accum_steps]).toEqual([2, 8])
    expect(run.batch_fallback).toEqual({ asked: { batch_size: 8, grad_accum_steps: 2 },
                                         trained: { batch_size: 2, grad_accum_steps: 8 } })
    expect((await getTrainingProgress(created.id)).log_tail).toContain('stub trainer: epoch 3/3 done')

    await page.goto(`/models/runs/${created.id}?tab=settings`)
    const settings = page.getByTestId('run-settings')
    await expect(settings.locator('[data-setting="batch size"] dd')).toHaveText('2')
    await expect(settings.locator('[data-setting="gradient accumulation"] dd')).toHaveText('8')
    await expect(settings.locator('[data-setting="out of memory at"] dd')).toHaveText('batch 8, trained at 2 x 8')
  })
})
