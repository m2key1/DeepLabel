import { useState } from 'react'
import { iiifThumbnailUrl, inspectIiif } from '../../api'
import type { IiifInspection } from '../../api'

export type IiifManifest = Extract<IiifInspection, { kind: 'manifest' }>
type IiifCollection = Extract<IiifInspection, { kind: 'collection' }>

export interface IiifChoice {
  url: string
  collection: IiifCollection | null
  manifest: IiifManifest | null
}

export const NO_IIIF: IiifChoice = { url: '', collection: null, manifest: null }

/** The IIIF source of a new dataset: a manifest or collection address, read by the
 *  backend, then the manifest's facts or the collection's members to choose from. */
export function IiifSource({ value, onChange }: {
  value: IiifChoice
  onChange: (next: IiifChoice) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (url: string, collection = value.collection) => {
    setBusy(true)
    setError(null)
    try {
      const found = await inspectIiif(url)
      onChange(found.kind === 'manifest'
        ? { url, collection, manifest: found }
        : { url, collection: found, manifest: null })
    } catch (err) {
      setError((err as Error).message)
      onChange({ ...value, url, manifest: null })
    } finally {
      setBusy(false)
    }
  }

  const manifest = value.manifest
  return (
    <div data-testid="iiif-source">
      <label htmlFor="iiif-url" className="mb-1 block text-sm font-medium text-ink">IIIF manifest or collection URL</label>
      <div className="flex gap-2">
        <input id="iiif-url" value={value.url} placeholder="https://.../manifest.json"
               onChange={(e) => onChange({ ...value, url: e.target.value })}
               onKeyDown={(e) => {
                 if (e.key === 'Enter') {
                   e.preventDefault()
                   if (value.url.trim()) load(value.url.trim(), null)
                 }
               }}
               className="w-full rounded border border-line-strong bg-surface px-2 py-1.5 font-mono text-sm focus-visible:border-accent focus:outline-none" />
        <button type="button" data-testid="iiif-load" disabled={busy || !value.url.trim()}
                onClick={() => load(value.url.trim(), null)}
                className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          {busy ? 'Loading…' : 'Load'}
        </button>
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        Presentation API 2 or 3, or a collection of manifests. The pages are downloaded from the
        archive&rsquo;s image server when the dataset starts.
      </p>
      {error && <p data-testid="iiif-error" role="alert" className="mt-2 text-sm text-danger">{error}</p>}

      {value.collection && (
        <div className="mt-3">
          <p className="text-xs text-ink-muted">
            {value.collection.label || 'This collection'} holds {value.collection.members.length} item
            {value.collection.members.length === 1 ? '' : 's'} - choose one:
          </p>
          <ul data-testid="iiif-members" className="mt-1.5 max-h-64 overflow-y-auto rounded-md border border-line bg-surface">
            {value.collection.members.map((member) => (
              <li key={member.url} className="border-b border-line last:border-0">
                <button type="button" data-testid="iiif-member" data-selected={manifest?.url === member.url}
                        onClick={() => load(member.url, member.kind === 'collection' ? null : value.collection)}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                          manifest?.url === member.url ? 'bg-accent-wash text-accent-ink' : 'text-ink hover:bg-raised'}`}>
                  <span className="font-medium">{member.label || member.url}</span>
                  {member.kind === 'collection' && <span className="text-xs text-ink-muted">collection</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {manifest && (
        <div data-testid="iiif-manifest" className="mt-3 flex gap-3.5 rounded-md border border-line bg-surface p-3">
          <img src={iiifThumbnailUrl(manifest.canvases[0].thumbnail)} alt=""
               className="h-28 w-20 shrink-0 rounded-sm bg-raised object-contain" />
          <div className="min-w-0 flex-1">
            <p data-testid="iiif-label" className="font-semibold text-ink">{manifest.label || 'Untitled manifest'}</p>
            <dl className="mt-1 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 text-sm">
              <dt className="text-ink-muted">Pages</dt>
              <dd data-testid="iiif-pages">{manifest.canvases.length}, IIIF Presentation {manifest.version}</dd>
              <dt className="text-ink-muted">Downloaded</dt>
              <dd>at most {manifest.max_width} px wide</dd>
              {manifest.attribution && (<>
                <dt className="text-ink-muted">Attribution</dt>
                <dd data-testid="iiif-attribution" className="break-words">{manifest.attribution}</dd>
              </>)}
              {manifest.rights && (<>
                <dt className="text-ink-muted">Rights</dt>
                <dd data-testid="iiif-rights" className="break-all">{manifest.rights}</dd>
              </>)}
            </dl>
            <p className="mt-1.5 text-xs text-ink-muted">
              {manifest.attribution || manifest.rights
                ? 'Attribution and rights are kept on the dataset and carried by every export.'
                : 'The manifest names no attribution or rights - check them with the archive.'}
            </p>
            {manifest.canvases.length > manifest.max_pages && (
              <p data-testid="iiif-too-many" className="mt-1.5 text-xs text-warn">
                One dataset takes at most {manifest.max_pages} pages - choose them on the next step.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
