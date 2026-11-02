// 最小 ZIP 写入器：deflate + crc32 + UTF-8 文件名（bit 11），支持中文名；不支持 zip64（超 4GB 抛错）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const u16 = (n) => Buffer.from([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n) => Buffer.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export function writeZip(outFile, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  let total = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    total += body.length;
    if (total > 0xffffffff) throw new Error('ZIP 总大小超过 4GB，不支持 zip64');
    const crc = zlib.crc32(body) >>> 0;
    const deflated = zlib.deflateRawSync(body);
    const { time, date } = dosDateTime();
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16(20), u16(0x0800), u16(8),
      u16(time), u16(date),
      u32(crc), u32(deflated.length), u32(body.length),
      u16(nameBuf.length), u16(0),
      nameBuf, deflated,
    ]);
    const central = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      u16(20), u16(20), u16(0x0800), u16(8),
      u16(time), u16(date),
      u32(crc), u32(deflated.length), u32(body.length),
      u16(nameBuf.length), u16(0), u16(0),
      u16(0), u16(0), u32(0),
      u32(offset),
      nameBuf,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0), u16(0),
    u16(entries.length), u16(entries.length),
    u32(centralDir.length), u32(offset),
    u16(0),
  ]);
  const out = Buffer.concat([...locals, centralDir, end]);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = outFile + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, outFile);
  return outFile;
}
