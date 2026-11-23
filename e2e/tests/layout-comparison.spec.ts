import { execSync } from 'node:child_process'
import { expect, test } from '../helpers/test'
import {
  backendFetch, createTraining, jobPageIds, listRegistryModels, listTrainings, markLayoutChecked, seedDistinctPagesJob,
  uniqueName,
} from '../helpers/api'

// The stub layout model finds a Header and a Paragraph on every page, the base model and a
// run trained from it alike. A second checked Paragraph that neither finds caps that class's
// recall at a half: AP 51/101 at every IoU, Header 1, and their mean 75.2%.
const UNFOUND_PARAGRAPH = [0.1, 0.87, 0.9, 0.97]
const SCORES = { all: '75.2', Header: '100.0', Paragraph: '50.5' }

type Scored = { id: number; model_id: number; training_id: number | null; status: string
                source: { split?: string }; metrics: { mAP_50: number; pages: number; truth: number } | null }

const comparisonOf = async (trainingId: number): Promise<Scored[]> =>
  ((await backendFetch('/api/evaluations')).evaluations as Scored[]).filter((ev) => ev.training_id === trainingId)

/** A run as one that finished before runs were compared: its comparison never made. */
function forgetComparison(trainingId: number) {
  const script = 'from app import config, store; conn = store.connect(config.DB_PATH); '
    + `conn.execute(\\"DELETE FROM evaluations WHERE training_id = ${trainingId}\\"); conn.commit()`
  execSync(`docker compose -f ../compose.e2e.yml exec -T backend python -c "${script}"`)
}

test.describe('Scenario: a layout run set beside its base model', () => {
  // A real run on the stub trainer, then both models reading its pages.
  test.describe.configure({ timeout: 180_000 })
  test('both models are scored on the validation pages at the end, then shown page by page', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Compared layout'), 4, 300)
    for (const pageId of await jobPageIds(jobId)) {
      await backendFetch(`/api/pages/${pageId}/elements`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ class_name: 'Paragraph', bbox: UNFOUND_PARAGRAPH }),
      })
      await markLayoutChecked(pageId)
    }
    const base = (await listRegistryModels()).find((m) => m.task === 'layout' && m.is_default)!
    const created = await createTraining({
      task: 'layout', name: uniqueName('Compared run'), target: 'local', epochs: 1, val_fraction: 0.5,
      dataset_job_ids: [jobId], base_model_id: base.id,
    })

    await expect.poll(async () => (await comparisonOf(created.id)).map((ev) => [ev.status, ev.source.split]),
                      { timeout: 120_000 }).toEqual([['done', 'valid'], ['done', 'valid']])
    const run = (await listTrainings()).find((t) => t.id === created.id)!
    const byModel = new Map((await comparisonOf(created.id)).map((ev) => [ev.model_id, ev.metrics!]))
    expect([...byModel.keys()].sort()).toEqual([base.id, run.model_id].sort())
    for (const metrics of byModel.values()) {
      expect([metrics.mAP_50, metrics.pages, metrics.truth]).toEqual([(1 + 51 / 101) / 2, 2, 6])
    }

    await page.goto(`/models/runs/${created.id}`)
    const comparison = page.getByTestId('layout-comparison')
    for (const [name, score] of Object.entries(SCORES)) {
      const row = comparison.locator(`[data-testid="layout-comparison-row"][data-class="${name}"]`)
      for (const at of ['base-50', 'trained-50', 'base-50-95', 'trained-50-95']) {
        await expect(row.locator(`[data-score="${at}"]`)).toHaveText(score)
      }
    }
    await expect(comparison.getByTestId('layout-comparison-row')).toHaveCount(3)
    // The same model twice, so no change is marked.
    await expect(comparison.getByTestId('score-change')).toHaveCount(0)

    const pages = comparison.getByTestId('layout-compared-pages')
    await expect(pages.getByTestId('compared-page-at')).toHaveText('page 1 of 2')
    await expect(pages.getByTestId('compared-page-truth')).toHaveAttribute('data-boxes', '3')
    await expect(pages.getByTestId('compared-page-base')).toHaveAttribute('data-boxes', '2')
    await expect(pages.getByTestId('compared-page-trained')).toHaveAttribute('data-boxes', '2')
    await expect(pages.getByTestId('compared-page-base')).toContainText(`${base.name}AP50 75.2`)
    await pages.getByTestId('compared-page-next').click()
    await expect(pages.getByTestId('compared-page-at')).toHaveText('page 2 of 2')
    await expect(pages.getByTestId('compared-page-truth')).toHaveAttribute('data-boxes', '3')
  })

  test('a run that finished before is compared on request', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Compared later'), 4, 310)
    for (const pageId of await jobPageIds(jobId)) await markLayoutChecked(pageId)
    const base = (await listRegistryModels()).find((m) => m.task === 'layout' && m.is_default)!
    const created = await createTraining({
      task: 'layout', name: uniqueName('Compared later run'), target: 'local', epochs: 1, val_fraction: 0.5,
      dataset_job_ids: [jobId], base_model_id: base.id,
    })
    await expect.poll(async () => (await comparisonOf(created.id)).map((ev) => ev.status), { timeout: 120_000 })
      .toEqual(['done', 'done'])
    forgetComparison(created.id)
    expect(await comparisonOf(created.id)).toEqual([])

    await page.goto(`/models/runs/${created.id}`)
    const comparison = page.getByTestId('layout-comparison')
    await expect(comparison.getByTestId('layout-comparison-scores')).toHaveCount(0)
    await comparison.getByRole('button', { name: `Compare with ${base.name}` }).click()

    await expect.poll(async () => (await comparisonOf(created.id)).map((ev) => [ev.status, ev.metrics?.mAP_50]),
                      { timeout: 60_000 }).toEqual([['done', 1], ['done', 1]])
    await expect(comparison.locator('[data-class="all"] [data-score="trained-50"]')).toHaveText('100.0')
    await expect(comparison.getByRole('button', { name: `Compare with ${base.name}` })).toHaveCount(0)
  })
})
