import { test, expect } from '../helpers/test'
import { jobPageIds, seedCompletedJob, uniqueName } from '../helpers/api'
import { LANDSCAPE, openViewer, scanRect } from '../helpers/viewer'

/** Every point a test clicks or drags on the scan is measured against where the scan is
 *  drawn. The scan is re-fitted a frame or two after its pane changes size - entering edit
 *  mode adds the tool rail - so one frame without a move does not mean it has arrived. */
test.describe('Scenario: measuring where the scan is', () => {
  test('a scan that pauses on its way is measured where it stops', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Measured'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)
    const settled = await scanRect(page)

    // 40 px to the right, held there for four frames, then on to 80 px.
    await page.getByTestId('overlay-box').evaluate((el) => {
      const steps = [40, 40, 40, 40, 80]
      const step = () => {
        el.style.translate = `${steps.shift()}px 0`
        if (steps.length) requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })
    expect((await scanRect(page)).left).toBe(settled.left + 80)
  })
})
