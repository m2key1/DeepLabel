import type { Area } from 'react-easy-crop'

/** The side of the square a picture is uploaded at. The server scales it to what it keeps. */
export const AVATAR_UPLOAD_SIDE = 512

export function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.src = src
  return image.decode().then(() => image)
}

/** The chosen square of `image`, drawn once onto an offscreen canvas at the upload size.
 *  On white, because an avatar is always shown on a background and a JPEG has no alpha;
 *  a phone photo is decoded once here rather than on every move of the crop. */
export function cropToJpeg(image: HTMLImageElement, area: Area): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_UPLOAD_SIDE
  canvas.height = AVATAR_UPLOAD_SIDE
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.reject(new Error('this browser cannot draw the picture'))
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, AVATAR_UPLOAD_SIDE, AVATAR_UPLOAD_SIDE)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, AVATAR_UPLOAD_SIDE, AVATAR_UPLOAD_SIDE)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }))
      else reject(new Error('this browser could not encode the picture'))
    }, 'image/jpeg', 0.92)
  })
}
