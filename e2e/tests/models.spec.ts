import { createHash } from 'node:crypto'
import { test, expect } from '../helpers/test'
import { OCR_READER, backendFetch, createGroup, createJob, createTraining, getTrainingProgress, identity, importStubModel, listEvaluations, listRegistryModels, listTrainings, markLinesChecked, moveJobToGroup, seedCompletedJob, seedDistinctPagesJob, uniqueName, waitForJobStatus } from '../helpers/api'
import { seedSession, useSession } from '../helpers/session'
import { cancelledRun, datasetOption, pickDataset, startTraining, taskSection, versionRow } from '../helpers/training'

test.describe('Scenario: the model registry', () => {
  test("each stage's backend brings its builtin model as the default", async ({ page }) => {
    const models = await listRegistryModels()
    await page.goto('/models')
    for (const [tab, task] of [['OCR', 'ocr'], ['Layout detection', 'layout'], ['Line segmentation', 'lines']] as const) {
      await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click()
      const builtin = models.find((m) => m.task === task && m.source === 'backend')!
      const family = taskSection(page, task).getByTestId('model-family').and(page.locator(`[data-root="${builtin.id}"]`))
      await expect(family.getByTestId('family-name')).toHaveText('stub (builtin)')
      await expect(family).toContainText("its backend's own")
      // The family holding the default starts open, the default marked on its graph.
      const row = family.locator(`[data-testid="version-row"][data-version="m${builtin.id}"]`)
      await expect(row.getByTestId('version-tag')).toHaveText('★ DEFAULT')
    }
  })

  test('training on checked lines registers an OCR model that can become the default', async ({ page }) => {
    // Two pages that differ: the split divides pages by content hash, so two copies of one
    // scan would be a single key and nothing would land in validation.
    const datasetName = uniqueName('Trainable')
    const jobId = await seedDistinctPagesJob(datasetName, 2)
    await markLinesChecked(jobId, 12)
    const modelName = uniqueName('OCR finetune')

    await page.goto('/models')
    // Every stage is trained from here, so each one offers the way in - at an address
    // of its own, so the form can be linked to and reopened.
    for (const [title, task] of [['Layout detection', 'layout'], ['Line segmentation', 'lines'],
                                 ['OCR', 'ocr']] as const) {
      await page.getByRole('tab', { name: new RegExp(`^${title}`) }).click()
      await expect(taskSection(page, task).getByTestId('train-model'))
        .toHaveAttribute('href', `/models/train?task=${task}`)
    }

    const ocrSection = taskSection(page, 'ocr')
    await ocrSection.getByTestId('train-model').click()

    await page.getByLabel('Model name').fill(modelName)
    await page.getByLabel('Description').fill('Trained on the e2e smoke set')
    // The dataset shows its eligible line count.
    const dataset = await datasetOption(page, datasetName)
    await expect(dataset.getByText('12', { exact: true })).toBeVisible()
    await dataset.getByRole('checkbox').check()
    await expect(page.getByText('12 checked lines selected')).toBeVisible()
    await expect(page.getByLabel('Base model')).toHaveValue(/\d+/)
    // Tuning knobs live behind the advanced toggle.
    await expect(page.getByLabel('Epochs', { exact: true })).toHaveCount(0)
    await page.getByTestId('advanced-toggle').click()
    // Blank fields show the default the trainer will really use - as its model backend
    // declares it (the stub trains three epochs), never typed into the app.
    await expect(page.getByLabel('Epochs', { exact: true })).toHaveAttribute('placeholder', '3')
    await expect(page.getByLabel('Learning rate')).toHaveAttribute('placeholder', '0.0001')
    await expect(page.getByTestId('submit-summary')).toContainText('3 epochs · batch 8 · lr 0.0001')
    await expect(page.getByTestId('trains-on-backend')).toHaveText('Trains on model backend "ocr", with the settings it offers.')
    // The split divides pages: 30% of this dataset's two pages is one valid page.
    await page.getByLabel('Validation split').selectOption('30')
    await page.getByLabel('Epochs', { exact: true }).fill('1')
    await page.getByLabel('Learning rate').fill('0.00005')
    // Early stop is off by default; enabling it sends the patience along.
    await expect(page.getByLabel('Patience')).toBeDisabled()
    await page.getByTestId('early-stop-toggle').check()
    await page.getByLabel('Patience').fill('5')
    // Every other knob sits in a manifest group, blank until tuned. Two are tuned here:
    // a number and a switch, so both value types travel to the record.
    const schedule = page.getByTestId('knob-group').filter({ has: page.getByText('Schedule', { exact: true }) })
    await schedule.locator('summary').click()
    await expect(page.getByLabel('Warmup epochs', { exact: true })).toHaveAttribute('placeholder', '1')
    await page.getByLabel('Warmup epochs', { exact: true }).fill('2')
    const fineTuning = page.getByTestId('knob-group').filter({ has: page.getByText('Fine-tuning', { exact: true }) })
    await fineTuning.locator('summary').click()
    await expect(page.getByRole('combobox', { name: 'Freeze backbone' })).toHaveValue('')
    await page.getByRole('combobox', { name: 'Freeze backbone' }).selectOption('on')
    await expect(page.getByTestId('tuned-count')).toHaveText('· 2 tuned')
    await expect(page.getByTestId('submit-summary')).toContainText('2 more knobs tuned')
    await startTraining(page)

    // The run walks the queue (snapshot -> stub trainer -> registered model).
    const run = page.getByTestId('training-row').filter({ hasText: modelName })
    await expect(run.getByText('done')).toBeVisible({ timeout: 30_000 })

    // Opening the run shows the charts and log from the progress contract, and the
    // backend serves the exact per-epoch points the trainer wrote.
    await run.getByTestId('training-open').click()
    // One chart per metric the trainer reported, discovered from the points rather
    // than listed anywhere in the frontend.
    await page.getByRole('tab', { name: 'Curves' }).click()
    // Three the trainer wrote, and two worked out from its timestamps and the split.
    await expect(page.getByTestId('metric-chart')).toHaveCount(5)
    await expect(page.locator('[data-testid="metric-chart"][data-metric="cer"]')).toBeVisible()
    await expect(page.locator('[data-testid="metric-chart"][data-metric="loss"]')).toBeVisible()
    await expect(page.locator('[data-testid="metric-chart"][data-metric="time/epoch_seconds"]')).toContainText('time per epoch')
    await expect(page.locator('[data-testid="metric-chart"][data-metric="time/items_per_s"]')).toContainText('throughput')
    // The point of the whole arrangement: `train/grad_norm` is a key the app has never
    // heard of, and it still gets a chart, under the label the backend declared for it,
    // carrying the exact last reading the stub trainer wrote (3.0 / 3).
    const unknown = page.locator('[data-testid="metric-chart"][data-metric="train/grad_norm"]')
    await expect(unknown).toContainText('gradient norm')
    // 3.0 / 3 at the last epoch, declared a plain number.
    await expect(unknown.getByTestId('metric-latest')).toHaveText('1')
    // And a metric it does know keeps its own units rather than that fallback.
    await expect(page.locator('[data-metric="cer"]').getByTestId('metric-latest'))
      .toHaveText('10.00%')
    // The plot fills the tile it is given. A viewBox with a fixed aspect letterboxes
    // itself inside a wide card, which reads as a chart floating in empty space.
    const tile = page.locator('[data-testid="metric-chart"][data-metric="cer"]')
    const plot = tile.getByRole('img')
    const tileBox = (await tile.boundingBox())!
    const plotBox = (await plot.boundingBox())!
    expect(plotBox.width).toBeGreaterThan(tileBox.width - 24)
    // And the line drawn in it spans that width, rather than a scaled-down slice of it.
    const line = (await tile.locator('path[data-line="smoothed"]').boundingBox())!
    expect(line.width).toBeGreaterThan(plotBox.width * 0.7)

    // The best epoch is the checkpoint that gets registered - the page names it with
    // the exact CER the stub trainer reported for epoch 3.
    await expect(page.getByTestId('stat-best-cer')).toContainText('10.00%')
    await expect(page.getByTestId('stat-best-cer')).toContainText('e3')
    await page.getByRole('tab', { name: 'Overview' }).click()
    await expect(page.getByTestId('run-log')).toContainText('stub trainer: epoch 3/3 done')
    const trainingId = (await listTrainings()).find((t) => t.name === modelName)!.id
    // Points also carry a ts stamp per epoch, so the chart can derive durations.
    const progress = (await getTrainingProgress(trainingId)).points
    expect(progress).toMatchObject([
      { epoch: 1, loss: 2.5, cer: 0.5 },
      { epoch: 2, loss: 1.5, cer: 0.3 },
      { epoch: 3, loss: 0.5, cer: 0.1 },
    ])
    expect(progress.every((p) => typeof p.ts === 'number')).toBe(true)

    // The tuned knobs travelled into the training record, typed - and only those: a
    // blank field stores nothing, so the trainer keeps its own default.
    const training = (await listTrainings()).find((t) => t.name === modelName)!
    expect(training.hyperparams).toEqual({
      learning_rate: 0.00005, patience: 5, warmup_epochs: 2, freeze_backbone: true,
    })

    // Auto-eval: the new model and its base were scored on the same valid split, in
    // every decode - the modes disagree, so one number per model would hide that.
    const DECODES = ['beam', 'rescored', 'greedy']
    await expect
      .poll(async () =>
        (await listEvaluations()).filter((e) => e.training_id === trainingId && e.status === 'done').length,
        { timeout: 60_000 })
      .toBe(2 * DECODES.length)
    const trainedId = (await listRegistryModels()).find((m) => m.name === modelName)!.id
    const autoEvals = (await listEvaluations()).filter((e) => e.training_id === trainingId)
    // Two models scored - the new one and its base - each with one score per mode,
    // not three of the same one.
    const byModel = new Map<number, string[]>()
    for (const e of autoEvals) byModel.set(e.model_id, [...(byModel.get(e.model_id) ?? []), e.decode])
    expect([...byModel.keys()].sort()).toEqual([trainedId, training.base_model_id].sort())
    for (const decodes of byModel.values()) expect([...decodes].sort()).toEqual([...DECODES].sort())
    const freshEval = autoEvals.find((e) => e.model_id === trainedId && e.decode === 'beam')!
    // A model tuned from the builtin one reads every line exactly; the eval ran on
    // exactly the snapshot's valid lines.
    expect(freshEval.cer).toBe(0)
    expect(freshEval.line_count).toBe(training.snapshot_counts!.val)
    await page.reload()
    // Both sides of the valid split are scored, so the run answers "did it help?".
    await expect(page.getByTestId('score-valid-base')).toBeVisible()
    await expect(page.getByTestId('score-valid-new')).toBeVisible()
    // The record shows what the run was tuned to, so runs stay comparable.
    await page.getByRole('tab', { name: 'Settings' }).click()
    const settings = page.getByTestId('run-settings')
    await expect(settings).toContainText('learning rate')
    await expect(settings).toContainText('0.00005')
    await expect(settings).toContainText('warmup epochs')
    await expect(settings).toContainText('freeze backbone')
    await expect(settings).toContainText("the model's own")
    const registered = (await listRegistryModels()).find((m) => m.name === modelName)!
    const builtinOcr = (await listRegistryModels()).find((m) => m.task === 'ocr' && m.source === 'backend')!
    await page.goto(`/models/${registered.id}`)
    await expect(page.getByTestId('model-source')).toHaveText('trained')
    await expect(page.getByTestId('model-metric-val_metric')).toHaveText('validation cer42.00%')

    // The result is in the weight store by content, for model backends to fetch: the stub
    // trainer writes the bytes 'stub-checkpoint <run id>'.
    const checkpoint = `stub-checkpoint ${trainingId}`
    const stubCheckpoint = createHash('sha256').update(checkpoint).digest('hex')
    expect((await listRegistryModels()).find((m) => m.name === modelName)!.files).toEqual(
      [{ role: 'weights', filename: 'model.ckpt', sha256: stubCheckpoint, size: checkpoint.length }])
    await expect(page.getByTestId('model-files')).toHaveAttribute('data-roles', 'weights')
    await expect(page.getByTestId('model-files')).toHaveText(`${stubCheckpoint.slice(0, 8)} · ${checkpoint.length} B`)
    // The lineage ends in this model, fine-tuned from the base the form picked.
    const base = (await listRegistryModels(true)).find((m) => m.id === registered.trained_from)!
    await expect(page.getByTestId('lineage-step').last()).toHaveText(modelName)
    await expect(page.getByTestId('lineage-step').nth(-2)).toHaveText(base.name)

    const header = page.getByRole('heading', { level: 1 })
    await expect(header.getByText('★ DEFAULT')).toHaveCount(0)
    await page.getByRole('button', { name: 'Set default' }).click()
    await expect(header.getByText('★ DEFAULT')).toBeVisible()
    await expect.poll(async () => (await listRegistryModels()).find((m) => m.id === registered.id)?.is_default)
      .toBe(true)

    // The former builtin default lost the badge but can be restored.
    await page.goto(`/models/${builtinOcr.id}`)
    await expect(page.getByTestId('model-files')).toHaveText('not stored')
    await expect(header.getByText('★ DEFAULT')).toHaveCount(0)
    await page.getByRole('button', { name: 'Set default' }).click()
    await expect(header.getByText('★ DEFAULT')).toBeVisible()
    await expect.poll(async () => (await listRegistryModels()).find((m) => m.id === builtinOcr.id)?.is_default)
      .toBe(true)

    // The wizard description landed on the model page and stays editable.
    await page.goto(`/models/${registered.id}`)
    await expect(page.getByTestId('model-notes')).toHaveText('Trained on the e2e smoke set')
    await page.getByRole('button', { name: 'Edit' }).click()
    await page.getByLabel('Description').fill('Updated notes')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByTestId('model-notes')).toHaveText('Updated notes')
    await expect
      .poll(async () => (await listRegistryModels()).find((m) => m.name === modelName)?.notes)
      .toBe('Updated notes')

    // Deleting the run is blocked while its model is active, allowed once archived.
    page.on('dialog', (dialog) => dialog.accept())
    await page.goto('/models?tab=runs')
    await run.getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByText(/archive the model first/)).toBeVisible()
    await page.goto(`/models/${registered.id}`)
    await page.getByTestId('archive-model').click()
    await expect(header.getByText('ARCHIVED')).toBeVisible()
    await page.goto('/models?tab=runs')
    await run.getByRole('button', { name: 'Delete' }).click()
    await expect(run).toHaveCount(0)
    await expect
      .poll(async () => (await listTrainings()).some((t) => t.name === modelName))
      .toBe(false)
    // Even the archived row is gone - the model record was removed with its checkpoint.
    await expect
      .poll(async () => (await listRegistryModels(true)).some((m) => m.name === modelName))
      .toBe(false)
  })

  // Rerunning used to mean reading a finished run's settings off the card and retyping
  // thirty of them, which is how a "same run, bigger card" comparison quietly becomes a
  // comparison of two different runs.
  test('a finished run reopens prefilled, and its batch follows the target', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Rerunnable'), 2)
    await markLinesChecked(jobId, 12)
    const holdoutId = await seedCompletedJob(uniqueName('Rerun holdout'), 1)
    await markLinesChecked(holdoutId, 6)
    const sourceName = uniqueName('Local run')
    // Someone else's run, submitted with settings no default would produce.
    await createTraining({
      task: 'ocr', name: sourceName, dataset_job_ids: [jobId], target: 'local',
      description: 'the one worth repeating',
      epochs: 1, batch_size: 4, val_fraction: 0.3,
      split_strategy: 'holdout', valid_job_ids: [holdoutId], test_job_ids: [holdoutId],
      hyperparams: { learning_rate: 0.00005, patience: 5, warmup_epochs: 2 },
    })
    await expect
      .poll(async () => (await listTrainings()).find((t) => t.name === sourceName)?.status,
            { timeout: 60_000 })
      .toBe('done')

    await page.goto('/models?tab=runs')
    const source = page.getByTestId('training-row').filter({ hasText: sourceName })
    // Every run is everyone's to see, under the name of whoever started it.
    await expect(source).toContainText('e2e-seeder')
    await source.getByTestId('rerun-training').click()

    // Every field the run was submitted with, back in the control that sets it - and the
    // advanced panel already open, since that is where most of them live.
    await expect(page.getByRole('heading', { name: `Rerun ${sourceName}` })).toBeVisible()
    await expect(page.getByLabel('Model name')).toHaveValue(`${sourceName} rerun`)
    await expect(page.getByLabel('Description')).toHaveValue('the one worth repeating')
    await expect(page.getByText('12 checked lines selected')).toBeVisible()
    await expect(page.getByLabel('Test dataset')).toHaveValue(holdoutId)
    await expect(page.getByTestId('steer-by-test')).toBeChecked()
    // The run left the trainer its own stack, so the rerun does too - the task's default
    // pipeline does not get adopted underneath it.
    await expect(page.getByLabel('Augmentation', { exact: true })).toHaveValue('builtin')
    await expect(page.getByLabel('Epochs', { exact: true })).toHaveValue('1')
    await expect(page.getByLabel('Batch size')).toHaveValue('4')
    await expect(page.getByLabel('Learning rate')).toHaveValue('0.00005')
    await expect(page.getByTestId('early-stop-toggle')).toBeChecked()
    await expect(page.getByLabel('Patience')).toHaveValue('5')
    // By attribute, not by the summary's text: it now also carries a tuned count.
    await page.locator('[data-testid="knob-group"][data-group="Schedule"] summary').click()
    await expect(page.getByLabel('Warmup epochs', { exact: true })).toHaveValue('2')
    await expect(page.getByTestId('tuned-count')).toHaveText('· 1 tuned')
    await expect(page.getByTestId('rerun-notes')).toHaveCount(0)

    // The point of the button: the same run, other hardware. A batch measured for the
    // card that run had does not travel to a different one.
    await page.getByRole('radio', { name: /Cluster/ }).check()
    await expect(page.getByLabel('GPU type')).toBeVisible()
    await expect(page.getByLabel('Batch size')).toHaveValue('')
    await expect(page.getByTestId('rerun-notes')).toContainText('batch size is cleared')
    // This stack names a cluster it can never reach, so the submit stops at the session
    // the dialog insists on; what the cluster does with the run belongs to the backend
    // tests. Switching back is what proves the batch came from the target and not from
    // a field that had been emptied for good.
    await expect(page.getByTestId('cluster-session')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled()
    await page.getByRole('radio', { name: 'Local GPU' }).check()
    await expect(page.getByLabel('Batch size')).toHaveValue('4')
    await expect(page.getByTestId('rerun-notes')).toHaveCount(0)
    await startTraining(page)

    // The new run carries every setting of the old one, under a name of its own.
    const rerunName = `${sourceName} rerun`
    await expect
      .poll(async () => (await listTrainings()).find((t) => t.name === rerunName), { timeout: 30_000 })
      .toMatchObject({
        task: 'ocr', target: 'local', owner: 'dev', batch_size: 4, gpu_type: null, gpu_count: null,
        epochs: 1, val_fraction: 0.3, split_strategy: 'holdout', augmentation: null,
        description: 'the one worth repeating',
        dataset_job_ids: [jobId], valid_job_ids: [holdoutId], test_job_ids: [holdoutId],
        hyperparams: { learning_rate: 0.00005, patience: 5, warmup_epochs: 2 },
      })
    const rerun = page.getByTestId('training-row').filter({ hasText: rerunName })
    await expect(rerun).toContainText('local')
    await expect(rerun).toContainText('you')
  })

  // A run registers its model under its own name, so two runs under one name leave a pair
  // nothing downstream can tell apart.
  test('a name another run is already training under is refused in the dialog', async ({ page }) => {
    const datasetName = uniqueName('Name clash')
    const jobId = await seedCompletedJob(datasetName, 1)
    await markLinesChecked(jobId, 6)
    const taken = uniqueName('Queued run')
    await createTraining({ task: 'ocr', name: taken, dataset_job_ids: [jobId], target: 'local' })

    await page.goto('/models')
    const ocrSection = taskSection(page, 'ocr')
    await ocrSection.getByTestId('train-model').click()
    // Everything else about the submit is in order, so the name is the only thing left
    // that can hold it back.
    await pickDataset(page, datasetName)
    await page.getByLabel('Model name').fill(taken)

    await expect(page.getByTestId('name-taken')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled()
    // A name nobody holds clears it, so the warning is about this name and not the field.
    await page.getByLabel('Model name').fill(`${taken} two`)
    await expect(page.getByTestId('name-taken')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled()
  })

  // The evaluate dialog listed every dataset flat while the training dialog grouped them, so
  // the same datasets read as two different sets depending on which button you pressed.
  test('the evaluate dialog puts a dataset under its project, like training does',
    async ({ page }) => {
      const grouped = uniqueName('In a project')
      const loose = uniqueName('No project')
      const groupName = uniqueName('Eval project')
      const groupedJob = await seedCompletedJob(grouped, 1)
      const looseJob = await seedCompletedJob(loose, 1)
      await markLinesChecked(groupedJob, 3)
      await markLinesChecked(looseJob, 2)
      await moveJobToGroup(groupedJob, (await createGroup(groupName)).id)
      const builtin = (await listRegistryModels()).find((m) => m.task === 'ocr' && m.source === 'backend')!

      await page.goto(`/models/${builtin.id}`)
      await page.getByRole('button', { name: 'Evaluate…' }).click()

      const section = page.locator(`[data-testid="dataset-group"][data-group="${groupName}"]`)
      await expect(section).toHaveCount(1)
      await section.getByRole('button', { name: groupName }).click()
      await expect(section.getByText(grouped)).toBeVisible()
      // The one with no project is in Ungrouped, not in this project's section.
      await expect(section.getByText(loose)).toHaveCount(0)
      const ungrouped = page.locator('[data-testid="dataset-group"][data-group="Ungrouped"]')
      await ungrouped.getByRole('button', { name: 'Ungrouped' }).click()
      await expect(ungrouped.getByText(loose)).toBeVisible()

      // And the project header picks its own datasets, which a flat list cannot do.
      await section.getByRole('button', { name: 'Add all' }).click()
      await expect(page.getByText('3 checked lines selected')).toBeVisible()
    })

  test('a model is benchmarked on chosen datasets, per-dataset scores included', async ({ page }) => {
    const name = uniqueName('Golden set')
    const secondName = uniqueName('Silver set')
    const jobId = await seedCompletedJob(name, 1)
    const secondJob = await seedCompletedJob(secondName, 1)
    await markLinesChecked(jobId, 3)
    await markLinesChecked(secondJob, 2)
    const reader = { id: importStubModel('ocr', `${name} reader`, 'stub-misread') }

    await page.goto(`/models/${reader.id}`)
    await page.getByRole('button', { name: 'Evaluate…' }).click()
    await pickDataset(page, name)
    await pickDataset(page, secondName)
    await expect(page.getByText('5 checked lines selected')).toBeVisible()
    await page.getByRole('button', { name: 'Start evaluation' }).click()

    // Backend oracle: the run scores exactly the datasets' checked lines and attributes
    // them per dataset. Five header lines of 20 characters, read with one case error, one
    // digit error and one lost space plus a stray full stop: 4 edits over 100 characters.
    await expect
      .poll(async () =>
        (await listEvaluations()).find(
          (e) => e.model_id === reader.id && e.source.jobs?.includes(jobId) && e.status === 'done'),
        { timeout: 30_000 })
      .toMatchObject({ cer: 0.04, line_count: 5, decode: 'beam' })
    const done = (await listEvaluations()).find(
      (e) => e.model_id === reader.id && e.source.jobs?.includes(jobId) && e.status === 'done')!
    expect(Object.fromEntries(done.breakdown!.map((b) => [b.job_id, b.lines])))
      .toEqual({ [jobId]: 3, [secondJob]: 2 })

    // The model page shows the overall score; the per-dataset rows sit behind their toggle.
    const scored = page.getByTestId('eval-row').filter({ hasText: name })
    await expect(scored).toContainText('5 lines')
    const line = page.locator('div', { has: scored }).last()
    await expect(line.getByTestId('breakdown-row')).toHaveCount(0)
    await scored.getByTestId('breakdown-toggle').click()
    await expect(line.getByTestId('breakdown-row')).toHaveCount(2)
    await expect(line.getByTestId('breakdown-row').filter({ hasText: name })).toContainText('3 lines')
  })

  test('a test dataset is held out, steers validation only when asked, and is scored', async ({ page }) => {
    const trainName = uniqueName('Testset train')
    const testName = uniqueName('Testset held out')
    const trainJob = await seedCompletedJob(trainName, 1)
    const testJob = await seedCompletedJob(testName, 1)
    await markLinesChecked(trainJob, 3)
    await markLinesChecked(testJob, 2)
    const modelName = uniqueName('OCR testset')

    await page.goto('/models')
    const ocrSection = taskSection(page, 'ocr')
    await ocrSection.getByTestId('train-model').click()

    await page.getByLabel('Model name').fill(modelName)
    await pickDataset(page, trainName)
    await page.getByLabel('Test dataset').selectOption({ label: `${testName} (2)` })

    // Steering swaps the split controls for the test dataset itself.
    await page.getByTestId('advanced-toggle').click()
    await expect(page.getByLabel('Validation split')).toBeVisible()
    await page.getByTestId('steer-by-test').check()
    await expect(page.getByLabel('Validation split')).toHaveCount(0)
    await page.getByLabel('Epochs', { exact: true }).fill('1')
    // The summary names what will actually run, hidden defaults included.
    await expect(page.getByTestId('submit-summary')).toContainText('validated on the test dataset')
    await expect(page.getByTestId('submit-summary')).toContainText(`test: ${testName}`)
    await startTraining(page)

    const run = page.getByTestId('training-row').filter({ hasText: modelName })
    await expect(run.getByText('done')).toBeVisible({ timeout: 30_000 })

    // Backend oracle: every checked line of the training dataset trains, every
    // checked line of the test dataset validates - exact counts, no leakage.
    await expect
      .poll(async () => (await listTrainings()).find((t) => t.name === modelName))
      .toMatchObject({
        split_strategy: 'holdout',
        valid_job_ids: [testJob],
        test_job_ids: [testJob],
        snapshot_counts: { train: 3, val: 2 },
      })

    // Finishing queued a test-set score for the new model and its base alike - one
    // headline number each, in the decode the model actually runs in.
    const trainingId = (await listTrainings()).find((t) => t.name === modelName)!.id
    await expect
      .poll(async () =>
        (await listEvaluations())
          .filter((e) => e.training_id === trainingId && e.source.jobs?.[0] === testJob)
          .map((e) => e.decode))
      .toEqual(['beam', 'beam'])

    // The model page lists every evaluation, the test-set score among them, and leads
    // with that score.
    const modelId = (await listRegistryModels()).find((m) => m.name === modelName)!.id
    await page.goto(`/models/${modelId}`)
    await expect(page.getByTestId('eval-row')).toHaveCount(4)
    await expect(page.getByTestId('eval-row').filter({ hasText: testName })).toHaveCount(1)
    const testScoreOf = async () => (await listEvaluations()).find(
      (e) => e.model_id === modelId && e.training_id === trainingId && e.source.jobs?.[0] === testJob)
    await expect.poll(async () => (await testScoreOf())?.status, { timeout: 30_000 }).toBe('done')
    const testScore = (await testScoreOf())!
    await expect(page.getByTestId('model-score')).toContainText(`${(testScore.cer! * 100).toFixed(2)}%`)
  })

  test('the run list filters by stage and state, and lays two runs over each other',
    async ({ page }) => {
      const dataset = await seedCompletedJob(uniqueName('Compare data'), 1)
      await markLinesChecked(dataset, 3)
      const names = [uniqueName('Compare A'), uniqueName('Compare B')]
      for (const name of names) {
        await createTraining({ task: 'ocr', name, dataset_job_ids: [dataset], epochs: 1 })
      }
      await page.goto('/models?tab=runs')
      const rows = page.getByTestId('training-row')
      for (const name of names) {
        await expect(rows.filter({ hasText: name }).getByText('done')).toBeVisible({ timeout: 30_000 })
      }

      // Filtering by a stage nothing ran under empties the list; back to all brings the
      // same runs back, so an empty list is the filter and not a broken locator.
      const filters = page.getByTestId('run-filters')
      await filters.getByRole('button', { name: 'layout', exact: true }).click()
      await expect(rows).toHaveCount(0)
      await filters.getByRole('button', { name: 'all stages' }).click()
      for (const name of names) await expect(rows.filter({ hasText: name })).toHaveCount(1)

      // The same for state: these two are finished, so "running" has nothing.
      await filters.getByRole('button', { name: 'running', exact: true }).click()
      await expect(rows).toHaveCount(0)
      await filters.getByRole('button', { name: 'all', exact: true }).click()

      // Two picked, and the charts carry one line per run - named, so the legend is not
      // colour alone.
      await expect(page.getByTestId('run-compare')).toHaveCount(0)
      for (const name of names) {
        await rows.filter({ hasText: name }).getByTestId('compare-pick').check()
      }
      await page.getByTestId('compare-runs').click()
      const panel = page.getByTestId('run-compare')
      await expect(panel).toContainText('Comparing 2 runs')
      const cer = panel.locator('[data-testid="metric-chart"][data-metric="cer"]')
      await expect(cer.locator('path[data-line="smoothed"]')).toHaveCount(2)
      for (const name of names) await expect(cer).toContainText(name)

      // The model each run registered is named beside it, and the model says which run
      // it came from - the same pair of facts read from either end.
      const runRow = rows.filter({ hasText: names[0] })
      await expect(runRow.getByTestId('run-model')).toContainText(names[0])
      const registered = (await listRegistryModels()).find((m) => m.name === names[0])!
      await page.goto(`/models/${registered.id}`)
      await expect(page.getByTestId('model-from-run')).toHaveText(names[0])
    })

  test('a finished run charts its test-set score against the base model', async ({ page }) => {
    const trainName = uniqueName('Testchart train')
    const validName = uniqueName('Testchart valid')
    const testName = uniqueName('Testchart held out')
    const trainJob = await seedCompletedJob(trainName, 1)
    const validJob = await seedCompletedJob(validName, 1)
    const testJob = await seedCompletedJob(testName, 1)
    await markLinesChecked(trainJob, 3)
    await markLinesChecked(validJob, 2)
    await markLinesChecked(testJob, 2)

    const start = async (name: string, baseModelId: number | null) => {
      await createTraining({ task: 'ocr', name, dataset_job_ids: [trainJob],
                             split_strategy: 'holdout', valid_job_ids: [validJob],
                             test_job_ids: [testJob], epochs: 1, base_model_id: baseModelId })
      await page.goto('/models?tab=runs')
      const row = page.getByTestId('training-row').filter({ hasText: name })
      await expect(row.getByText('done')).toBeVisible({ timeout: 30_000 })
      const id = (await listTrainings()).find((t) => t.name === name)!.id
      // The band only renders once the score exists, so wait on the score, not the run.
      await expect
        .poll(async () => (await listEvaluations()).filter(
          (e) => e.training_id === id && e.source.jobs?.[0] === testJob && e.status === 'done').length,
              { timeout: 30_000 })
        .toBeGreaterThan(0)
      await row.getByTestId('training-open').click()
      return { row, id }
    }
    const pct = (cer: number) => `${(cer * 100).toFixed(2)}%`
    const testScore = async (trainingId: number, modelId: number) =>
      (await listEvaluations()).find(
        (e) => e.training_id === trainingId && e.model_id === modelId &&
          e.source.jobs?.[0] === testJob && e.status === 'done')!.cer!

    // Trained from scratch: the band carries the new model alone, because there is no
    // base whose score on this material would mean anything.
    const nameA = uniqueName('OCR testchart A')
    const first = await start(nameA, null)
    const firstModel = (await listRegistryModels()).find((m) => m.name === nameA)!
    await expect(page.getByTestId('score-test-new'))
      .toContainText(pct(await testScore(first.id, firstModel.id)))
    await expect(page.getByTestId('score-test-base')).toHaveCount(0)

    // Warm-started from it: both scores, on material neither run ever trained on, so the
    // chart answers "did it help?" where the run is read.
    const nameB = uniqueName('OCR testchart B')
    const second = await start(nameB, firstModel.id)
    const secondModel = (await listRegistryModels()).find((m) => m.name === nameB)!
    await expect(page.getByTestId('score-test-base'))
      .toContainText(pct(await testScore(second.id, firstModel.id)))
    await expect(page.getByTestId('score-test-new'))
      .toContainText(pct(await testScore(second.id, secondModel.id)))
  })

  test('a multi-dataset valid split charts per-dataset CER curves', async ({ page }) => {
    const trainName = uniqueName('Curves train')
    const validAName = uniqueName('Curves valid A')
    const validBName = uniqueName('Curves valid B')
    const trainJob = await seedCompletedJob(trainName, 1)
    const validA = await seedCompletedJob(validAName, 1)
    const validB = await seedCompletedJob(validBName, 1)
    await markLinesChecked(trainJob, 3)
    await markLinesChecked(validA, 2)
    await markLinesChecked(validB, 2)
    const modelName = uniqueName('OCR curves')
    await createTraining({ task: 'ocr', name: modelName, dataset_job_ids: [trainJob],
                           split_strategy: 'holdout', valid_job_ids: [validA, validB], epochs: 3 })

    await page.goto('/models?tab=runs')
    const run = page.getByTestId('training-row').filter({ hasText: modelName })
    await expect(run.getByText('done')).toBeVisible({ timeout: 30_000 })

    // Backend oracle: each epoch's point carries one CER per valid dataset, keyed by id.
    const trainingId = (await listTrainings()).find((t) => t.name === modelName)!.id
    const points = (await getTrainingProgress(trainingId)).points
    const last = points[points.length - 1]
    expect(Object.keys(last.cer_by_dataset ?? {}).sort()).toEqual([validA, validB].sort())

    // A run whose valid split spans two datasets gets a chart of its own for them,
    // one named line each, beside the overall curve.
    await run.getByTestId('training-open').click()
    await page.getByRole('tab', { name: 'Curves' }).click()
    const overall = page.locator('[data-testid="metric-chart"][data-metric="cer"]')
    await expect(overall).toBeVisible()
    const perDataset = page.locator('[data-testid="metric-chart"][data-metric="cer_by_dataset"]')
    await expect(perDataset).toContainText(validAName)
    await expect(perDataset).toContainText(validBName)
    // A single-dataset run has no such chart, so this one is not a fixture of the page.
    await page.goto(`/models/runs/${(await listTrainings()).find((t) => t.name === modelName)!.id}?tab=curves`)
    await expect(perDataset).toHaveCount(1)
  })

  test('a run that reported no timestamps is not offered a time axis', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Stamps'), 1)
    await markLinesChecked(jobId, 3)
    const stamped = uniqueName('Stamped')
    // The stub trainer omits `ts` for a run named this way, which the progress contract
    // allows - `ts` is optional and a real trainer may simply not report it.
    const plain = `${uniqueName('Unstamped')} [no-ts]`
    for (const name of [stamped, plain]) {
      await createTraining({ task: 'ocr', name, dataset_job_ids: [jobId], epochs: 3 })
    }
    await expect
      .poll(async () => (await listTrainings())
        .filter((t) => [stamped, plain].includes(t.name) && t.status === 'done').length,
            { timeout: 60_000 })
      .toBe(2)
    const runs = await listTrainings()
    const stampedId = runs.find((t) => t.name === stamped)!.id
    const plainId = runs.find((t) => t.name === plain)!.id

    // Backend oracle: the two runs really do differ in what they reported.
    expect((await getTrainingProgress(stampedId)).points.every((p) => typeof p.ts === 'number'))
      .toBe(true)
    expect((await getTrainingProgress(plainId)).points.some((p) => p.ts !== undefined))
      .toBe(false)

    // So one can be read against elapsed time and the other cannot - drawing the second
    // on a time axis would label its epoch numbers as seconds.
    const toolbar = page.getByTestId('curve-toolbar')
    await page.goto(`/models/runs/${stampedId}?tab=curves`)
    await expect(toolbar.getByRole('button', { name: 'time' })).toBeVisible()
    await page.goto(`/models/runs/${plainId}?tab=curves`)
    await expect(toolbar.getByRole('button', { name: 'epoch' })).toBeVisible()
    await expect(toolbar.getByRole('button', { name: 'time' })).toHaveCount(0)
  })

  test('a refused submit explains itself inside the dialog, not behind it', async ({ page }) => {
    const jobName = uniqueName('Vanishing data')
    const jobId = await seedCompletedJob(jobName, 1)
    await markLinesChecked(jobId, 3)

    await page.goto('/models')
    const ocrSection = taskSection(page, 'ocr')
    await ocrSection.getByTestId('train-model').click()

    // A name the registry already holds is stopped before it ever reaches the server.
    await page.getByLabel('Model name').fill(OCR_READER)
    await pickDataset(page, jobName)
    await expect(page.getByTestId('name-taken')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled()

    // A server refusal the client cannot foresee - the dataset vanished after the
    // dialog loaded - lands inside the dialog instead of invisibly behind it.
    await page.getByLabel('Model name').fill(uniqueName('OCR refused'))
    await backendFetch(`/api/jobs/${jobId}`, { method: 'DELETE' })
    await startTraining(page)
    await expect(page.getByTestId('dialog-error')).toContainText(/not found/i)
  })

  test('a member manages the model their training produced, global knobs stay admin-only', async () => {
    const trainer = `trainer-${Date.now()}`
    const rival = `rival-${Date.now()}`
    seedSession('member', trainer)
    seedSession('member', rival)
    const mine = identity(trainer, 'member')

    const jobId = await createJob(uniqueName('Members data'), 1, undefined, mine)
    await waitForJobStatus(jobId, 'done')
    await markLinesChecked(jobId, 3)
    const modelName = uniqueName('Members model')
    await createTraining({ task: 'ocr', name: modelName, dataset_job_ids: [jobId], target: 'local' }, mine)

    // The registered model carries the training's owner.
    await expect
      .poll(async () => (await listRegistryModels()).find((m) => m.name === modelName), { timeout: 30_000 })
      .toMatchObject({ owner: trainer })
    const model = (await listRegistryModels()).find((m) => m.name === modelName)!

    // The owner polishes name and notes; the exact values come back from the API.
    const renamed = `${modelName} v2`
    const patched = await backendFetch(`/api/models/${model.id}`, {
      method: 'PATCH',
      headers: { ...mine, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: renamed, notes: 'my best run' }),
    })
    expect(patched).toMatchObject({ name: renamed, notes: 'my best run', owner: trainer })

    // Global knobs and other people's models answer 403, not silent no-ops.
    await expect(backendFetch(`/api/models/${model.id}`, {
      method: 'PATCH',
      headers: { ...mine, 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_default: true }),
    })).rejects.toThrow(/403/)
    await expect(backendFetch(`/api/models/${model.id}`, {
      method: 'PATCH',
      headers: { ...identity(rival, 'member'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'hijacked' }),
    })).rejects.toThrow(/403/)

    // The owner can retire their own model.
    const archived = await backendFetch(`/api/models/${model.id}`, {
      method: 'PATCH',
      headers: { ...mine, 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    })
    expect(archived).toMatchObject({ archived: true, name: renamed })
  })

  test('the cluster target is admin-only, in the dialog and in the API', async ({ page, browser }) => {
    const openTrainDialog = async (p: typeof page) => {
      await p.goto('/models')
      const ocr = taskSection(p, 'ocr')
      await ocr.getByTestId('train-model').click()
      return p.getByRole('radio', { name: 'Cluster (SLURM)' })
    }
    await expect(await openTrainDialog(page)).toBeVisible()

    const username = `local-only-${Date.now()}`
    const context = await browser.newContext()
    await useSession(context, seedSession('member', username))
    const memberPage = await context.newPage()
    await expect(await openTrainDialog(memberPage)).toHaveCount(0)
    // Local training stays available to them, so an empty dialog cannot pass this.
    await expect(memberPage.getByRole('button', { name: 'Next', exact: true })).toBeVisible()

    const jobId = await createJob(uniqueName('Cluster attempt'), 1, undefined, identity(username, 'member'))
    await waitForJobStatus(jobId, 'done')
    await expect(createTraining(
      { task: 'ocr', name: uniqueName('Sneaky'), dataset_job_ids: [jobId], target: 'slurm' },
      identity(username, 'member'),
    )).rejects.toThrow(/403/)
    await context.close()
  })

  // README: "a layout or lines run has no language model to fit", and the form's last
  // step is the only one that says Train.
  test('only an OCR run offers to fit a language model, and the form says Next before Train', async ({ page }) => {
    await page.goto('/models/train?task=ocr')
    await expect(page.getByTestId('build-lm')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Train', exact: true })).toHaveCount(0)

    await page.goto('/models/train?task=lines')
    await expect(page.getByLabel('Model name')).toBeVisible()
    await expect(page.getByTestId('build-lm')).toHaveCount(0)

    const jobId = await seedCompletedJob(uniqueName('Lines with LM'), 1)
    await expect(createTraining({ task: 'lines', name: uniqueName('Lines with LM'), target: 'local',
                                  dataset_job_ids: [jobId], build_lm: true }))
      .rejects.toThrow(/400 .*a language model is only fitted for an OCR run/)
  })

  test('a cluster run starts on the card its backend prefers, until one is picked', async ({ page }) => {
    // The options are served with a preference: the stub backend declares none, and the
    // preference is the backend's to state, read from its resources by the options route.
    let preferred: string | null = 'l40s'
    await page.route('**/api/trainings/options**', async (route) => {
      const real = await (await route.fetch()).json()
      await route.fulfill({ json: { ...real, preferred_gpu: preferred } })
    })
    await page.goto('/models')
    await taskSection(page, 'ocr').getByTestId('train-model').click()
    await page.getByRole('radio', { name: 'Cluster (SLURM)' }).check()
    await page.getByRole('button', { name: /Advanced options/ }).click()

    await expect(page.getByLabel('GPU type')).toHaveValue('l40s')

    await page.getByLabel('GPU type').selectOption('h200')
    preferred = 'l40s'
    await page.getByLabel('Base model').selectOption({ index: 0 })
    await expect(page.getByLabel('GPU type')).toHaveValue('h200')
  })

  test('without a preference a cluster run starts on the first card the deployment lists', async ({ page }) => {
    await page.route('**/api/trainings/options**', async (route) => {
      const real = await (await route.fetch()).json()
      await route.fulfill({ json: { ...real, preferred_gpu: null } })
    })
    await page.goto('/models')
    await taskSection(page, 'ocr').getByTestId('train-model').click()
    await page.getByRole('radio', { name: 'Cluster (SLURM)' }).check()
    await page.getByRole('button', { name: /Advanced options/ }).click()

    await expect(page.getByLabel('GPU type')).toHaveValue('rtx6000bb')
  })

  test('an admin can grant a member the cluster, and the grant reaches the backend',
    async ({ page, browser }) => {
      const username = `cluster-grant-${Date.now()}`
      const context = await browser.newContext()
      await useSession(context, seedSession('member', username))
      const memberPage = await context.newPage()

      const openTrainDialog = async (p: typeof page) => {
        await p.goto('/models')
        const ocr = taskSection(p, 'ocr')
        await ocr.getByTestId('train-model').click()
        return p.getByRole('radio', { name: 'Cluster (SLURM)' })
      }

      await expect(await openTrainDialog(memberPage)).toHaveCount(0)

      await page.goto('/admin')
      // The accounts table, not the permissions grid below it - both carry a row per
      // person, and the grants live on the first.
      const row = page.getByTestId('user-row').filter({ hasText: username })
      await expect(row).toHaveCount(1)
      // click, not check: the box is controlled and only flips once the PATCH resolves,
      // so check() would see it snap back and fail before the grant ever landed.
      await row.getByTestId('train-cluster').click()
      // Backend-state oracle: what the member's own session is offered, resolved through
      // nginx and /validate rather than read back off the page that just set it.
      await expect.poll(async () => {
        const response = await memberPage.request.get('/api/trainings')
        return (await response.json()).targets.slurm
      }).toBe(true)
      await expect(row.getByTestId('train-cluster')).toBeChecked()

      // The grant travels as a proxy header, so only a real request through nginx proves it.
      const clusterRadio = await openTrainDialog(memberPage)
      await expect(clusterRadio).toBeVisible()
      await expect(memberPage.getByTestId('cluster-experimental')).toHaveText('highly experimental')
      // Unlocking stays with admins: they hold the second factor.
      await expect(memberPage.getByRole('button', { name: 'Connect to cluster' })).toHaveCount(0)

      const jobId = await createJob(uniqueName('Granted'), 1, undefined, identity(username, 'member'))
      await waitForJobStatus(jobId, 'done')
      // Through their own session, so nginx resolves the grant into the header the
      // backend reads - posting straight at the backend would carry no grant at all.
      const submitted = await memberPage.request.post('/api/trainings', {
        data: { task: 'ocr', name: uniqueName('Granted'), dataset_job_ids: [jobId],
                target: 'slurm', gpu_type: 'rtx6000bb', gpu_count: 2 },
      })
      // Past the gate: it stops on the dataset having nothing reviewed, not on access.
      expect(submitted.status()).toBe(400)
      expect((await submitted.json()).detail).toContain('no checked material')
      await context.close()
    })
})

