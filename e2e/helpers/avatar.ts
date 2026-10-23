import type { Page } from '@playwright/test'

/** Where someone's picture is, as everything that draws a person asks for it. */
export async function avatarUrl(page: Page, username: string): Promise<string | null> {
  const res = await page.request.get('/api/users/names')
  const users = (await res.json()).users as { username: string; avatar: string | null }[]
  return users.find((u) => u.username === username)!.avatar
}

export type Colour = 'red' | 'blue' | 'other'

/** The colour of a served picture at its corners and its centre, read back in the
 *  browser that would draw it. */
export async function pictureColours(page: Page, url: string): Promise<{ size: number[]; colours: Colour[] }> {
  const read = await page.evaluate(async (src) => {
    const img = new Image()
    img.src = src
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const at = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3))
    const [w, h] = [canvas.width, canvas.height]
    return { size: [w, h], pixels: [at(2, 2), at(w - 3, 2), at(2, h - 3), at(w - 3, h - 3), at(w >> 1, h >> 1)] }
  }, url)
  const name = ([r, g, b]: number[]): Colour =>
    r > 230 && g < 25 && b < 25 ? 'red' : b > 230 && r < 25 && g < 25 ? 'blue' : 'other'
  return { size: read.size, colours: read.pixels.map(name) }
}
