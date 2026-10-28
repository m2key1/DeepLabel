import { useEffect, useState } from 'react'
import { getMeta, type AppMeta } from '../api'

const REPO = 'https://github.com/m2key1/DeepLabel'

const linkClass = 'hover:text-accent-ink hover:underline'

/** The release this deployment runs and where its source and docs live, so a bug report
 *  can say which version it is about and where to file it. */
export function AppFooter() {
  const [meta, setMeta] = useState<AppMeta | null>(null)
  useEffect(() => {
    getMeta().then(setMeta).catch(() => {})
  }, [])

  return (
    <footer data-testid="app-footer"
            className="mt-10 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-3 text-xs text-ink-subtle">
      {meta && (
        <span data-testid="app-version" className="font-mono">
          <a href={`${REPO}/tree/v${meta.version}`} target="_blank" rel="noreferrer" className={linkClass}>
            DeepLabel {meta.version}
          </a>
          {meta.commit && (
            <>
              {' · '}
              <a href={`${REPO}/commit/${meta.commit}`} target="_blank" rel="noreferrer" className={linkClass}>
                {meta.commit}
              </a>
            </>
          )}
        </span>
      )}
      <nav aria-label="About DeepLabel" className="ml-auto flex flex-wrap gap-x-4">
        <a href={`${REPO}/blob/main/docs/FEATURES.md`} target="_blank" rel="noreferrer" className={linkClass}>Documentation</a>
        <a href={REPO} target="_blank" rel="noreferrer" className={linkClass}>Source on GitHub</a>
        <a href={`${REPO}/issues/new`} target="_blank" rel="noreferrer" className={linkClass}>Report a problem</a>
      </nav>
    </footer>
  )
}