test.describe('Scenario: picking datasets by project', () => {
  test('the training dialog groups datasets the way the Jobs page does', async ({ page }) => {
    const groupName = uniqueName('Kurrent')
    const group = await createGroup(groupName)
    const inGroupA = uniqueName('Grouped A')
    const inGroupB = uniqueName('Grouped B')
    const loose = uniqueName('Loose set')
    const jobA = await seedCompletedJob(inGroupA, 1)
    const jobB = await seedCompletedJob(inGroupB, 1)
    const jobC = await seedCompletedJob(loose, 1)
    await markLinesChecked(jobA, 2)
    await markLinesChecked(jobB, 3)
    await markLinesChecked(jobC, 2)
    await moveJobToGroup(jobA, group.id)
    await moveJobToGroup(jobB, group.id)

    await page.goto('/models')
    const ocr = taskSection(page, 'ocr')
    await ocr.getByTestId('train-model').click()

    const section = page.locator(`[data-testid="dataset-group"][data-group="${groupName}"]`)
    await expect(section).toHaveCount(1)
    // A group with no pick starts folded, its datasets a click away.
    const header = section.getByRole('button', { name: groupName })
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await expect(section.getByTestId('dataset-option')).toHaveCount(0)
    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    // The group holds its own two and neither of the loose ones.
    await expect(section.getByTestId('dataset-option').filter({ hasText: inGroupA })).toHaveCount(1)
    await expect(section.getByTestId('dataset-option').filter({ hasText: inGroupB })).toHaveCount(1)
    await expect(section.getByTestId('dataset-option').filter({ hasText: loose })).toHaveCount(0)
    // And the loose one is listed under Ungrouped, so nothing is dropped.
    const ungrouped = page.locator('[data-testid="dataset-group"][data-group="Ungrouped"]')
    await ungrouped.getByRole('button', { name: 'Ungrouped' }).click()
    await expect(ungrouped.getByTestId('dataset-option').filter({ hasText: loose })).toHaveCount(1)

    // Add all takes the whole project in one click, and nothing outside it.
    await expect(section.getByText('0/2', { exact: true })).toBeVisible()
    await section.getByRole('button', { name: 'Add all' }).click()
    await expect(section.getByText('2/2', { exact: true })).toBeVisible()
    await expect(page.getByText('5 checked lines selected')).toBeVisible()

    await section.getByRole('button', { name: 'Clear' }).click()
    await expect(section.getByText('0/2', { exact: true })).toBeVisible()
  })

  // README: the picker "searches by name, leaves out a dataset with nothing to use, folds
  // a group until it holds a pick, and lists the picks above it".
  test('a dataset is found by searching, picked into a chip, and one with nothing to use is left out', async ({ page }) => {
    const groupName = uniqueName('Search project')
    const group = await createGroup(groupName)
    const usable = uniqueName('Searchable set')
    const empty = uniqueName('Searchable empty')
    const usableJob = await seedCompletedJob(usable, 1)
    const emptyJob = await seedCompletedJob(empty, 1)
    await markLinesChecked(usableJob, 4)
    await moveJobToGroup(usableJob, group.id)
    await moveJobToGroup(emptyJob, group.id)

    await page.goto('/models/train?task=ocr')
    const section = page.locator(`[data-testid="dataset-group"][data-group="${groupName}"]`)
    await expect(section.getByText('0/1', { exact: true })).toBeVisible()

    const option = await datasetOption(page, usable)
    await expect(option.getByText('4', { exact: true })).toBeVisible()
    await option.getByRole('checkbox').check()
    await expect(page.getByText('4 checked lines selected')).toBeVisible()
    const chip = page.getByTestId('dataset-pick').filter({ hasText: usable })
    await expect(chip).toHaveCount(1)
    await expect(section.getByText('1/1', { exact: true })).toBeVisible()

    // The empty one is never listed, so a search for it finds nothing.
    await page.getByRole('searchbox', { name: 'Search datasets' }).fill(empty)
    await expect(page.getByTestId('dataset-option')).toHaveCount(0)
    await expect(page.getByText('No dataset matches.')).toBeVisible()
    await expect(page.getByTestId('datasets-hidden')).toContainText('hidden: nothing to use')

    // Cleared, the search leaves the group open on its pick.
    await page.getByRole('searchbox', { name: 'Search datasets' }).fill('')
    await expect(section.getByTestId('dataset-option').filter({ hasText: usable })).toHaveCount(1)
    await chip.getByRole('button', { name: `Remove ${usable}` }).click()
    await expect(page.getByTestId('dataset-pick')).toHaveCount(0)
    await expect(page.getByText('0 checked lines selected')).toBeVisible()
  })

  test('the dialog asks for its counts in a body, not in the URL', async ({ page }) => {
    // Opening the dialog previews every dataset there is at once. While those ids rode
    // in the query string the request line outgrew the proxy's 8k limit at 627 datasets,
    // and the 414 left the picker without counts, with every checkbox disabled.
    const name = uniqueName('Counted')
    const jobId = await seedCompletedJob(name, 1)
    await markLinesChecked(jobId, 6)

    const previews: { method: string, query: string }[] = []
    page.on('request', (req) => {
      const url = new URL(req.url())
      if (url.pathname === '/api/trainings/preview') {
        previews.push({ method: req.method(), query: url.search })
      }
    })

    await page.goto('/models')
    const ocr = taskSection(page, 'ocr')
    await ocr.getByTestId('train-model').click()

    const dataset = await datasetOption(page, name)
    await expect(dataset.getByText('6', { exact: true })).toBeVisible()
    await expect(dataset.getByRole('checkbox')).toBeEnabled()
    await dataset.getByRole('checkbox').check()
    await expect(page.getByText('6 checked lines selected')).toBeVisible()

    expect(previews).toEqual([{ method: 'POST', query: '' }])
  })
})

