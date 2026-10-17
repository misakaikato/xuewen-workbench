// 生成 server/t2s.js：繁→简单字映射表（opencc-js 逐字转换，只保留 1 字 → 1 字的映射，
// 保证归一化时偏移量不变）。此表为派生数据，提交进仓库后运行时不再依赖 opencc-js
//（opencc-js 仅作为 devDependencies 供本脚本使用）。
// 用法：node scripts/gen-t2s-map.mjs
import fs from 'node:fs';
import path from 'node:path';
import * as OpenCC from 'opencc-js';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'server', 't2s.js');

const cfg = OpenCC.Locale.configs['t2s'];
const conv = OpenCC.ConverterFactory([...cfg.normalizationChain, ...cfg.conversionChain]);
const RANGES = [
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意
  [0xf900, 0xfaff], // CJK 兼容表意
];

const map = {};
let n = 0;
for (const [lo, hi] of RANGES) {
  for (let cp = lo; cp <= hi; cp++) {
    const ch = String.fromCodePoint(cp);
    const out = conv(ch);
    if (out.length === 1 && out !== ch) {
      map[ch] = out;
      n++;
    }
  }
}

const body =
  '// 自动生成：繁→简单字映射表（scripts/gen-t2s-map.mjs，源：opencc-js t2s 字典）。\n' +
  '// 只含 1 字 → 1 字映射，逐字符替换后偏移量不变；请勿手改。\n' +
  'export const T2S_MAP = ' + JSON.stringify(map) + ';\n';
fs.writeFileSync(OUT, body, 'utf8');
console.log('已写入', OUT, '映射数:', n);
