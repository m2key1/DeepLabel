# Frontend

Vite + React + TypeScript + Tailwind SPA. In production it is built into an Nginx
image that serves the UI and proxies `/api` to the backend, so the browser never talks
to the backend directly. See the [root README](../README.md) for running the stack.

```bash
npm install
npm run dev      # dev server against a locally running backend
npm run build    # tsc -b && vite build
npm run lint     # oxlint
npm test         # vitest: the pure geometry, the edit history, the metric transforms
```

## Layout

- `pages/` - one file per route (`main.tsx` holds the router). Jobs, job detail, page
  viewer for text jobs, tile editor for map jobs, models, users, settings.
- `components/` - shared UI plus per-area folders (`job/`, `models/`, `viewer/`).
- `editor/` - what the page viewer and the tile editor share: the shell they both render
  through, the tool palette, the pen panel, the object list, the status footer, the
  shortcut sheet, the eraser's brush panel, and undo and redo on the revision spans the
  backend answers every write with.
- `lib/` - pure helpers with no React: confidence, layout classes, and `geometry/` - `core`
  for rings, `quad` for the scan's boxes and line quads, `region` for the tile's polygons
  with holes and traced lines. Unit tests live beside the pure code: that folder,
  `editor/useEditHistory`, and `components/models/metrics`.
- `hooks/` - reusable behaviour such as `useImageSurface` and `usePointerDrag`.
- `api.ts` - the single typed client for the backend; nothing else issues fetches.