test.describe('Scenario: bringing an archived model back', () => {
  test('an archived model is listed apart and Unarchive returns it to the pickers', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Unarchive source'), 1)
    await markLinesChecked(jobId, 3)
    const modelName = uniqueName('Retired then back')
    // A fine-tune, so its family has live versions to stay beside once it is archived.
    const builtin = (await listRegistryModels()).find((m) => m.task === 'ocr' && m.source === 'backend')!
    await createTraining({ task: 'ocr', name: modelName, dataset_job_ids: [jobId], target: 'local', epochs: 1,
                           base_model_id: builtin.id })
    await expect
      .poll(async () => (await listRegistryModels()).find((m) => m.name === modelName), { timeout: 30_000 })
      .toMatchObject({ name: modelName })
    const modelId = (await listRegistryModels()).find((m) => m.name === modelName)!.id

    await page.goto('/models')
    const row = await versionRow(page, 'ocr', modelId)
    await expect(row).toBeVisible()
    await expect(row.getByTestId('version-tag')).toHaveCount(0)
    await row.getByTestId('version-open').click()
    await expect(page).toHaveURL(new RegExp(`/models/${modelId}$`))
    await page.getByTestId('archive-model').click()
    await expect.poll(async () => (await listRegistryModels(true)).find((m) => m.id === modelId))
      .toMatchObject({ archived: true })

    // Archived, it stays on its family's graph - faded and tagged - unless hidden.
    await page.goto('/models')
    const archivedRow = await versionRow(page, 'ocr', modelId)
    await expect(archivedRow.getByTestId('version-tag')).toHaveText('ARCHIVED')
    await page.getByTestId('hide-archived').check()
    await expect(archivedRow).toHaveCount(0)
    await page.getByTestId('hide-archived').uncheck()
    await expect(archivedRow).toBeVisible()

    await archivedRow.getByTestId('version-open').click()
    await expect(page.getByTestId('archive-model')).toHaveText('Unarchive')
    await page.getByTestId('archive-model').click()
    await expect(page.getByTestId('archive-model')).toHaveText('Archive')
    await expect.poll(async () => (await listRegistryModels()).find((m) => m.id === modelId))
      .toMatchObject({ archived: false, is_default: false })

    await page.goto('/models/train?task=ocr')
    await expect(page.getByLabel('Base model').locator('option', { hasText: `Fine-tune ${modelName}` }))
      .toHaveAttribute('value', String(modelId))
  })
})

