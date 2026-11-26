function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function makeZip(files) {
  const encoder = new TextEncoder(), local = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name), bytes = new Uint8Array(await file.arrayBuffer());
    const crc = crc32(bytes);
    const header = new Uint8Array(30 + name.length), view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true);
    view.setUint32(14, crc, true); view.setUint32(18, bytes.length, true); view.setUint32(22, bytes.length, true);
    view.setUint16(26, name.length, true); header.set(name, 30);
    const entry = new Uint8Array(46 + name.length), directory = new DataView(entry.buffer);
    directory.setUint32(0, 0x02014b50, true); directory.setUint16(4, 20, true); directory.setUint16(6, 20, true);
    directory.setUint16(8, 0x800, true); directory.setUint32(16, crc, true);
    directory.setUint32(20, bytes.length, true); directory.setUint32(24, bytes.length, true);
    directory.setUint16(28, name.length, true); directory.setUint32(42, offset, true); entry.set(name, 46);
    local.push(header, bytes); central.push(entry); offset += header.length + bytes.length;
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22), view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, files.length, true); view.setUint16(10, files.length, true);
  view.setUint32(12, centralSize, true); view.setUint32(16, offset, true);
  return new Blob([...local, ...central, end], { type: "application/zip" });
}
