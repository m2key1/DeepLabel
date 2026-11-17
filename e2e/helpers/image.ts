import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

// A grayscale page scan stand-in: white background with dark horizontal bars where
// the stub runner places its text lines. Pure Node, so tests need no image library.
//
// `variant` shifts the bar pattern so callers can generate scans that differ in
// content. Ingest deduplicates by content hash, so a job seeded with repeated
// variant 0 images keeps only the first - map tiles in particular must differ.
// Variant 0 is byte-identical to the original single-argument output.
export function scanPng(width = 600, height = 800, variant = 0): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8)
  ihdr.writeUInt8(0, 9)

  // Each PNG row starts with its filter byte, 0 for none.
  const rows = scanRows(width, height, variant).map((row) => Buffer.concat([Buffer.alloc(1), row]))

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** The same scan as an uncompressed 8-bit grayscale TIFF, which Chromium cannot display. */
export function scanTiff(width = 600, height = 800, variant = 0): Buffer {
  const SHORT = 3
  const LONG = 4
  const entries: [number, number, number][] = [
    [256, LONG, width], [257, LONG, height], [258, SHORT, 8], [259, SHORT, 1], [262, SHORT, 1],
    [273, LONG, 0], [277, SHORT, 1], [278, LONG, height], [279, LONG, width * height],
  ]
  const header = 8
  const ifd = Buffer.alloc(2 + entries.length * 12 + 4)
  const pixelsAt = header + ifd.length
  ifd.writeUInt16LE(entries.length, 0)
  entries.forEach(([tag, type, value], i) => {
    const at = 2 + i * 12
    ifd.writeUInt16LE(tag, at)
    ifd.writeUInt16LE(type, at + 2)
    ifd.writeUInt32LE(1, at + 4)
    const stored = tag === 273 ? pixelsAt : value
    if (type === SHORT) ifd.writeUInt16LE(stored, at + 8)
    else ifd.writeUInt32LE(stored, at + 8)
  })
  const start = Buffer.from([0x49, 0x49, 42, 0, header, 0, 0, 0])
  return Buffer.concat([start, ifd, ...scanRows(width, height, variant)])
}

function scanRows(width: number, height: number, variant: number): Buffer[] {
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width, 0xf2)
    const inBar = Math.floor((y + variant * 7) / 40) % 3 === 1
    if (inBar) {
      for (let x = Math.floor(width * 0.12); x < width * 0.88; x++) row[x] = 0x30
    }
    rows.push(row)
  }
  return rows
}

/** An RGB picture whose left half is one colour and right half another, so which half a
 *  crop kept can be read off any pixel of the result. */
export function twoColourPng(width: number, height: number,
                             left: [number, number, number], right: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8)
  ihdr.writeUInt8(2, 9)
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set(x < width / 2 ? left : right, 1 + x * 3)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Width and height off a PNG's IHDR chunk, which always follows the 8-byte signature
 *  and the chunk's own length and type: 8 + 4 + 4 = 16. */
export function pngSize(png: Buffer): [number, number] {
  return [png.readUInt32BE(16), png.readUInt32BE(20)]
}
