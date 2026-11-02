import { expect, type Page } from '@playwright/test'

/** A new dataset starts without layout detection, finding its lines across the whole page
 * . A scenario whose data comes from lines found inside layout boxes asks
 *  for both on the New dataset form. */
export async function withLayoutPerCrop(page: Page) {
  await wizardStep(page, 'run')
  await page.getByRole('checkbox', { name: /^Layout detection/ }).check()
  await page.getByRole('button', { name: /^Per crop/ }).click()
  await wizardStep(page, 'source')
}

export type WizardStep = 'source' | 'pages' | 'run' | 'models' | 'review'

/** The New dataset form is a row of steps: one already reached is clicked, one ahead is
 *  walked to with Next, through the checks of every step on the way. */
export async function wizardStep(page: Page, step: WizardStep) {
  const target = page.getByTestId(`wizard-step-${step}`)
  const form = page.getByTestId('new-job-step')
  if (await target.isEnabled()) await target.click()
  for (let left = 5; left > 0 && (await form.getAttribute('data-step')) !== step; left--) {
    await page.getByTestId('wizard-next').click()
  }
  await expect(form).toHaveAttribute('data-step', step)
}

/** Creating happens on the last step, after a look at everything chosen. */
export async function createDataset(page: Page, button: 'Create job' | 'Import dataset' = 'Create job') {
  await wizardStep(page, 'review')
  await page.getByRole('button', { name: button }).click()
}