test.describe('Scenario: what a run page reports', () => {
  test('lines trained counts the training split, with the validation count beside it', async ({ page }) => {
    const trainJob = await seedDistinctPagesJob(uniqueName('Counted train'), 2)
    await markLinesChecked(trainJob, 12)
    const holdout = await seedCompletedJob(uniqueName('Counted holdout'), 1)
    await markLinesChecked(holdout, 3)
    const name = uniqueName('Counted run')
    await createTraining({
      task: 'ocr', name, dataset_job_ids: [trainJob], target: 'local', epochs: 1,
      split_strategy: 'holdout', valid_job_ids: [holdout],
    })
    await expect
      .poll(async () => (await listTrainings()).find((t) => t.name === name), { timeout: 30_000 })
      .toMatchObject({ status: 'done', snapshot_counts: { train: 12, val: 3 } })
    const runId = (await listTrainings()).find((t) => t.name === name)!.id

    await page.goto(`/models/runs/${runId}`)
    const tile = page.getByTestId('stat-tile').filter({ hasText: 'lines trained' })
    await expect(tile).toHaveCount(1)
    await expect(tile).toHaveText(/^lines trained\s*12\s*3 validation$/)
  })

  // README: "says how the language model it was asked to build went: "building" until the
  // build ends, then "built" or "failed", or "not built" for a run that ended before it got
  // that far."
  test('the settings say how the language model build went, or that it never got that far', async ({ page }) => {
    // The stub OCR trainer builds the language model a run asks for, and fails it for a run
    // named [lm-fails]; a cluster submit with no session open fails at its reachability
    // probe, before the build.
    test.setTimeout(180_000)
    const jobId = await seedCompletedJob(uniqueName('LM source'), 1)
    await markLinesChecked(jobId, 3)
    const withLm = uniqueName('LM asked')
    const failing = uniqueName('LM asked [lm-fails]')
    const withoutLm = uniqueName('LM not asked')
    const neverReached = uniqueName('LM never reached')
    await createTraining({ task: 'ocr', name: withLm, dataset_job_ids: [jobId], target: 'local', epochs: 1, build_lm: true })
    await createTraining({ task: 'ocr', name: failing, dataset_job_ids: [jobId], target: 'local', epochs: 1, build_lm: true })
    await createTraining({ task: 'ocr', name: withoutLm, dataset_job_ids: [jobId], target: 'local', epochs: 1 })
    await createTraining({
      task: 'ocr', name: neverReached, dataset_job_ids: [jobId], target: 'slurm',
      gpu_type: 'h200', gpu_count: 1, build_lm: true,
    })
    for (const [runName, status, build_lm, lm_build] of [
      [withLm, 'done', true, 'built'], [failing, 'done', true, 'failed'], [withoutLm, 'done', false, null],
      [neverReached, 'error', true, null],
    ] as const) {
      await expect
        .poll(async () => (await listTrainings()).find((t) => t.name === runName), { timeout: 90_000 })
        .toMatchObject({ status, build_lm, lm_build })
    }

    const languageModel = (p: typeof page) => p.getByTestId('run-settings')
      .locator('[data-setting="language model"]').getByRole('definition')
    for (const [runName, shown] of [
      [withLm, 'built'], [failing, 'failed'], [withoutLm, 'no'], [neverReached, 'not built'],
    ] as const) {
      await page.goto(`/models/runs/${(await listTrainings()).find((t) => t.name === runName)!.id}?tab=settings`)
      await expect(languageModel(page)).toHaveText(shown)
    }
  })
})

