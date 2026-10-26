import type { Page } from '@playwright/test'

const IN_MORE = ['layout-classes', 'llm-settle-again', 'remove-readings', 'purge-open']

/** Opens the dataset page's Run menu, or its More menu, and returns its entries. */
export async function openDatasetMenu(page: Page, menu: 'dataset-run' | 'dataset-more') {
  await page.getByTestId(menu).click()
  return page.getByTestId(`${menu}-items`)
}

/** Picks one entry of the dataset page's Run or More menu, opening the menu first. */
export async function datasetAction(page: Page, testId: string) {
  const items = await openDatasetMenu(page, IN_MORE.includes(testId) ? 'dataset-more' : 'dataset-run')
  await items.getByTestId(testId).click()
}
