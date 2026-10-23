import { execSync } from 'node:child_process'
import { test, expect } from '../helpers/test'
import { getJob, listJobs, uniqueName } from '../helpers/api'

/** Builds a folder in the backend container, where a server path is read: a volume, the
 *  leftovers a Mac and a Synology NAS leave beside it, and a link to a second volume. */
function writeLinkedFolder(dir: string): void {
  const script = [
    'import pathlib',
    'from PIL import Image',
    `root = pathlib.Path('${dir}')`,
    `elsewhere = pathlib.Path('${dir}-elsewhere')`,
    '(root / "vol1").mkdir(parents=True)',
    'elsewhere.mkdir(parents=True)',
    'Image.new("L", (600, 800), 60).save(root / "vol1" / "001.png")',
    'Image.new("L", (600, 800), 90).save(elsewhere / "002.png")',
    '(root / "vol1" / "._001.png").write_bytes(b"\\x00\\x05\\x16\\x07AppleDouble")',
    '(root / "@eaDir" / "001.png").mkdir(parents=True)',
    'Image.new("L", (60, 80), 120).save(root / "@eaDir" / "001.png" / "SYNOPHOTO_THUMB_M.png")',
    '(root / "vol2").symlink_to(elsewhere, target_is_directory=True)',
  ].join('\n')
  execSync('docker compose -f ../compose.e2e.yml exec -T backend python -', { input: script })
}

const jobNamed = async (name: string) => (await listJobs()).find((job) => job.name === name)

test.describe('Scenario: a server folder with links and NAS leftovers', () => {
  test('the form names the link it did not follow, and only the real scan is a page', async ({ page }) => {
    const dir = `/data/e2e-fixtures/${Date.now()}-links`
    writeLinkedFolder(dir)
    const name = uniqueName('Linked volumes')

    await page.goto('/new')
    await page.getByLabel('Job name').fill(name)
    await page.getByRole('button', { name: 'Server path' }).click()
    await page.getByLabel('Server directory (absolute path)').fill(dir)
    await expect(page.getByRole('button', { name: 'Create job' })).toBeEnabled()
    await expect(page.getByTestId('skipped-symlinks')).toHaveCount(0)
    await page.getByRole('button', { name: 'Create job' }).click()

    const notice = page.getByTestId('skipped-symlinks')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('One symbolic link was not read')
    await expect(notice.getByRole('listitem')).toHaveText(['vol2'])
    await expect(page).toHaveURL(/\/new$/)

    await expect.poll(async () => (await jobNamed(name))?.id ?? null).not.toBeNull()
    const jobId = (await jobNamed(name))!.id
    const job = await getJob(jobId)
    expect(job.pages.map((p: { filename: string }) => p.filename)).toEqual(['001.png'])
    expect(job.source_path).toBe(dir)

    await page.getByRole('button', { name: 'Open the dataset' }).click()
    await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}$`))
    await expect(page.getByRole('heading', { name })).toBeVisible()
  })

  test('a relative path is refused with the reason and makes nothing', async ({ page }) => {
    const name = uniqueName('Relative path')

    await page.goto('/new')
    await page.getByLabel('Job name').fill(name)
    await page.getByRole('button', { name: 'Server path' }).click()
    await page.getByLabel('Server directory (absolute path)').fill('data/scans')
    await page.getByRole('button', { name: 'Create job' }).click()

    await expect(page.getByText('the server path must be absolute: data/scans')).toBeVisible()
    await expect(page).toHaveURL(/\/new$/)
    expect((await listJobs()).map((job) => job.name)).not.toContain(name)
  })
})