test.describe('Scenario: a line run read on its test datasets', () => {
  // The stub backend cuts every task as OCR, so a finished lines run's metrics are served:
  // what the page draws from them is the subject here. The scoring itself is the SDK's
  // after_training, covered by its own tests.
  test('the base and the trained model are set side by side, overall and per dataset', async ({ page }) => {
    const runId = await cancelledRun('Test-set run')
    const scored = (f1: number, a: number) => ({
      metric: 'F1', overall: { F1: f1, precision: f1, recall: f1, pages: 3, instances: 30 },
      by_dataset: { 'ds-a': { F1: a, precision: a, recall: a, pages: 3, instances: 30 } },
    })
    await page.route('**/api/trainings', async (route) => {
      const real = await (await route.fetch()).json()
      real.trainings = real.trainings.map((t: { id: number }) => t.id !== runId ? t : {
        ...t, task: 'lines', status: 'done',
        metrics: { evaluation: scored(0.9, 0.9), test_evaluation: { trained: scored(0.8125, 0.8125), base: scored(0.75, 0.75) } },
      })
      await route.fulfill({ json: real })
    })

    await page.goto(`/models/runs/${runId}`)

    const table = page.getByTestId('test-evaluation')
    const overall = table.locator('tr[data-dataset="overall"]')
    await expect(overall.locator('[data-score="base"]')).toHaveText('75.00%')
    await expect(overall.locator('[data-score="trained"]')).toHaveText('81.25%')
    await expect(overall.locator('[data-score="change"]')).toHaveText('+6.25 pt')
    await expect(table.locator('tr[data-dataset="ds-a"]')).toHaveCount(1)
    await expect(page.getByTestId('final-evaluation')).toBeVisible()
  })
})

