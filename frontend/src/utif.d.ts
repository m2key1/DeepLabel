declare module 'utif' {
  interface Ifd {
    width: number
    height: number
  }
  const UTIF: {
    decode(buffer: ArrayBuffer): Ifd[]
    decodeImage(buffer: ArrayBuffer, ifd: Ifd): void
    toRGBA8(ifd: Ifd): Uint8Array<ArrayBuffer>
  }
  export default UTIF
}
