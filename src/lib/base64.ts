// 分块 base64：String.fromCharCode(...整个大数组) 会在大文件上抛 RangeError（参数数量上限）。
// 用于 Skill 安装等把 File 编码进 JSON 的路径。
export function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