test.describe('Scenario: a family of fine-tunes', () => {
  test('two fine-tunes of one model fork on the graph, and the family can be named', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Family source'), 1)
    await markLinesChecked(jobId, 3)
    const run = async (name: string, base: number | null) => {
      await createTraining({ task: 'ocr', name, dataset_job_ids: [jobId], target: 'local', epochs: 1,
                             base_model_id: base })
      await expect.poll(async () => (await listRegistryModels()).find((m) => m.name === name)?.id,
                        { timeout: 60_000 }).toBeGreaterThan(0)
      return (await listRegistryModels()).find((m) => m.name === name)!.id
    }
    const rootName = uniqueName('Scratch root')
    const root = await run(rootName, null)
    const first = await run(uniqueName('Ledger ft'), root)
    const second = await run(uniqueName('Letters ft'), root)

    await page.goto('/models')
    const family = taskSection(page, 'ocr').locator(`[data-testid="model-family"][data-root="${root}"]`)
    await expect(family.getByTestId('family-name')).toHaveText(rootName)
    await expect(family.getByTestId('family-count')).toHaveText('3 versions')
    await expect(family.getByTestId('family-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(family.getByTestId('version-row')).toHaveCount(0)
    await family.getByTestId('family-toggle').click()

    // Newest on top, the root at the bottom of the main line, one fine-tune forked beside it.
    await expect(family.getByTestId('version-row')).toHaveCount(3)
    expect(await family.getByTestId('version-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-version'))))
      .toEqual([`m${second}`, `m${first}`, `m${root}`])
    const lanes = await family.getByTestId('graph-dot').evaluateAll((dots) =>
      Object.fromEntries(dots.map((d) => [d.getAttribute('data-version'), d.getAttribute('data-lane')])))
    expect(lanes[`m${root}`]).toBe('0')
    expect([lanes[`m${first}`], lanes[`m${second}`]].sort()).toEqual(['0', '1'])

    // Hovering a version lights its way back to the root and leaves the sibling fork out.
    await family.locator(`[data-testid="version-row"][data-version="m${second}"]`).hover()
    await expect(family.locator('[data-testid="version-row"][data-on-path="true"]')).toHaveCount(2)
    expect(await family.locator('[data-testid="version-row"][data-on-path="true"]').evaluateAll((rows) =>
      rows.map((r) => r.getAttribute('data-version')))).toEqual([`m${second}`, `m${root}`])
    await expect(family.locator(`[data-testid="version-row"][data-version="m${first}"]`))
      .toHaveAttribute('data-on-path', 'false')
    await expect(family.getByTestId('graph-path')).toHaveCount(1)
    await expect(family.getByTestId('graph-path')).toHaveAttribute('data-version', `m${second}`)
    await expect(family.locator('[data-testid="graph-dot"][data-hovered]')).toHaveAttribute('data-version', `m${second}`)
    await expect(family.locator(`[data-testid="graph-dot"][data-version="m${root}"]`)).not.toHaveAttribute('data-hovered')
    await page.mouse.move(0, 0)
    await expect(family.getByTestId('graph-path')).toHaveCount(0)
    await expect(family.locator(`[data-testid="version-row"][data-version="m${first}"]`))
      .not.toHaveAttribute('data-on-path')

    // The family is named on its root, and the list follows.
    await family.locator(`[data-testid="version-row"][data-version="m${root}"]`).getByTestId('version-open').click()
    await expect(page).toHaveURL(new RegExp(`/models/${root}$`))
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Family name').fill('Scratch Kurrent')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => (await listRegistryModels()).find((m) => m.id === root)?.family_name)
      .toBe('Scratch Kurrent')
    await page.goto('/models')
    await expect(family.getByTestId('family-name')).toHaveText('Scratch Kurrent')

    // A fine-tune's page has no family name to give.
    await page.goto(`/models/${first}`)
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.getByLabel('Description')).toBeVisible()
    await expect(page.getByLabel('Family name')).toHaveCount(0)
  })
})
