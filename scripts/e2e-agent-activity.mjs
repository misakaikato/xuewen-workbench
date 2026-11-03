// 反馈第 3 批 G4/G5 e2e：伪造 /api/agent/chat 的 SSE 流，分别在完整页、浮层、阅读页面板断言
// connecting 指示、工具卡运行态与耗时、确认弹窗与倒计时、compaction 提示；
// 另伪造 /api/agent/models 延迟 1 秒后失败，断言「选择模型」下拉立即展开、显示加载中、失败原因与重试。
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeTmpDir, atExit } from './tmpdirs.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = makeTmpDir('wb-agent-activity-');
const port = 7495;
const base = `http://127.0.0.1:${port}`;
let server, win, passed = 0;
atExit(() => server?.kill('SIGKILL'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('window-all-closed', () => {});
const exec = (js) => win.webContents.executeJavaScript(js, true);
async function until(js, ms = 6000) {
  const t0 = Date.now();
  for (;;) { if (await exec(js)) return; if (Date.now() - t0 > ms) throw new Error('等待超时 ' + js); await pause(50); }
}
const check = (name, ok, detail) => { assert.ok(ok, name + ': ' + JSON.stringify(detail)); console.log('PASS', name); passed++; };

// 页内注入：包装 fetch，伪造助手相关接口；SSE 流由 __pushAgentEvent / __endAgent 逐步驱动
const FETCH_HOOK = `(() => {
  if (window.__wbAgentHooked) return;
  window.__wbAgentHooked = true;
  window.__confirmCalls = [];
  window.__agentEvents = [];
  const original = window.fetch.bind(window);
  const json = (data) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  window.__pushAgentEvent = (ev) => { window.__agentEvents.push(ev); };
  window.__endAgent = () => { window.__agentEvents.push(null); };
  window.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes('/api/agent/status')) return json({ endpoint: { baseUrl: 'http://localhost:1234/v1', model: 'mock', ready: true, enabled: true }, mode: 'auto', skills: [], mcp: [], tools: [], conversations: [{ id: 'c1', title: '活动测试', updatedAt: new Date().toISOString() }], folders: [] });
    if (u.includes('/api/agent/session') && (options?.method === 'POST' || u.includes('/c1'))) return json({ id: 'c1', title: '活动测试', messages: [] });
    if (u.includes('/api/agent/confirm')) { window.__confirmCalls.push(JSON.parse(options.body)); return json({ ok: true }); }
    if (u.includes('/api/agent/abort')) return json({ ok: true });
    if (u.includes('/api/agent/settings')) return json({ ok: true });
    if (u.includes('/api/agent/models')) {
      await new Promise((r) => setTimeout(r, 1000));
      return json({ ok: false, models: [], status: 0, url: '', error: '连接被拒绝 (ECONNREFUSED)' });
    }
    if (!u.includes('/api/agent/chat')) return original(url, options);
    // 伪 SSE：把 __agentEvents 里的内容逐个推给页面，null 表示结束流
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let sent = 0;
        for (;;) {
          const evs = window.__agentEvents;
          if (sent < evs.length) {
            for (const ev of evs.slice(sent)) {
              if (ev === null) { controller.close(); return; }
              controller.enqueue(encoder.encode('data: ' + JSON.stringify(ev) + '\\n\\n'));
            }
            sent = evs.length;
          }
          await new Promise((r) => setTimeout(r, 30));
        }
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  };
})()`;

async function sendInPage(textareaSelector, buttonJs) {
  await exec(`(() => {
    const input = document.querySelector(${JSON.stringify(textareaSelector)});
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, '测试问题');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await pause(80);
  await until(`(() => { const b = ${buttonJs}; return !!b && !b.disabled; })()`);
  await exec(`(() => {
    const btn = ${buttonJs};
    btn.click();
    window.__t0 = performance.now();
  })()`);
}

// 在当前界面跑完一遍事件剧本：openPage 装真实数据的页面 → 装 fetch hook → openUi 唤出目标界面
async function runScenario(name, openPage, openUi, textareaSelector, buttonJs) {
  await openPage();
  await exec(FETCH_HOOK);
  if (openUi) await openUi();
  await until(`!!document.querySelector(${JSON.stringify(textareaSelector)})`);
  await pause(200);
  await exec('window.__agentEvents = []; window.__confirmCalls = [];');
  await sendInPage(textareaSelector, buttonJs);

  // connecting：发送后 100ms 内出现
  await until('!!document.querySelector("[data-agent-activity][data-kind=connecting]")', 1000);
  const tConnecting = await exec('performance.now() - window.__t0');
  check(`${name}: 发送后 100ms 内出现 connecting 指示`, tConnecting <= 100, { tConnecting });

  // thinking
  await exec(`window.__pushAgentEvent(${JSON.stringify({ t: 'start' })})`);
  await exec(`window.__pushAgentEvent(${JSON.stringify({ t: 'thinking', v: '先想一下' })})`);
  await until('!!document.querySelector("[data-agent-activity][data-kind=thinking]")');
  check(`${name}: thinking 有指示且渲染思考块`, await exec('document.body.textContent.includes("字)") && document.body.textContent.includes("先想一下") === false')); // 默认折叠，只显示字数

  // 工具运行中：转圈 + 计时增长
  await exec(`window.__pushAgentEvent(${JSON.stringify({ t: 'tool_start', name: 'corpus_search', callId: 't1' })})`);
  await until('!!document.querySelector("[data-tool-running]")');
  const t1 = await exec('document.querySelector("[data-tool-running]").textContent');
  await pause(1300);
  const t2 = await exec('document.querySelector("[data-tool-running]").textContent');
  check(`${name}: 工具卡运行中转圈且计时增长`, parseFloat(t2) > parseFloat(t1), { t1, t2 });
  check(`${name}: 运行工具时活动指示显示工具名`, await exec('!!document.querySelector(\'[data-agent-activity][data-kind=tool]\') && document.body.textContent.includes("正在运行 corpus_search")'));

  // 工具结束：显示耗时
  await exec(`window.__pushAgentEvent(${JSON.stringify({ t: 'tool_end', name: 'corpus_search', callId: 't1', summary: '找到 3 处', isError: false, durationMs: 1234 })})`);
  await until('!document.querySelector("[data-tool-running]")');
  check(`${name}: 工具结束显示耗时`, await exec('document.body.textContent.includes("1.2s") && document.body.textContent.includes("找到 3 处")'));
  check(`${name}: 工具结束到下一事件前显示思考中`, await exec('!!document.querySelector("[data-agent-activity][data-kind=thinking]")'));

  // compaction
  await exec(`window.__pushAgentEvent(${JSON.stringify({ t: 'compaction', phase: 'start', reason: 'threshold' })})`);
  await until('!!document.querySelector("[data-agent-activity][data-kind=compacting]")');
  check(`${name}: compaction 显示「正在压缩上下文」`, await exec('document.body.textContent.includes("正在压缩上下文")'));
  await exec(`window.__pushAgentEvent(${JSON.stringify({ t: 'compaction', phase: 'end', reason: 'threshold', tokensBefore: 120000, tokensAfter: 30000 })})`);
  await until('!document.querySelector("[data-agent-activity][data-kind=compacting]")');

  // confirm：弹出确认框并显示倒计时；点「拒绝」调用确认接口传 false
  await exec(`window.__pushAgentEvent(${JSON.stringify({ t: 'confirm', id: 'cf1', tool: 'bash', args: { cmd: 'rm -rf x' } })})`);
  await until('!!document.querySelector("[data-confirm-dialog]")');
  check(`${name}: confirm 弹出确认框并显示倒计时`, /后自动拒绝/.test(await exec('document.querySelector("[data-confirm-countdown]").textContent')));
  await exec(`[...document.querySelectorAll("[data-confirm-dialog] button")].find((b) => b.textContent.trim() === '拒绝').click()`);
  await until('window.__confirmCalls.length === 1');
  check(`${name}: 点拒绝调用确认接口传 false`, (await exec('window.__confirmCalls[0]')).approved === false);
  await pause(400); // 弹窗离场由 presence 播完

  // 正文与收尾
  await exec(`window.__pushAgentEvent(${JSON.stringify({ t: 'delta', v: '这是回答。' })})`);
  await until('document.body.textContent.includes("这是回答。")');
  check(`${name}: 正文流式期间显示生成中`, await exec('!!document.querySelector("[data-agent-activity][data-kind=generating]")'));
  await exec(`window.__pushAgentEvent(${JSON.stringify({ t: 'done' })}); window.__endAgent();`);
  await until('!document.querySelector("[data-agent-activity]")');
  check(`${name}: done 后活动指示消失`, true);
  await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '发送')`);
}

async function main() {
  server = spawn(process.execPath, [path.join(root, 'server/index.js')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKBENCH_PORT: String(port), WORKBENCH_HOST: '127.0.0.1',
      WORKBENCH_DATA_DIR: path.join(tmp, 'data'), WORKBENCH_STATIC_DIR: path.join(root, 'dist'), WORKBENCH_RAG_EMBED: 'mock' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/config')).ok) break; } catch { /* 启动中 */ }
    await pause(100);
  }
  const corpus = path.join(tmp, 'corpus');
  fs.mkdirSync(corpus);
  fs.writeFileSync(path.join(corpus, '孔子家语.md'), '# 孔子家语\n\n活动指示测试用正文。');
  await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseDir: corpus }) });
  await app.whenReady();
  win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true } });

  // 完整页 AgentChat
  await runScenario('完整页', async () => {
    await win.loadURL(base + '/agent');
    await until('!!document.querySelector("textarea")');
  }, null, 'textarea', `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '发送')`);

  // 浮层 QuickAgent（⌘J 唤出，在完整页上即可）
  await runScenario('浮层', async () => {
    await win.loadURL(base + '/agent');
    await until('!!document.querySelector("textarea")');
  }, async () => {
    await exec('window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true }))');
    await until('!!document.querySelector("textarea[placeholder^=问点什么]")');
  }, 'textarea[placeholder^=问点什么]', 'document.querySelector("button[title=发送]")');

  // 阅读页面板 ReadAgentPanel
  await runScenario('阅读页面板', async () => {
    const enc = encodeURIComponent('孔子家语.md');
    await win.loadURL(base + '/read/' + enc);
    await until('!!document.querySelector("[data-wb-content-card]")');
  }, async () => {
    await until(`[...document.querySelectorAll('button')].some((b) => (b.title || '').includes('AI 助手'))`);
    await exec('[...document.querySelectorAll("button")].find((b) => b.title.includes("AI 助手")).click()');
    await until('!!document.querySelector("textarea[placeholder^=就这篇文档]")', 8000);
  }, 'textarea[placeholder^=就这篇文档]', `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '发送')`);

  // 边界：确认弹窗打开时关闭浮层 → 视同拒绝（confirm 接口收到 approved:false）
  {
    await win.loadURL(base + '/agent');
    await until('!!document.querySelector("textarea")');
    await exec(FETCH_HOOK);
    await pause(300);
    await exec('window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true }))');
    await until('!!document.querySelector("textarea[placeholder^=问点什么]")');
    await pause(300);
    await exec('window.__agentEvents = []; window.__confirmCalls = [];');
    await sendInPage('textarea[placeholder^=问点什么]', 'document.querySelector("button[title=发送]")');
    await until('!!document.querySelector("[data-agent-activity][data-kind=connecting]")');
    await exec(`window.__pushAgentEvent(${JSON.stringify({ t: 'start' })})`);
    await exec(`window.__pushAgentEvent(${JSON.stringify({ t: 'confirm', id: 'cf9', tool: 'bash', args: { cmd: 'x' } })})`);
    await until('!!document.querySelector("[data-confirm-dialog]")');
    await exec('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    await until('!document.querySelector("textarea[placeholder^=问点什么]")');
    await until('window.__confirmCalls.length === 1');
    const call = await exec('window.__confirmCalls[0]');
    check('关闭浮层视同拒绝（approved:false）', call.approved === false && call.id === 'cf9', call);
  }

  // G5：选择模型下拉——立即展开、加载中、1s 后失败原因 + 重试
  await win.loadURL(base + '/agent');
  await until('!!document.querySelector("textarea")');
  await exec(FETCH_HOOK);
  await until('document.body.textContent.includes("mock")');
  await exec(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('mock')).click()`);
  // 下拉立即展开且显示加载中（此刻 models 请求还在 1s 延迟中，1s 内必须出现加载态）
  await until('document.body.textContent.includes("正在拉取模型列表")', 1000);
  check('模型下拉点开立即展开并显示加载中', true);
  await until('document.body.textContent.includes("连接被拒绝")', 4000);
  check('模型下拉显示失败原因', await exec('document.body.textContent.includes("拉取失败")'));
  check('模型下拉提供重试按钮', await exec(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '重试')`));
  await exec(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '重试').click()`);
  await until('document.body.textContent.includes("正在拉取模型列表")', 2000);
  await until('document.body.textContent.includes("连接被拒绝")', 4000);
  check('模型下拉重试后再次给出失败原因', true);
}
main().then(() => finish(0), (e) => { console.error(e); return finish(1); });
async function finish(code) {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  win?.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(code);
}
