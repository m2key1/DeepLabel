import { useState } from 'react'
import Cropper from 'react-easy-crop'
import type { Area, Point } from 'react-easy-crop'

import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'
import { cropToJpeg } from './cropAvatar'

const MAX_ZOOM = 4
/** The sizes an avatar is really drawn at: the profile, a list row, the nav bar. */
const PREVIEW_SIDES = [96, 32, 24]

function Preview({ image, area, side }: { image: HTMLImageElement; area: Area | null; side: number }) {
  const scale = area ? side / area.width : 0
  return (
    <span data-testid="avatar-crop-preview" data-side={side}
          className="relative inline-block shrink-0 overflow-hidden rounded-full bg-white"
          style={{ width: side, height: side }}>
      {area && (
        <img src={image.src} alt="" draggable={false}
             className="absolute max-w-none"
             style={{
               width: image.naturalWidth * scale,
               height: image.naturalHeight * scale,
               left: -area.x * scale,
               top: -area.y * scale,
             }} />
      )}
    </span>
  )
}

/** Which part of a picture is the face: drag to move, the slider, the wheel or a pinch to
 *  zoom, the arrow keys to nudge. Nothing is uploaded until Save, and then only the square
 *  that was chosen. */
export function AvatarCropDialog({ image, onCancel, onSave }: {
  image: HTMLImageElement
  onCancel: () => void
  onSave: (file: File) => Promise<void>
}) {
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [area, setArea] = useState<Area | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (!area) return
    setBusy(true)
    setError(null)
    try {
      await onSave(await cropToJpeg(image, area))
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title="Your picture" onClose={busy ? undefined : onCancel}>
      <div className="relative aspect-square w-full overflow-hidden rounded bg-ground">
        <Cropper
          image={image.src}
          crop={crop}
          zoom={zoom}
          maxZoom={MAX_ZOOM}
          aspect={1}
          cropShape="round"
          showGrid={false}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropAreaChange={(_, pixels) => setArea(pixels)}
          cropperProps={{
            'aria-label': 'The part of the picture that is kept - drag it, or use the arrow keys',
            'data-testid': 'avatar-crop-area',
          } as React.HTMLAttributes<HTMLDivElement>}
        />
      </div>
      <label className="mt-3 flex items-center gap-2 text-xs text-ink-muted">
        Zoom
        <input
          type="range" min={1} max={MAX_ZOOM} step={0.01} value={zoom}
          data-testid="avatar-crop-zoom"
          onChange={(e) => setZoom(Number(e.target.value))}
          className="min-w-0 flex-1 accent-accent"
        />
      </label>
      <div className="mt-3 flex items-end gap-3">
        {PREVIEW_SIDES.map((side) => <Preview key={side} image={image} area={area} side={side} />)}
        <p className="text-xs text-ink-subtle">As others will see it.</p>
      </div>
      {error && <p data-testid="avatar-error" className="mt-2 text-xs text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" data-testid="avatar-crop-cancel" className={modalBtn} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" data-testid="avatar-crop-save" className={modalPrimaryBtn}
                disabled={busy || !area} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  )
}
