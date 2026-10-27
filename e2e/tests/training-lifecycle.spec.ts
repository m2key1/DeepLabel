import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import {
  backendFetch, createTraining, getTrainingProgress, identity, listJobs, listRegistryModels,
  listTrainings, markLinesChecked, seedCompletedJob, seedDistinctPagesJob, shareJob, uniqueName,
  type TrainingRow,
} from '../helpers/api'
import { seedSession, useSession } from '../helpers/session'
import { pickDataset } from '../helpers/training'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

/** GET /api/trainings as one caller sees it: the targets open to them, and the cluster's
 *  reachability as reported to someone who may act on it - null for anyone who may not. */
function trainingsFor(headers?: Record<string, string>): Promise<{
  targets: { local: boolean; slurm: boolean }
  cluster: { reachable: boolean } | null
}> {
  return backendFetch('/api/trainings', headers ? { headers } : {})
}

async function runNamed(name: string): Promise<TrainingRow | undefined> {
  return (await listTrainings()).find((t) => t.name === name)
}

function patchModel(modelId: number, body: Record<string, unknown>) {
  return backendFetch(`/api/models/${modelId}`, {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body),
  })
}

/** What backendFetch reports a refused call as: the status, then the body FastAPI wrote,
 *  which quotes the sentence the way JSON does. */
const refusal = (status: number, detail: string) => `${status} ${JSON.stringify({ detail })}`

async function modelNamed(name: string, includeArchived = false) {
  return (await listRegistryModels(includeArchived)).find((m) => m.name === name)
}

/** One page with six checked lines - the smallest dataset a run can be cut from. */
async function seedCheckedDataset(prefix: string): Promise<string> {
  const jobId = await seedCompletedJob(uniqueName(prefix), 1)
  await markLinesChecked(jobId, 6)
  return jobId
}

// The one-page local run the suite trains with. At 30% of a single page the split takes
// no page for validation (train_snapshot._rank_split never takes the last one), so all six
// lines train and the stub finishes in well under a minute.
const LOCAL_RUN = { task: 'ocr', target: 'local', epochs: 1, batch_size: 4, val_fraction: 0.3 }

async function trainToDone(name: string, jobId: string): Promise<TrainingRow> {
  await createTraining({ ...LOCAL_RUN, name, dataset_job_ids: [jobId] })
  await expect.poll(async () => (await runNamed(name))?.status, { timeout: 60_000 }).toBe('done')
  return (await runNamed(name))!
}

/** Clean-up, not an assertion: a run left sleeping on the shared GPU would hold up whatever
 *  the next scenario seeds. */
async function stopRun(name: string) {
  const run = (await runNamed(name))!
  if (['queued', 'preparing', 'running'].includes(run.status)) {
    await backendFetch(`/api/trainings/${run.id}/cancel`, { method: 'POST' })
  }
  await expect.poll(async () => (await runNamed(name))?.status, { timeout: 30_000 })
    .toMatch(/^(cancelled|done)$/)
}

/** trainer.probe_cluster's answer for a host that is never reached. The detail in the
 *  brackets is ssh's own and depends on the network: where cluster.invalid does not resolve
 *  ssh says so at once, where a wildcard resolves it the port is black-holed and ssh gives
 *  up at its 15 s connect timeout. The sentence around it, and the cure it names, are the
 *  same either way. */
const CLUSTER_UNREACHABLE = new RegExp(
  '^the cluster could not be reached \\(ssh: (connect to host cluster\\.invalid port 22: Connection timed out'
  + '|Could not resolve hostname cluster\\.invalid: .+)\\) - check the host and the network, then retry$',
)

