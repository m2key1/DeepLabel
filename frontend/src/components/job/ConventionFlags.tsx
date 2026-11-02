import type { ReactNode } from 'react'
import type { ConventionFlag, OcrConvention, RegistryModel } from '../../api'
import { conventionLabel } from '../conventionLabel'

export const flagsOn = (convention: OcrConvention) =>
  Object.keys(convention).filter((name) => convention[name]).sort()

/** The flags that may be picked: an admin can stop offering one, and it is then left out
 *  of every list, even where a dataset still has it stored. */
export const offeredFlags = (names: string[], catalog: ConventionFlag[] | null) =>
  names.filter((name) => catalog?.find((f) => f.name === name)?.offered !== false)

/** The convention with one flag switched, keeping only the flags that are on. */
export const toggledFlag = (convention: OcrConvention, name: string): OcrConvention =>
  Object.fromEntries(flagsOn({ ...convention, [name]: !convention[name] }).map((on) => [on, true]))

/** A dataset's transcription-convention switches: what the OCR model reads first, in its
 *  order; then every other flag there is, so a rule can be set on the dataset ahead of a
 *  model that reads it - marked as one this model ignores. */
export function ConventionFlags({ catalog, model, convention, onToggle, children }: {
  catalog: ConventionFlag[] | null
  model: RegistryModel | null | undefined
  convention: OcrConvention
  onToggle: (name: string) => void
  /** Below the list, such as what the dataset was last read with. */
  children?: ReactNode
}) {
  const modelFlags = model?.conventions ?? null
  const knownFlags = modelFlags && offeredFlags(modelFlags, catalog)
  const otherFlags = offeredFlags([...new Set([...(catalog ?? []).map((f) => f.name), ...flagsOn(convention)])], catalog)
    .filter((name) => !(modelFlags ?? []).includes(name))
  const description = (name: string) => catalog?.find((f) => f.name === name)?.description ?? ''

  return (
    <fieldset className="mb-4" data-testid="ocr-convention">
      <legend className="mb-1 flex w-full items-baseline text-sm font-medium text-ink">
        Transcription convention
        {/* A new tab, so what is picked here so far is not lost on the way. */}
        <a href="/conventions" target="_blank" rel="noreferrer" data-testid="conventions-link"
           className="ml-auto text-xs font-normal text-ink-subtle hover:text-accent-ink">
          What these mean
        </a>
      </legend>
      {knownFlags === null && (
        <p className="mb-1 text-xs text-ink-muted">
          This model's convention switches are known once it has read a page.
        </p>
      )}
      {knownFlags !== null && knownFlags.length === 0 && (
        <p className="mb-1 text-xs text-ink-muted">This model reads one convention only.</p>
      )}
      <div className="space-y-1">
        {[...(knownFlags ?? []), ...otherFlags].map((name) => {
          const supported = knownFlags === null || knownFlags.includes(name)
          return (
            <label key={name} data-testid="convention-flag" data-flag={name}
                   data-supported={supported}
                   className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!convention[name]}
                onChange={() => onToggle(name)}
                className="mt-1 cursor-pointer accent-accent"
              />
              <span className="min-w-0">
                <span className="block">{conventionLabel(name, catalog)}</span>
                {description(name) && (
                  <span data-testid="convention-description" className="block text-xs text-ink-muted">
                    {description(name)}
                  </span>
                )}
                {!supported && (
                  <span data-testid="convention-ignored" className="block text-xs text-warn">
                    {model?.name ?? 'This model'} ignores this
                  </span>
                )}
              </span>
            </label>
          )
        })}
      </div>
      {children}
    </fieldset>
  )
}
