import { useState } from 'react'
import { canCopyImages, copyImageToClipboard } from '../lib/clipboard'

interface CopyImageButtonProps {
  /** The rendition to copy. Served as JPEG; the clipboard gets a PNG of it. */
  url: string
  onError: (message: string) => void
  className?: string
}

const CHROME =
  'rounded border border-line-strong bg-surface/90 px-1.5 py-0.5 text-[11px] font-medium '
  + 'text-ink-muted shadow-sm backdrop-blur hover:border-accent hover:text-accent-ink'

/** Copies a scan so it can be pasted straight into whatever else is being asked about it.
 *  Right-clicking the viewer offers no "Copy image" of its own - the scan sits under
 *  overlays - and the table's preview is not an image the browser will hand over either.
 *
 *  Writing an image needs a secure context, which an http:// host on a bare address is not,
 *  so on such a deployment there is no clipboard to write to at all. Rather than vanish
 *  there and look like a missing feature, this opens the scan on its own, where the
 *  browser's own "copy image" is one right-click away. */
export function CopyImageButton({ url, onError, className = '' }: CopyImageButtonProps) {
  const [copied, setCopied] = useState(false)
  if (!canCopyImages()) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        data-testid="open-image"
        onClick={(e) => e.stopPropagation()}
        title="This browser will only copy images over https - opens the scan on its own instead"
        className={`${CHROME} ${className}`}
      >
        Open
      </a>
    )
  }
  return (
    <button
      type="button"
      data-testid="copy-image"
      title="Copy this scan to the clipboard"
      aria-label="Copy the scan to the clipboard"
      onClick={async (e) => {
        e.stopPropagation()
        try {
          await copyImageToClipboard(url)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        } catch (err) {
          onError((err as Error).message)
        }
      }}
      className={`${CHROME} ${className}`}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}
