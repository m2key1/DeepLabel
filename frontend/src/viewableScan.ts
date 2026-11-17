/** An object URL the browser can draw for a scan: the file itself where the browser shows
 *  it, else a copy decoded on the page - a TIFF, which Chrome and Firefox cannot show.
 *  Null when neither works. */
export async function viewableScan(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file)
  if (await draws(url)) return url
  URL.revokeObjectURL(url)
  try {
    return await decodedTiff(file)
  } catch {
    return null
  }
}

async function draws(url: string): Promise<boolean> {
  const image = new Image()
  image.src = url
  try {
    await image.decode()
    return true
  } catch {
    return false
  }
}

async function decodedTiff(file: File): Promise<string | null> {
  const { default: UTIF } = await import('utif')
  const buffer = await file.arrayBuffer()
  const [first] = UTIF.decode(buffer)
  UTIF.decodeImage(buffer, first)
  const canvas = document.createElement('canvas')
  canvas.width = first.width
  canvas.height = first.height
  const rgba = UTIF.toRGBA8(first)
  canvas.getContext('2d')!.putImageData(
    new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), first.width, first.height), 0, 0)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
  return blob && URL.createObjectURL(blob)
}
