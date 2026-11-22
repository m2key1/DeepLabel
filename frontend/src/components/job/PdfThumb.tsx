import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

// Wide enough for a tile on a sharp screen; a volume of hundreds of pages is drawn a few at a time.
const THUMB_WIDTH = 272

/** One page of a PDF opened in the browser, drawn once it scrolls into view. */
export function PdfThumb({ doc, page }: { doc: PDFDocumentProxy; page: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [seen, setSeen] = useState(false)
  const [drawn, setDrawn] = useState(false)

  useEffect(() => {
    const target = canvas.current
    if (!target || seen) return
    const watcher = new IntersectionObserver(([entry]) => entry.isIntersecting && setSeen(true), { rootMargin: '200px' })
    watcher.observe(target)
    return () => watcher.disconnect()
  }, [seen])

  useEffect(() => {
    if (!seen || !canvas.current) return
    const target = canvas.current
    let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null
    let live = true
    doc.getPage(page).then((proxy) => {
      if (!live) return
      const viewport = proxy.getViewport({ scale: THUMB_WIDTH / proxy.getViewport({ scale: 1 }).width })
      target.width = Math.round(viewport.width)
      target.height = Math.round(viewport.height)
      task = proxy.render({ canvas: target, viewport })
      return task.promise.then(() => live && setDrawn(true))
    }).catch(() => undefined)
    return () => {
      live = false
      task?.cancel()
    }
  }, [seen, doc, page])

  return (
    <canvas ref={canvas} data-rendered={drawn} aria-hidden="true"
            className="h-32 w-full rounded-sm bg-raised object-contain" />
  )
}