test.describe('Scenario: stopping a run that is on the GPU', () => {
  // README: "Only a run - or a dataset - that is still queued or running can be cancelled",
  // and a run "that is over without a model - cancelled, failed - registered nothing"
  // (registry.name_clash), so a Cancel that lands while the trainer runs must kill it.
  test('cancelling a running local training stops it, registers no model and frees the GPU',
    async ({ page }) => {
      const jobId = await seedCheckedDataset('Stoppable data')
      // A run that finished beside it, so a row without Cancel can be told from a row
      // without buttons.
      const finishedName = uniqueName('Finished first')
      const finishedRun = await trainToDone(finishedName, jobId)

      // The stub trainer sleeps 15 s on a run named this way - the window the Cancel has to
      // land in while the run is really on the GPU, not merely queued for it.
      const name = `${uniqueName('Stoppable')} [slow]`
      await createTraining({ ...LOCAL_RUN, name, dataset_job_ids: [jobId] })
      await expect.poll(async () => (await runNamed(name))?.status, { timeout: 60_000 }).toBe('running')
      // Backend oracle for the premise: the shared GPU is busy with this very run.
      expect((await backendFetch('/api/queue')).gpu.running).toMatchObject({ kind: 'training', name })

      await page.goto('/models?tab=runs')
      const row = page.getByTestId('training-row').filter({ hasText: name })
      await row.getByTestId('run-actions').click()
      const cancel = row.getByTestId('cancel-training')
      await expect(cancel).toBeVisible()
      await cancel.click()

      await expect.poll(async () => runNamed(name), { timeout: 30_000 })
        .toMatchObject({ status: 'cancelled', model_id: null })
      // The worker only picks up the next item once the trainer process is gone, so a
      // dataset finishing behind the cancel is the fence: a runner that had outlived the
      // SIGTERM would have registered its model by the time this one is done. Read past the
      // fence, the run is still cancelled and still has no model - not under its name, not
      // at all.
      await seedCompletedJob(uniqueName('Behind the cancel'), 1)
      const run = (await runNamed(name))!
      expect(run).toMatchObject({ status: 'cancelled', model_id: null })
      expect((await listRegistryModels(true)).some((m) => m.name === name)).toBe(false)
      const progress = await getTrainingProgress(run.id)
      expect(progress.points).toEqual([])
      // The run that finished carries the trainer's last word, so the cancelled run's not
      // carrying it is the kill and not a log nothing writes.
      expect((await getTrainingProgress(finishedRun.id)).log_tail).toContain('stub trainer: epoch 3/3 done')
      expect(progress.log_tail).not.toContain('stub trainer: epoch 3/3 done')
      await expect.poll(async () => (await backendFetch('/api/queue')).gpu.running, { timeout: 30_000 })
        .toBeNull()

      // Finished now, so Cancel is gone from its row; the run that finished on its own
      // carries the buttons a finished row has, so an empty row could not pass this.
      await expect(row).toContainText('cancelled')
      await row.getByTestId('run-actions').click()
      await expect(row.getByTestId('rerun-training')).toBeVisible()
      await expect(cancel).toHaveCount(0)
      await page.keyboard.press('Escape')
      const finished = page.getByTestId('training-row').filter({ hasText: finishedName })
      await finished.getByTestId('run-actions').click()
      await expect(finished.getByTestId('rerun-training')).toBeVisible()
      await expect(finished.getByTestId('delete-training')).toBeVisible()
    })
})

