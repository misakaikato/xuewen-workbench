// 智能助手总开关（specs/2026-11-03-agent-toggle.md G2）：在临时 WORKBENCH_DATA_DIR 下拉起后端 + 假 OpenAI 兼容端点。
// 断言：缺省 agentEnabled:false；关闭时 chat 与写接口 409 agent-disabled、只读接口照常；非布尔值 400；
// 关闭时启动不探测模型端点、打开后才探测；打开后 chat 不再 409；
// 关闭时中止进行中的生成（流式中、等待工具确认中两种），关闭请求返回前生成已停，之后不再有后台生成。
// 运行：node scripts/test-agent-toggle.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmpDir, atExit } from './tmpdirs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = makeTmpDir('wb-agent-toggle-');
const dataDir = path.join(tmp, 'data');
const corpus = path.join(tmp, 'corpus');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(corpus, { recursive: true });
fs.writeFileSync(path.join(corpus, '论语.md'), '# 论语\n\n学而时习之。');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const check = (name, ok, detail) => {
  assert.ok(ok, name + (detail === undefined ? '' : ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
  console.log('PASS', name);
  passed++;
};

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

// ---------- 假 OpenAI 兼容端点：记录全部请求；chat 按 plan 返回文本、工具调用或持续流式不结束 ----------
const fake = { requests: [], plan: [], openStreams: 0, closedStreams: 0 };
const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const fakeServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    fake.requests.push(req.method + ' ' + req.url);
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const step = fake.plan.shift() || { text: '完成' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      if (step.hang) {
        // 持续流式、永不结束：只有客户端断开（生成被中止）才停
        fake.openStreams++;
        res.write(chunk({ role: 'assistant', content: '' }));
        const timer = setInterval(() => res.write(chunk({ content: '字' })), 100);
        res.on('close', () => { clearInterval(timer); fake.closedStreams++; });
        return;
      }
      if (step.toolCall) {
        res.write(chunk({ role: 'assistant', content: '' }));
        res.write(chunk({ tool_calls: [{ index: 0, id: step.toolCall.id, type: 'function', function: { name: step.toolCall.name, arguments: step.toolCall.arguments } }] }));
        res.write(chunk({}, 'tool_calls'));
      } else {
        res.write(chunk({ role: 'assistant', content: '' }));
        res.write(chunk({ content: step.text }));
        res.write(chunk({}, 'stop'));
      }
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});
const fakePort = await freePort();
await new Promise((resolve) => fakeServer.listen(fakePort, '127.0.0.1', resolve));
atExit(() => fakeServer.close());

// 生成端点预先写好（RAG 与助手共用的 llm-settings.json），用来观察启动期是否探测模型
fs.writeFileSync(path.join(dataDir, 'llm-settings.json'), JSON.stringify({
  enabled: false, baseUrl: `http://127.0.0.1:${fakePort}/v1`, model: 'test-model', apiKey: 'x', thinkingLevel: 'off', mode: 'confirm',
}));

// ---------- 后端 ----------
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: { ...process.env, WORKBENCH_PORT: String(port), WORKBENCH_HOST: '127.0.0.1', WORKBENCH_DATA_DIR: dataDir, WORKBENCH_RAG_EMBED: 'mock' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
atExit(() => server.kill('SIGKILL'));

const call = async (method, url, body) => {
  const r = await fetch(base + url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（SSE 等） */ }
  return { status: r.status, json, text };
};
const is409 = (r) => r.status === 409 && r.json?.error === 'agent-disabled';

// 开一条 chat SSE 流：events 实时收集，ended 在流结束时 resolve
function openChat(sessionId, text) {
  const events = [];
  const ended = (async () => {
    const r = await fetch(base + '/api/agent/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, text }),
    });
    if (!r.ok) return { status: r.status, events, body: await r.text() };
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (line.startsWith('data: ')) {
          try { events.push(JSON.parse(line.slice(6))); } catch { /* 非 JSON 行 */ }
        }
      }
    }
    return { status: r.status, events };
  })();
  return { events, ended };
}
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('等待超时：' + what);
    await sleep(50);
  }
  return Date.now() - t0;
}
const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error('等待超时：' + what); })]);
const busyOf = async () => (await call('GET', '/api/agent/status')).json.conversations.filter((c) => c.busy).map((c) => c.id);

