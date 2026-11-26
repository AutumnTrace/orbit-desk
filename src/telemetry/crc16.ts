// CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final xor. check("123456789") = 0x29B1.
const table = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 8;
  for (let b = 0; b < 8; b++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  table[i] = c;
}

export function crc16(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0xffff;
  for (let i = start; i < end; i++) crc = ((crc << 8) & 0xffff) ^ table[((crc >> 8) ^ bytes[i]!) & 0xff]!;
  return crc;
}