test.describe('Scenario: a cluster submit while the cluster is out of reach', () => {
  // README: a cluster submit "asks whether the session is still open ... before the snapshot
  // is cut, because a closed one cannot be recovered from there and the cut would be thrown
  // away", and "what comes back then names the session, or the host that could not be
  // reached"; a cluster run defaults "to a size measured for the card it asked for - 76 on
  // an H200, 50 on an RTX PRO 6000"; and when the connection is lost "the run says so and
  // offers a reconnect". compose.e2e.yml names a cluster that can never be reached, and the
  // stub backend declares 32 on an H200 and 16 on an RTX PRO 6000.
  test('it fails before the snapshot, names the host it could not reach, keeps the per-card batch and offers Retry',
    async ({ page, browser }) => {
      // The probe is one ssh to a host that is never reached. Where the name does not
      // resolve it gives up at once; where a wildcard resolves it and the port is
      // black-holed, ssh gives up at its 15 s connect timeout - so the poll allows for that
      // rather than for the fast case alone, and both submits probe side by side.
      test.setTimeout(120_000)
      const jobId = await seedCheckedDataset('Cluster bound')
      const dev = identity('dev', 'admin')
      const h200Name = uniqueName('Cluster h200')
      const rtxName = uniqueName('Cluster rtx')
      await createTraining({ task: 'ocr', name: h200Name, dataset_job_ids: [jobId], target: 'slurm',
                           gpu_type: 'h200', gpu_count: 1 }, dev)
      await createTraining({ task: 'ocr', name: rtxName, dataset_job_ids: [jobId], target: 'slurm',
                           gpu_type: 'rtx6000bb', gpu_count: 2 }, dev)
      for (const name of [h200Name, rtxName]) {
        await expect.poll(async () => (await runNamed(name))?.status, { timeout: 60_000 }).toBe('error')
      }
      // No snapshot was cut, the batch is the one measured for the card asked for, and the
      // error is the sentence trainer.probe_cluster gives for a host it never reached, raised
      // before the cut.
      expect(await runNamed(h200Name)).toMatchObject({
        snapshot_counts: null, batch_size: 32, gpu_type: 'h200', gpu_count: 1, error: expect.stringMatching(CLUSTER_UNREACHABLE),
      })
      expect(await runNamed(rtxName)).toMatchObject({
        snapshot_counts: null, batch_size: 16, gpu_type: 'rtx6000bb', gpu_count: 2, error: expect.stringMatching(CLUSTER_UNREACHABLE),
      })
      // The failed probe is what reports the cluster lost to whoever may act on it.
      expect((await trainingsFor(dev)).cluster).toEqual({ reachable: false })

      // The form's summary names the batch the backend recorded for each card, not "auto".
      await page.goto('/models/train?task=ocr')
      await page.getByRole('radio', { name: 'Cluster (SLURM)' }).check()
      await page.getByTestId('advanced-toggle').click()
      const summary = page.getByTestId('submit-summary')
      for (const [card, recorded] of [['h200', 32], ['rtx6000bb', 16]] as const) {
        await page.getByLabel('GPU type').selectOption(card)
        await expect(summary).toContainText(`batch ${recorded} ·`)
        await expect(page.getByLabel('Batch size')).toHaveAttribute('placeholder', String(recorded))
      }
      await expect(summary).not.toContainText('batch auto')

      await page.goto('/models?tab=runs')
      const banner = page.getByTestId('cluster-lost')
      await expect(banner).toContainText('cluster session lost')
      await expect(banner.getByRole('button', { name: 'Reconnect' })).toBeVisible()
      const row = page.getByTestId('training-row').filter({ hasText: h200Name })
      await expect(row).toContainText('error')
      await expect(row).toContainText('check the host and the network, then retry')
      // The long error is cut at its column with the whole of it on hover, rather than
      // widening the table past the page.
      const table = page.getByRole('table', { name: 'Training runs' })
      expect(await table.evaluate((t) => t.scrollWidth <= t.parentElement!.clientWidth)).toBe(true)
      const error = row.locator('[data-col="result"] span[title]').first()
      await expect(error).toHaveAttribute('title', /check the host and the network, then retry$/)
      expect(await error.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true)
      await row.getByTestId('run-actions').click()
      await expect(row.getByTestId('retry-training')).toBeVisible()
      await page.keyboard.press('Escape')

      // A member granted the cluster is told the state too - a refused submit has to explain
      // itself - but opening the session takes the admin's second factor, so no Reconnect.
      const username = `cluster-watcher-${Date.now()}`
      const context = await browser.newContext()
      await useSession(context, seedSession('member', username))
      const memberPage = await context.newPage()
      const memberView = async () => (await memberPage.request.get('/api/trainings')).json()
      // Before the grant the cluster is none of theirs, and nothing about it is reported.
      await expect.poll(memberView).toMatchObject({ targets: { slurm: false }, cluster: null })

      await page.goto('/admin')
      // Controlled checkbox: it flips once the PATCH answers, so click and wait on the grant
      // arriving at the backend through nginx and /validate.
      await page.getByTestId('user-row').filter({ hasText: username }).getByTestId('train-cluster').click()
      await expect.poll(memberView).toMatchObject({ targets: { slurm: true }, cluster: { reachable: false } })

      await memberPage.goto('/models?tab=runs')
      const memberBanner = memberPage.getByTestId('cluster-lost')
      await expect(memberBanner).toContainText('cluster session lost')
      await expect(memberBanner.getByRole('button', { name: 'Reconnect' })).toHaveCount(0)
      // The failed run is everyone's to see and the owner's to retry.
      const memberRow = memberPage.getByTestId('training-row').filter({ hasText: h200Name })
      await expect(memberRow).toContainText('error')
      // Theirs to rerun as a new run, not to retry.
      await memberRow.getByTestId('run-actions').click()
      await expect(memberRow.getByTestId('rerun-training')).toBeVisible()
      await expect(memberRow.getByTestId('retry-training')).toHaveCount(0)
      await context.close()
    })
})

