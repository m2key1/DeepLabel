import { useRef, useState } from 'react'
import type { DragEvent } from 'react'

import { clearMyAvatar, setMyAvatar } from '../../api'
import { refreshAvatars } from '../../avatars'
import { Avatar, usePicture } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { AvatarCropDialog } from './AvatarCropDialog'
import { loadImage } from './cropAvatar'

/** Your own picture at the top of your profile. Clicking it, or dropping a file on it,
 *  picks a new one and opens the crop; set here rather than on the identity provider's
 *  pages, because sending people elsewhere to change it is why most never would. */
export function ProfilePicture({ username, displayName }: { username: string; displayName?: string }) {
  const picture = usePicture(username)
  const file = useRef<HTMLInputElement | null>(null)
  const [picked, setPicked] = useState<{ image: HTMLImageElement; url: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    if (picked) URL.revokeObjectURL(picked.url)
    setPicked(null)
  }

  const open = async (chosen: File) => {
    setError(null)
    const url = URL.createObjectURL(chosen)
    try {
      setPicked({ image: await loadImage(url), url })
    } catch {
      URL.revokeObjectURL(url)
      setError('that file is not a picture this browser can read')
    }
  }

  const save = async (cropped: File) => {
    await setMyAvatar(cropped)
    await refreshAvatars()
    close()
  }

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await clearMyAvatar()
      await refreshAvatars()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDropping(false)
    const dropped = e.dataTransfer.files[0]
    if (dropped) void open(dropped)
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        data-testid="avatar-pick"
        title="Choose a new picture, or drop one here"
        aria-label="Change your picture"
        onClick={() => file.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDropping(true)
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={onDrop}
        className={`rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          dropping ? 'ring-2 ring-accent' : 'hover:opacity-90'}`}
      >
        <Avatar name={username} displayName={displayName} size="xl" />
      </button>
      {picture && (
        <Button size="xs" variant="ghost" disabled={busy} data-testid="avatar-clear" onClick={() => void remove()}>
          Remove picture
        </Button>
      )}
      {error && <p data-testid="avatar-error" className="max-w-40 text-center text-xs text-danger">{error}</p>}
      <input
        ref={file}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid="avatar-file"
        onChange={(e) => {
          const chosen = e.target.files?.[0]
          e.target.value = ''
          if (chosen) void open(chosen)
        }}
      />
      {picked && <AvatarCropDialog image={picked.image} onCancel={close} onSave={save} />}
    </div>
  )
}
