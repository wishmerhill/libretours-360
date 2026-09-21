/** Minimal PNG reader/writer (8-bit RGB/RGBA, non-interlaced) for the end-to-end test. */
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA */
  data: Uint8Array;
  pixel(x: number, y: number): [number, number, number];
}

export function decodePng(png: Buffer): DecodedPng {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("Not a PNG");
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  for (let pos = 8; pos < png.length;) {
    const length = png.readUInt32BE(pos);
    const type = png.toString("ascii", pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("Only 8-bit non-interlaced PNGs");
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (!channels) throw new Error(`Unsupported PNG colour type ${data[9]}`);
    } else if (type === "IDAT") idat.push(data);
    pos += length + 12;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]!;
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[y * stride + x] = (value + predictor) & 0xff;
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = pixels[i * channels]!;
    data[i * 4 + 1] = pixels[i * channels + 1]!;
    data[i * 4 + 2] = pixels[i * channels + 2]!;
    data[i * 4 + 3] = channels === 4 ? pixels[i * channels + 3]! : 255;
  }
  return {
    width,
    height,
    data,
    pixel: (x, y) => {
      const o = (Math.round(y) * width + Math.round(x)) * 4;
      return [data[o]!, data[o + 1]!, data[o + 2]!];
    },
  };
}
