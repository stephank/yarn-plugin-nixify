import type { Readable, Writable } from "stream";

const MAX_UINT32 = 2 ** 32 - 1;

/** Write one or more NAR strings to the output. */
export const writeNarStrings = (out: Writable, ...input: string[]) => {
  let size = 0;
  const bufs = input.map((str) => {
    const buf = Buffer.from(str);
    // TODO: Support up to MAX_SAFE_INTEGER
    if (buf.byteLength > MAX_UINT32) {
      throw Error(`NAR string too long: ${buf.byteLength}`);
    }
    size += 8 + Math.ceil(buf.byteLength / 8) * 8;
    return buf;
  });

  const res = Buffer.alloc(size);
  let pos = 0;
  for (const buf of bufs) {
    res.writeUInt32LE(buf.byteLength, pos);
    buf.copy(res, pos + 8);
    pos += 8 + Math.ceil(buf.byteLength / 8) * 8;
  }

  out.write(res);
};

/** Write the contents of a stream as a NAR string to the output. */
export const writeNarStream = async (
  out: Writable,
  size: number,
  input: Readable,
) => {
  // TODO: Support up to MAX_SAFE_INTEGER
  if (size > MAX_UINT32) {
    throw Error(`NAR string too long: ${size}`);
  }
  const sizeBuf = Buffer.alloc(8);
  sizeBuf.writeUInt32LE(size);
  out.write(sizeBuf);

  for await (const chunk of input) {
    out.write(chunk);
  }

  const padding = 8 - (size % 8);
  if (padding !== 8) {
    out.write(Buffer.alloc(padding));
  }
};
