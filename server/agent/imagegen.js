// 图像生成：接 UniAPI（凭据来自 ~/.config/uniapi/config.json 或 UNIAPI_API_KEY）
// 生成的图片存应用数据目录 generated/，不污染资料库
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const CONFIG = path.join(os.homedir(), '.config', 'uniapi', 'config.json');

export function uniapiKey() {
  if (process.env.UNIAPI_API_KEY) return process.env.UNIAPI_API_KEY.trim();
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    return String(j.api_key || '').trim();
  } catch {
    return '';
  }
}

export function baseUrl() {
  return (process.env.UNIAPI_BASE_URL || 'https://api.uniapi.io/v1').replace(/\/$/, '');
}

const SIZES = new Set(['1024x1024', '1024x1536', '1536x1024', 'auto']);

/**
 * 生成图片并落盘，返回 { file, url, bytes }
 * 429（网关常态）自动退避重试 10s/20s/40s
 */
export async function generateImage({ prompt, size = '1024x1024', model = 'chatgpt-image-latest', dataDir }) {
  const key = uniapiKey();
  if (!key) throw new Error('未配置 UniAPI 密钥（~/.config/uniapi/config.json 的 api_key 或 UNIAPI_API_KEY）');
  const text = String(prompt || '').trim();
  if (!text) throw new Error('prompt 不能为空');
  const sz = SIZES.has(size) ? size : '1024x1024';

  const dir = path.join(dataDir, 'generated');
  fs.mkdirSync(dir, { recursive: true });

  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(baseUrl() + '/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model, prompt: text, n: 1, size: sz }),
        signal: AbortSignal.timeout(300000), // 30-90s 常见，给足超时
      });
      if (r.status === 429) {
        lastErr = new Error('网关负载饱和（429）');
        await new Promise((res) => setTimeout(res, 10000 * Math.pow(2, attempt)));
        continue;
      }
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}${body ? ': ' + body.slice(0, 300) : ''}`);
      }
      const j = await r.json();
      const item = j?.data?.[0];
      if (!item) throw new Error('响应缺少 data[0]');
      let buf;
      if (item.b64_json) buf = Buffer.from(item.b64_json, 'base64');
      else if (item.url) {
        const ir = await fetch(item.url, { signal: AbortSignal.timeout(120000) });
        if (!ir.ok) throw new Error('下载生成的图片失败: HTTP ' + ir.status);
        buf = Buffer.from(await ir.arrayBuffer());
      } else {
        throw new Error('响应既无 b64_json 也无 url');
      }
      const id = crypto.randomBytes(8).toString('hex');
      const file = path.join(dir, id + '.png');
      fs.writeFileSync(file, buf);
      return { file: id + '.png', url: '/api/agent/generated/' + id + '.png', bytes: buf.length };
    } catch (e) {
      lastErr = e;
      if (attempt === 3) break;
    }
  }
  throw lastErr || new Error('图像生成失败');
}
