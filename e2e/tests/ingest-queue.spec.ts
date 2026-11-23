import { test, expect } from '../helpers/test'
import { backendFetch, getJob, uniqueName, waitForJobStatus } from '../helpers/api'
import { textPdf } from '../helpers/pdf'

const PAGES = 40

test.describe('Scenario: a large upload is ingested beside the GPU queue', () => {
  test('a new dataset shows as ingesting while its pages are rendered, then runs (#140)', async ({ page }) => {
    test.setTimeout(180_000)
    const name = uniqueName('Ingested first')
    const form = new FormData()
    form.append('name', name)
    for (const phase of ['run_layout', 'run_lines', 'run_ocr']) form.append(phase, 'false')
    form.append('files', new Blob([new Uint8Array(textPdf(Array.from({ length: PAGES }, (_, i) => [`Seite ${i + 1}`])))],
                                  { type: 'application/pdf' }), 'volume.pdf')
    const { job_id: jobId } = await backendFetch('/api/jobs', { method: 'POST', body: form })

    // The ingester has it, not the GPU queue: the ingest step counts its pages as they come.
    expect((await getJob(jobId)).status).toBe('ingesting')
    await expect.poll(async () => { const job = await getJob(jobId); return [job.status, job.phase] }, { intervals: [200] })
      .toEqual(['ingesting', 'ingest'])
    const queue = await backendFetch('/api/queue') as { gpu: { queued: { kind: string; id: string }[] } }
    expect(queue.gpu.queued.some((entry) => entry.kind === 'dataset' && entry.id === jobId)).toBe(false)
    // On the list it says so; on its own page the running Ingest step does.
    await page.goto('/')
    const card = page.getByTestId('job-card').filter({ hasText: name })
    await expect(card.getByTestId('status-badge')).toHaveText('Ingesting')
    await page.goto(`/jobs/${jobId}`)
    const ingest = page.getByTestId('phase-strip').locator('[data-phase="ingest"]')
    await expect(page.getByTestId('phase-strip')).toHaveAttribute('data-status', 'ingesting')
    await expect(ingest).toHaveAttribute('data-state', 'running')

    await waitForJobStatus(jobId, 'done', 150_000)
    await expect(page.getByTestId('phase-strip')).toHaveAttribute('data-status', 'done')
    await expect(ingest).toHaveAttribute('data-state', 'done')
    await expect(ingest).toContainText(`${PAGES}/${PAGES}`)
  })
})
