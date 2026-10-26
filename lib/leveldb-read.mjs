// Bounded forensic reader for copied LevelDB SSTable blocks and log records.
// It does not create locks, replay writes, or open a LevelDB connection.
import { readFileSync } from 'node:fs';
export function varint(buffer, start = 0) {
  let value = 0, factor = 1, pos = start;
  for (let i = 0; i < 10 && pos < buffer.length; i++) {
    const b = buffer[pos++]; value += (b & 127) * factor;
    if (!Number.isSafeInteger(value)) throw new Error('Varint overflow');
    if (!(b & 128)) return { value, pos };
    factor *= 128;
  }
  throw new Error('Truncated varint');
}
export function snappy(buffer) {
  const header = varint(buffer); let pos = header.pos, outPos = 0;
  if (header.value > 128 * 1024 * 1024) throw new Error('Snappy block too large');
  const out = Buffer.alloc(header.value);
  while (pos < buffer.length && outPos < out.length) {
    const tag = buffer[pos++], type = tag & 3; let length, offset;
    if (type === 0) {
      length = tag >>> 2;
      if (length < 60) length++;
      else { const width = length - 59; if (pos + width > buffer.length) throw new Error('Truncated literal'); length = buffer.readUIntLE(pos, width) + 1; pos += width; }
      if (pos + length > buffer.length || outPos + length > out.length) throw new Error('Invalid literal size');
      buffer.copy(out, outPos, pos, pos + length); pos += length; outPos += length;
    } else {
      const width = type === 1 ? 1 : type === 2 ? 2 : 4;
      if (pos + width > buffer.length) throw new Error('Truncated copy');
      length = type === 1 ? 4 + ((tag >>> 2) & 7) : 1 + (tag >>> 2);
      offset = type === 1 ? ((tag & 224) << 3) | buffer[pos] : buffer.readUIntLE(pos, width); pos += width;
      if (!offset || offset > outPos || outPos + length > out.length) throw new Error('Invalid copy offset');
      for (let i = 0; i < length; i++) { out[outPos] = out[outPos - offset]; outPos++; }
    }
  }
  if (outPos !== out.length || pos !== buffer.length) throw new Error('Snappy length mismatch');
  return out;
}
export function *blockEntries(block) {
  if (block.length < 4) throw new Error('Short block');
  const end = block.length - 4 - block.readUInt32LE(block.length - 4) * 4;
  if (end < 0) throw new Error('Invalid restart table');
  let pos = 0, previous = Buffer.alloc(0);
  while (pos < end) {
    const a = varint(block, pos), b = varint(block, a.pos), c = varint(block, b.pos); pos = c.pos;
    if (a.value > previous.length || pos + b.value + c.value > end) throw new Error('Invalid block entry');
    const key = Buffer.concat([previous.subarray(0, a.value), block.subarray(pos, pos + b.value)]); pos += b.value;
    const value = block.subarray(pos, pos + c.value); pos += c.value; previous = key;
    yield { key, value };
  }
}
export function *levelRecords(file) {
  const data = readFileSync(file);
  if (/\.(ldb|sst)$/i.test(file)) {
    if (data.length < 48 || data.readBigUInt64LE(data.length - 8) !== 0xdb4775248b80fb57n) throw new Error('Unknown SSTable footer');
    const handle = (buffer, pos = 0) => { const a = varint(buffer, pos), b = varint(buffer, a.pos); return { offset: a.value, size: b.value, pos: b.pos }; };
    const load = ({ offset, size }) => {
      if (offset + size + 5 > data.length) throw new Error('Block outside file');
      const part = data.subarray(offset, offset + size), type = data[offset + size];
      if (type === 0) return part;
      if (type === 1) return snappy(part);
      throw new Error(`Unsupported compression ${type}`);
    };
    const meta = handle(data, data.length - 48), index = handle(data, meta.pos);
    for (const entry of blockEntries(load(index))) {
      const h = handle(entry.value);
      yield* blockEntries(load(h));
    }
  } else if (/\.log$/i.test(file)) {
    let parts = [];
    for (let blockStart = 0; blockStart < data.length; blockStart += 32768) {
      const end = Math.min(data.length, blockStart + 32768); let pos = blockStart;
      while (pos + 7 <= end) {
        const size = data.readUInt16LE(pos + 4), type = data[pos + 6]; pos += 7;
        if (!size && !type) break;
        if (pos + size > end) break;
        const value = data.subarray(pos, pos + size); pos += size;
        if (type === 1) { parts = []; yield { key: Buffer.alloc(0), value }; }
        if (type === 2) parts = [value];
        if (type === 3 && parts.length) parts.push(value);
        if (type === 4 && parts.length) { parts.push(value); yield { key: Buffer.alloc(0), value: Buffer.concat(parts) }; parts = []; }
      }
    }
  }
}