async function main() {
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + '/api/config')).ok) break; } catch { /* 启动中 */ }
    if (i > 150) throw new Error('后端未就绪');
    await sleep(100);
  }

  console.log('— 默认关闭');
  const ui = await call('GET', '/api/ui-settings');
  check('默认 GET /api/ui-settings 返回 agentEnabled:false', ui.status === 200 && ui.json.agentEnabled === false, ui.json);
  await sleep(1500); // 启动期探测是异步的，留足时间让它（若存在）发生
  check('关闭时启动期不探测模型端点（假端点 0 请求）', fake.requests.length === 0, fake.requests);

  const chat = await call('POST', '/api/agent/chat', { sessionId: 'x', text: '你好' });
  check('关闭时 POST /api/agent/chat → 409 agent-disabled', is409(chat), chat.status + ' ' + chat.text);
  for (const [m, u, b] of [
    ['POST', '/api/agent/session', { title: 't' }],
    ['DELETE', '/api/agent/session/x', {}],
    ['POST', '/api/agent/confirm', { id: 'x', approved: true }],
    ['PUT', '/api/agent/settings', { mode: 'auto' }],
    ['POST', '/api/agent/skill', { name: 'x', content: 'y' }],
    ['POST', '/api/agent/mcp-server', { name: 'x', config: { command: 'x' } }],
    ['POST', '/api/agent/memory', { scope: 'global', fact: 'x' }],
    ['PUT', '/api/agent/agents-md', { content: 'x' }],
    ['GET', '/api/agent/export/x'],
    ['POST', '/api/agent/models', {}],
  ]) {
    const r = await call(m, u, b);
    check(`关闭时 ${m} ${u} → 409 agent-disabled`, is409(r), r.status + ' ' + r.text.slice(0, 80));
  }
  for (const u of ['/api/agent/status', '/api/agent/memory?scope=global', '/api/agent/agents-md']) {
    const r = await call('GET', u);
    check(`关闭时只读 GET ${u} 照常返回`, r.status === 200, r.status + ' ' + r.text.slice(0, 80));
  }
  check('关闭期间以上请求都未访问模型端点', fake.requests.length === 0, fake.requests);

  const bad = await call('PUT', '/api/ui-settings', { agentEnabled: 'yes' });
  check('PUT agentEnabled:"yes" → 400', bad.status === 400, bad.json);
  check('非法值不改动设置', (await call('GET', '/api/ui-settings')).json.agentEnabled === false);

  console.log('— 打开');
  const on = await call('PUT', '/api/ui-settings', { agentEnabled: true });
  check('PUT agentEnabled:true → 200 并回显 true', on.status === 200 && on.json.agentEnabled === true, on.json);
  check('GET 读回 agentEnabled:true', (await call('GET', '/api/ui-settings')).json.agentEnabled === true);
  await waitFor(() => fake.requests.includes('GET /v1/models'), 3000, '打开后探测模型端点');
  check('打开后才按需探测模型端点（GET /v1/models）', true);

  const lib = await call('POST', '/api/config', { baseDir: corpus });
  check('添加资料库', lib.status === 200, lib.json);
  const conv = await call('POST', '/api/agent/session', { title: '开关测试' });
  check('打开后可新建会话', conv.status === 200 && !!conv.json?.id, conv.json);
  const convId = conv.json.id;
  fake.plan = [{ text: '你好，我在。' }];
  const r1 = await within(openChat(convId, '你好').ended, 20000, '首轮对话');
  check('打开后 chat 不再 409，正常流式完成', r1.status === 200 && r1.events.some((e) => e.t === 'done') && JSON.stringify(r1.events).includes('你好，我在'), r1);

  console.log('— 关闭时中止流式中的生成');
  fake.plan = [{ hang: true }];
  const c2 = openChat(convId, '写一篇长文');
  await waitFor(() => fake.openStreams === 1 && c2.events.some((e) => e.t === 'delta'), 15000, '生成开始流式输出');
  check('生成进行中 status 显示 busy', (await busyOf()).includes(convId));
  let t0 = Date.now();
  const off = await call('PUT', '/api/ui-settings', { agentEnabled: false });
  check('关闭请求成功', off.status === 200 && off.json.agentEnabled === false, off.json);
  check('关闭请求返回时生成已停止（无 busy 会话）', (await busyOf()).length === 0);
  console.log('    关闭请求耗时', Date.now() - t0, 'ms');
  const r2 = await within(c2.ended, 5000, '聊天流在关闭后结束');
  check('聊天流以 done 收尾', r2.events.some((e) => e.t === 'done'), r2.events.map((e) => e.t));
  await waitFor(() => fake.closedStreams === 1, 3000, '上游模型流被断开');
  check('上游模型请求被断开（生成真正停止）', true);
  let before = fake.requests.length;
  await sleep(1500);
  check('关闭后没有后台生成（1.5 秒内无新的模型请求）', fake.requests.length === before, fake.requests.slice(before));
  const again = await call('POST', '/api/agent/chat', { sessionId: convId, text: '还在吗' });
  check('关闭后再 chat → 409 agent-disabled', is409(again), again.status + ' ' + again.text);
  const st = await call('GET', '/api/agent/status');
  check('关闭不删数据：会话仍在列表中', st.json.conversations.some((c) => c.id === convId), st.json.conversations);
  const hist = await call('GET', '/api/agent/session/' + convId);
  check('关闭不删数据：历史消息可读', hist.status === 200 && JSON.stringify(hist.json.messages).includes('你好，我在'), hist.status);

  console.log('— 关闭时拒绝待确认的工具调用并中止');
  check('重新打开', (await call('PUT', '/api/ui-settings', { agentEnabled: true })).json?.agentEnabled === true);
  const marker = path.join(tmp, 'bash-ran');
  fake.plan = [
    { toolCall: { id: 'call_bash', name: 'bash', arguments: JSON.stringify({ command: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"` }) } },
    { hang: true },
  ];
  const c3 = openChat(convId, '跑个命令');
  await waitFor(() => c3.events.some((e) => e.t === 'confirm'), 15000, '出现工具确认请求');
  check('confirm 模式下 bash 等待用户确认', (await busyOf()).includes(convId));
  t0 = Date.now();
  const off2 = await call('PUT', '/api/ui-settings', { agentEnabled: false });
  const offMs = Date.now() - t0;
  check('关闭请求成功且远早于 30 秒确认超时', off2.status === 200 && offMs < 10000, offMs);
  check('关闭请求返回时生成已停止', (await busyOf()).length === 0);
  const r3 = await within(c3.ended, 5000, '聊天流在关闭后结束');
  check('聊天流以 done 收尾', r3.events.some((e) => e.t === 'done'), r3.events.map((e) => e.t));
  before = fake.requests.length;
  await sleep(1500);
  check('被拒绝的 bash 没有执行', !fs.existsSync(marker), marker);
  check('关闭后没有后台生成（1.5 秒内无新的模型请求）', fake.requests.length === before, fake.requests.slice(before));
  const confirmLate = await call('POST', '/api/agent/confirm', { id: c3.events.find((e) => e.t === 'confirm').id, approved: true });
  check('关闭后补发确认 → 409，不能再放行工具', is409(confirmLate), confirmLate.status);
}

main().then(
  () => {
    console.log(`\n全部通过：${passed} 项`);
    process.exit(0);
  },
  (e) => {
    console.error('\n失败：', e.message);
    process.exit(1);
  }
);
