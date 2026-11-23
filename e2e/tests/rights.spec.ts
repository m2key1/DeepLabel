import { expect, test } from '../helpers/test'
import { backendFetch, seedCompletedJob, uniqueName } from '../helpers/api'
import { scanPng } from '../helpers/image'

const CC_BY_SA = 'http://creativecommons.org/licenses/by-sa/4.0/'
const IN_COPYRIGHT_EDU = 'http://rightsstatements.org/vocab/InC-EDU/1.0/'

type Rights = { status: string | null; credit: string; transcription_licence: string | null
                history: { field: string; new: string | null; author: string }[] }
const rightsOf = async (jobId: string): Promise<Rights> => backendFetch(`/api/jobs/${jobId}/rights`)

test.describe('Scenario: rights and licences', () => {
  test('a new dataset is asked the licence of its transcriptions, with none chosen for it', async ({ page }) => {
    const name = uniqueName('Licensed')
    await page.goto('/new')
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles({ name: 'folio.png', mimeType: 'image/png', buffer: scanPng() })
    const form = page.getByTestId('new-job-step')
    for (let left = 5; left > 0 && (await form.getAttribute('data-step')) !== 'review'; left--) {
      await page.getByTestId('wizard-next').click()
    }
    await expect(form).toHaveAttribute('data-step', 'review')

    const licence = page.getByTestId('new-job-licence-select')
    await expect(licence).toHaveValue('')
    await expect(page.getByTestId('wizard-missing')).toHaveText('Choose a licence for the transcriptions')
    await expect(page.getByRole('button', { name: 'Create job' })).toBeDisabled()

    await licence.selectOption({ label: 'CC BY-SA 4.0' })
    await expect(page.getByTestId('wizard-missing')).toHaveCount(0)
    await page.getByRole('button', { name: 'Create job' }).click()
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!

    const made = await rightsOf(jobId)
    expect([made.status, made.transcription_licence]).toEqual([null, CC_BY_SA])
    expect(made.history.map((h) => [h.field, h.new])).toEqual([['transcription_licence', CC_BY_SA]])
  })

  test("a dataset's rights are set from its title, and every change is kept", async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Rights'), 1)
    await page.goto(`/jobs/${jobId}`)
    const chip = page.getByTestId('job-rights')
    await expect(chip).toHaveText('Rights not evaluated')

    await chip.click()
    const dialog = page.getByTestId('rights-dialog')
    await dialog.getByTestId('rights-status').selectOption({ label: 'In Copyright - Educational Use Permitted' })
    await dialog.getByTestId('rights-credit').fill('Stadtarchiv Eferding')
    await page.getByTestId('rights-save').click()

    await expect.poll(async () => {
      const held = await rightsOf(jobId)
      return [held.status, held.credit, held.history.map((h) => h.field).sort()]
    }).toEqual([IN_COPYRIGHT_EDU, 'Stadtarchiv Eferding', ['credit', 'status']])
    await expect(dialog.getByTestId('rights-change')).toHaveCount(2)
    await expect(dialog.locator('[data-testid="rights-change"][data-field="status"]'))
      .toContainText('Rights: - to In Copyright - Educational Use Permitted')
    await page.getByRole('button', { name: 'Close' }).click()
    await expect(chip).toHaveText('In Copyright - Educational Use Permitted')
    // From the dataset itself, not only from what the dialog said.
    await page.reload()
    await expect(chip).toHaveText('In Copyright - Educational Use Permitted')
  })
})
