/** Whether this browser can be handed an image at all. PNG is the one format the Clipboard
 *  API mandates, and Firefox could not write images before 126 - so the button that uses
 *  this is hidden rather than offered and then failing. */
export function canCopyImages(): boolean {
  return typeof ClipboardItem !== 'undefined'
    && typeof navigator.clipboard?.write === 'function'
    && (typeof ClipboardItem.supports !== 'function' || ClipboardItem.supports('image/png'))
}

function toPng(image: HTMLImageElement): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('this browser would not give a drawing context')
  context.drawImage(image, 0, 0)
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('the image would not encode'))),
                  'image/png'))
}

/** Put a rendition on the clipboard as a PNG, ready to paste into whatever the person is
 *  asking about it. Renditions are served as JPEG, which no clipboard takes, so the image
 *  is decoded and re-encoded here. Safari holds the caller's gesture only for as long as
 *  the promise handed to ClipboardItem, which is why the whole fetch sits inside one. */
export async function copyImageToClipboard(url: string): Promise<void> {
  const png = fetch(url, { credentials: 'same-origin' })
    .then(async (response) => {
      if (!response.ok) throw new Error(`the image could not be loaded (${response.status})`)
      const bitmap = new Image()
      bitmap.src = URL.createObjectURL(await response.blob())
      try {
        await bitmap.decode()
        return await toPng(bitmap)
      } finally {
        URL.revokeObjectURL(bitmap.src)
      }
    })
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}
