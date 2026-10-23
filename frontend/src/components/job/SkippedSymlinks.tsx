export function SkippedSymlinks({ paths }: { paths: string[] }) {
  return (
    <div role="status" data-testid="skipped-symlinks" className="rounded-md border border-warn/40 p-3 text-sm">
      <p className="mb-1 font-medium text-warn">
        {paths.length === 1 ? 'One symbolic link was not read' : `${paths.length} symbolic links were not read`}
      </p>
      <p className="mb-1.5 text-ink-muted">
        Links to folders are not followed, nor links to files outside the folders this server
        reads from. Add the folder they point at by its own path to include it.
      </p>
      <ul className="list-disc pl-5 font-mono text-xs text-ink">
        {paths.map((path) => <li key={path}>{path}</li>)}
      </ul>
    </div>
  )
}
