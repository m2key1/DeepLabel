import { execSync } from 'node:child_process'
import { expect, type Page } from '@playwright/test'
import { backendFetch, identity } from './api'

const DEV = identity('dev', 'admin')

/** The picker row for one model, named by the connection that offers it: labels carry the
 *  connection's unique name, so two tests both offering 'stub-perfect' stay apart. */
export function pickModel(page: Page, connection: string, model: string) {
  return page.locator(`[data-testid="llm-pick"][data-label="${connection} ${model}"]`)
    .getByRole('checkbox')
}

/** Where a dataset's language-model run stands - readings done, failed, still in flight -
 *  over the whole dataset or over the pages named. */
export async function llmReadStatus(jobId: string, pageIds?: number[]) {
  const query = pageIds ? `?${pageIds.map((id) => `page_ids=${id}`).join('&')}` : ''
  return backendFetch(`/api/jobs/${jobId}/llm/status${query}`, { headers: DEV })
}

/** Until `expected` readings are done and nothing is in flight. Polled on the backend, not
 *  the page: a click resolves before the request it triggers is even sent, so asking the
 *  page whether the dataset is idle would answer "yes" about the moment before. */
export async function waitForLlmReads(jobId: string, expected: number) {
  await expect.poll(async () => {
    const status = await llmReadStatus(jobId)
    return { done: status.done, active: status.active }
  }, { timeout: 30_000 }).toEqual({ done: expected, active: false })
}

export interface GtReadRow {
  page_id: number
  status: string
  /** The model's answer as it came back, or null once a re-read has let go of it. */
  raw_text: string | null
}

/** A dataset's diplomatic readings as the queue keeps them, oldest page first. No route
 *  serves the raw answer, and a failed re-read leaves the page's ground truth alone, so
 *  whether the answer survived the failure can only be read off the row itself. */
export function gtReads(jobId: string): GtReadRow[] {
  const script = [
    'import json',
    'from app import config, store',
    'conn = store.connect(config.DB_PATH)',
    "rows = conn.execute('SELECT page_id, status, raw_text FROM gt_reads WHERE job_id = ? "
      + `ORDER BY page_id', (${JSON.stringify(jobId)},)).fetchall()`,
    'print(json.dumps([dict(row) for row in rows]))',
  ].join('\n')
  const out = execSync('docker compose -f ../compose.e2e.yml exec -T backend python -',
                       { input: script })
  return JSON.parse(out.toString())
}

export interface LlmReadOptions {
  /** How many readers must agree before a line is filled in. */
  minAgree?: number
  /** Check the settled lines off as well as filling them in. */
  autocheck?: boolean
  /** Count the local OCR model as one of the readers. */
  withOcr?: boolean
}

/** Opens a one-page dataset's read dialog, picks `models` on `connection`, starts the run
 *  and waits for one reading per model - which is what one page costs. */
export async function startLlmRead(
  page: Page, jobId: string, connection: string, models: string[], options: LlmReadOptions = {},
) {
  await page.goto(`/jobs/${jobId}`)
  await page.getByTestId('llm-read-open').click()
  for (const model of models) await pickModel(page, connection, model).check()
  if (options.minAgree !== undefined) {
    await page.getByTestId('llm-consensus-min').fill(String(options.minAgree))
  }
  if (options.autocheck) await page.getByTestId('llm-autocheck').check()
  if (options.withOcr) await page.getByTestId('llm-consensus-with-ocr').check()
  await page.getByTestId('llm-start').click()
  await waitForLlmReads(jobId, models.length)
}
