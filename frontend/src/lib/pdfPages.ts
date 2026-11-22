import { useEffect, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

/** pdf.js and its worker, fetched the first time a PDF is opened and never before. */
let library: Promise<typeof import('pdfjs-dist')> | null = null

function pdfjs(): Promise<typeof import('pdfjs-dist')> {
  // Bundled as a worker of its own, so it is served as plain JavaScript, not as an .mjs file
  // a server may not know the type of.
  library ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?worker')])
    .then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerPort = new worker.default()
      return lib
    })
  return library
}

export type OpenedPdf = { doc: PDFDocumentProxy; pages: number } | 'opening' | 'unreadable'

/** Each PDF among `files` opened in the browser, to show and pick its pages before anything
 *  is uploaded. One the browser cannot read stays a single file, taken whole. */
export function useOpenedPdfs(files: File[]): Map<File, OpenedPdf> {
  const [opened, setOpened] = useState<Map<File, OpenedPdf>>(new Map())
  useEffect(() => {
    const tasks: { destroy: () => Promise<void> }[] = []
    let live = true
    setOpened(new Map(files.map((file) => [file, 'opening' as const])))
    for (const file of files) {
      pdfjs()
        .then(async (lib) => {
          const data = new Uint8Array(await file.arrayBuffer())
          // Nothing is opened for a list that has moved on while the file was being read.
          if (!live) return null
          const task = lib.getDocument({ data })
          tasks.push(task)
          return task.promise
        })
        .then((doc) => {
          if (doc && live) setOpened((held) => new Map(held).set(file, { doc, pages: doc.numPages }))
        })
        .catch(() => {
          if (live) setOpened((held) => new Map(held).set(file, 'unreadable'))
        })
    }
    return () => {
      live = false
      tasks.forEach((task) => void task.destroy())
    }
  }, [files])
  return opened
}
