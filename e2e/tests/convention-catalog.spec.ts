import { test, expect } from '../helpers/test'
import { backendFetch, listRegistryModels, seedCompletedJob, setOcrConvention, uniqueName } from '../helpers/api'

interface Flag { name: string; label: string; description: string; models: number; datasets: number }

const catalogFlag = async (name: string): Promise<Flag | undefined> =>
  ((await backendFetch('/api/convention-flags')).flags as Flag[]).find((f) => f.name === name)

test.describe('Scenario: describing the transcription conventions', () => {
  test('an admin adds and describes a flag, and the model picker explains it', async ({ page }) => {
    // A flag of this test's own, so no other spec's flags or descriptions are in the way.
    const name = `rule_${Date.now()}`
    await page.goto('/models')
    await page.getByTestId('conventions-page').click()
    await expect(page).toHaveURL(/\/conventions$/)
    const catalog = page.getByTestId('convention-catalog')
    await expect(catalog).toBeVisible()

    await catalog.getByTestId('convention-add').click()
    await catalog.getByLabel('Flag name').fill(name)
    await catalog.getByLabel('Label').fill('Keep the double hyphen')
    await catalog.getByRole('button', { name: 'Save' }).click()
    await expect.poll(() => catalogFlag(name))
      .toMatchObject({ label: 'Keep the double hyphen', description: '', models: 0, datasets: 0 })
    const row = catalog.locator(`[data-testid="convention-row"][data-flag="${name}"]`)
    await expect(row).toContainText('not described yet')

    await row.getByTestId('convention-edit').click()
    await catalog.getByLabel('Description').fill('A word broken at the line end keeps its "=" as written.')
    await catalog.getByRole('button', { name: 'Save' }).click()
    await expect.poll(async () => (await catalogFlag(name))?.description)
      .toBe('A word broken at the line end keeps its "=" as written.')
    await expect(row).not.toContainText('not described yet')

    // A dataset asks for it, read by a model that does not know it.
    const datasetName = uniqueName('Described rule')
    const jobId = await seedCompletedJob(datasetName, 1)
    await setOcrConvention(jobId, { [name]: true })
    await expect.poll(async () => (await catalogFlag(name))?.datasets).toBe(1)
    const builtinOcr = (await listRegistryModels()).find((m) => m.task === 'ocr' && m.source === 'backend')!

    await page.goto(`/?q=${encodeURIComponent(datasetName)}`)
    const card = page.getByTestId('job-card').filter({ hasText: datasetName })
    await card.getByTestId('job-menu').click()
    await card.getByRole('button', { name: 'Models…' }).click()
    await page.getByTestId('model-pick-ocr').selectOption(String(builtinOcr.id))

    const flag = page.locator(`[data-testid="convention-flag"][data-flag="${name}"]`)
    await expect(flag).toContainText('Keep the double hyphen')
    await expect(flag.getByTestId('convention-description'))
      .toHaveText('A word broken at the line end keeps its "=" as written.')
    await expect(flag.getByTestId('convention-ignored')).toHaveText(`${builtinOcr.name} ignores this`)
    await expect(flag.getByRole('checkbox')).toBeChecked()
    // Paired with a flag the model does read, which carries no such mark.
    const longS = page.locator('[data-testid="convention-flag"][data-flag="long_s"]')
    await expect(longS).toHaveAttribute('data-supported', 'true')
    await expect(longS.getByTestId('convention-ignored')).toHaveCount(0)
    await expect(page.getByTestId('conventions-link')).toHaveAttribute('href', '/conventions')
  })
})