test.describe("Scenario: rerunning somebody else's run", () => {
  // README: "What cannot be carried over is named on the form: datasets the new submitter
  // cannot open, a base model that is gone, a knob the trainer no longer offers".
  test('Rerun names the datasets the new submitter cannot open, and takes them once shared',
    async ({ browser }) => {
      const datasetId = await seedCheckedDataset('Private source')
      const sourceName = uniqueName('Private run')
      const source = await trainToDone(sourceName, datasetId)

      const username = `rerunner-${Date.now()}`
      const context = await browser.newContext()
      await useSession(context, seedSession('member', username))
      const memberPage = await context.newPage()
      // Backend oracle for the premise: the dataset is served to the admin and not to them.
      expect((await listJobs()).some((j) => j.id === datasetId)).toBe(true)
      expect((await listJobs(identity(username, 'member'))).some((j) => j.id === datasetId)).toBe(false)

      await memberPage.goto(`/models/train?task=ocr&from=${source.id}`)
      await expect(memberPage.getByRole('heading', { name: `Rerun ${sourceName}` })).toBeVisible()
      await expect(memberPage.getByTestId('rerun-notes'))
        .toContainText('1 of its 1 datasets are not yours to open')
      await expect(memberPage.getByText('0 checked lines selected')).toBeVisible()
      await expect(memberPage.getByRole('button', { name: 'Next', exact: true })).toBeDisabled()

      // Shared, the same page carries the dataset over and has nothing left to name.
      await shareJob(datasetId, [username])
      await expect.poll(async () => (await listJobs(identity(username, 'member'))).some((j) => j.id === datasetId))
        .toBe(true)
      await memberPage.reload()
      await expect(memberPage.getByText('6 checked lines selected')).toBeVisible()
      await expect(memberPage.getByTestId('rerun-notes')).toHaveCount(0)
      await expect(memberPage.getByRole('button', { name: 'Next', exact: true })).toBeEnabled()
      await context.close()
    })
})

test.describe('Scenario: renaming a model', () => {
  // README: a name "is refused while another run is still training under it ... and stays
  // taken by an archived model, which is retired from the pickers but still on record under
  // it. Renaming a model is held to the same rule."
  test('renaming a model to a taken name is refused and the page says so', async ({ page }) => {
    const jobId = await seedCheckedDataset('Rename source')
    const keptName = uniqueName('Kept reader')
    const retiredName = uniqueName('Retired reader')
    const kept = await trainToDone(keptName, jobId)
    const retired = await trainToDone(retiredName, jobId)
    await patchModel(retired.model_id!, { archived: true })
    // Retired from the live registry, still on record - which is what keeps its name taken.
    expect(await modelNamed(retiredName)).toBeUndefined()
    expect(await modelNamed(retiredName, true)).toMatchObject({ id: retired.model_id })

    await page.goto(`/models/${kept.model_id}`)
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    const nameField = page.getByLabel('Name', { exact: true })
    await expect(nameField).toHaveValue(keptName)
    await nameField.fill(retiredName)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    // The registry's own sentence (registry.name_clash), shown whole.
    const modelTaken = `a ocr model named "${retiredName}" already exists`
    await expect(page.getByText(modelTaken, { exact: true })).toBeVisible()
    // Backend oracle: the refusal left the name alone, and the API gives the same 409 directly.
    expect((await listRegistryModels()).find((m) => m.id === kept.model_id)!.name).toBe(keptName)
    await expect(patchModel(kept.model_id!, { name: retiredName }))
      .rejects.toThrow(refusal(409, modelTaken))

    // A run still training under a name holds it too. This one sleeps on the GPU, so the
    // rename arrives while it is unfinished.
    const queuedName = `${uniqueName('Queued reader')} [slow]`
    await createTraining({ ...LOCAL_RUN, name: queuedName, dataset_job_ids: [jobId] })
    await nameField.fill(queuedName)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const runTaken = `a ocr training run named "${queuedName}" is already queued or running`
    await expect(page.getByText(runTaken, { exact: true })).toBeVisible()
    expect((await listRegistryModels()).find((m) => m.id === kept.model_id)!.name).toBe(keptName)
    await expect(patchModel(kept.model_id!, { name: queuedName }))
      .rejects.toThrow(refusal(409, runTaken))
    await stopRun(queuedName)
  })
})

