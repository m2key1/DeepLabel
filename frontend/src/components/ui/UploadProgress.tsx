import { humanBytes } from '../../util'

export interface UploadState {
  loaded: number
  total: number
}

export function UploadProgress({ progress }: { progress: UploadState }) {
  const pct = progress.total > 0 ? progress.loaded / progress.total : 0
  return (
    <div className="rounded-md border border-accent bg-accent-wash p-3" data-testid="upload-progress"
         role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)}>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-sm font-semibold text-accent-ink">Uploading… {Math.round(pct * 100)}%</span>
        <span className="text-xs text-accent-ink">
          {humanBytes(progress.loaded)} of {humanBytes(progress.total)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-accent-wash">
        <div className="h-full bg-accent transition-all" style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  )
}
