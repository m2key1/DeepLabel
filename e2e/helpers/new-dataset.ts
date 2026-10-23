import type { Page } from '@playwright/test'

/** A new dataset starts without layout detection, finding its lines across the whole page
 * . A scenario whose data comes from lines found inside layout boxes asks
 *  for both on the New dataset form. */
export async function withLayoutPerCrop(page: Page) {
  await page.getByRole('checkbox', { name: /^Layout detection/ }).check()
  await page.getByRole('button', { name: /^Per crop/ }).click()
}
