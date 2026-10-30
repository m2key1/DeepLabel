import { expect, type Page } from '@playwright/test'
import { wizardStep, type WizardStep } from './new-dataset'

/** A dataset's settings: the New job steps filled in as it stands, opened from the ⋯ menu
 *  of its row on the dataset list. */
export async function openSettings(page: Page, name: string, step: WizardStep = 'run') {
  await page.goto(`/?q=${encodeURIComponent(name)}`)
  const card = page.getByTestId('job-card').filter({ hasText: name })
  await card.getByTestId('job-menu').click()
  await card.getByTestId('settings-open').click()
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}\/settings$/)
  await expect(page.getByTestId('new-job-step')).toHaveAttribute('data-step', 'run')
  if (step !== 'run') await wizardStep(page, step)
}

/** Saving happens on Review, after a look at everything chosen, and leads back to the dataset. */
export async function saveSettings(page: Page) {
  await wizardStep(page, 'review')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
}

/** A phase on the What to run step, by its key. */
export const phaseBox = (page: Page, phase: 'layout' | 'lines' | 'ocr') =>
  page.locator(`[data-testid="phase-choice"][data-phase="${phase}"]`).getByRole('checkbox')

export const lineModeOption = (page: Page, mode: 'per_crop' | 'per_page') =>
  page.locator(`[data-testid="line-mode-option"][data-mode="${mode}"]`)