test.describe('Scenario: what a viewer sees on the Models page', () => {
  // README: "Every model and every training run is visible to everyone, under the name of
  // whoever started it, and the page says so: cancelling, retrying, deleting or editing one
  // belongs to its owner or an admin, so a button that would be refused is not offered at all."
  test('a viewer sees every run and model but no action at all', async ({ page, browser }) => {
    test.setTimeout(120_000)
    const jobId = await seedCheckedDataset('Viewer source')
    // Started first and waited for last: the admin's Retry needs a failed run, the one way
    // to fail one in this stack is a cluster submit, and its probe takes as long as ssh
    // takes to give up on a host that is never reached. It probes in the background, off
    // the GPU queue, while the rest of the scenario goes on.
    const failedName = uniqueName('Viewer cluster')
    await createTraining({ task: 'ocr', name: failedName, dataset_job_ids: [jobId], target: 'slurm',
                         gpu_type: 'h200', gpu_count: 1 })
    const runName = uniqueName('Viewed run')
    const run = await trainToDone(runName, jobId)
    expect(await modelNamed(runName)).toMatchObject({ id: run.model_id })

    // Every way of acting on a run or a model, by the page it is offered on: the runs tab,
    // the stage tab, and the model's own page.
    const surfaces = (p: Page) => [
      { url: '/models?tab=runs', shown: p.getByTestId('training-row').filter({ hasText: runName }), actions: {
        'Actions menu': p.getByTestId('run-actions'),
      } },
      { url: '/models?tab=ocr', shown: p.getByTestId('model-family').first(), actions: {
        'Train model link': p.getByTestId('train-model'),
      } },
      { url: `/models/${run.model_id}`, shown: p.getByRole('heading', { level: 1, name: runName }), actions: {
        'Set default button': p.getByRole('button', { name: 'Set default', exact: true }),
        'Edit button': p.getByRole('button', { name: 'Edit', exact: true }),
        'Archive button': p.getByRole('button', { name: 'Archive', exact: true }),
        'Evaluate button': p.getByRole('button', { name: 'Evaluate…', exact: true }),
      } },
    ]

    const context = await browser.newContext()
    await useSession(context, seedSession('viewer', `viewer-${Date.now()}`))
    const viewerPage = await context.newPage()
    for (const { url, shown, actions } of surfaces(viewerPage)) {
      await viewerPage.goto(url)
      await expect(shown, url).toBeVisible()
      for (const [what, locator] of Object.entries(actions)) {
        await expect(locator, what).toHaveCount(0)
      }
    }
    await context.close()

    // Paired against the admin, who is offered every one of them: a finished run for Rerun
    // and Delete, a failed cluster submit for Retry, a run still on the GPU for Cancel, and
    // the registry's own buttons on the model page. The probe started at the top has had
    // the whole scenario to give up; the slow run goes on last, so it is still running.
    await expect.poll(async () => (await runNamed(failedName))?.status, { timeout: 60_000 }).toBe('error')
    const slowName = `${uniqueName('Viewer slow')} [slow]`
    await createTraining({ ...LOCAL_RUN, name: slowName, dataset_job_ids: [jobId] })
    await expect.poll(async () => (await runNamed(slowName))?.status, { timeout: 60_000 }).toBe('running')
    try {
      for (const { url, actions } of surfaces(page)) {
        await page.goto(url)
        // Cancel first: it is only offered while the slow run is on the GPU, and the stub
        // sleeps 15 s there - the other buttons are there for as long as the page is.
        for (const [what, locator] of Object.entries(actions)) {
          await expect(locator.first(), what).toBeVisible()
        }
      }
    } finally {
      await stopRun(slowName)
    }
  })
})
