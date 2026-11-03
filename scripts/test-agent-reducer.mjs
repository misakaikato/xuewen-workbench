// 反馈第 3 批 G2/G6：applyAgentEvent 共用处理函数 + 分块 base64 的单测。
// TS 模块先经 esbuild 编译到临时目录再 import（与 scripts/test-feedback.mjs 同一做法）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { makeTmpDir } from './tmpdirs.mjs';

const tmp = makeTmpDir('wb-agent-reducer-');
await build({
  entryPoints: [path.resolve('src/lib/agentReducer.ts'), path.resolve('src/lib/base64.ts')],
  outdir: tmp,
  format: 'esm',
  bundle: true,
  platform: 'neutral',
  logLevel: 'silent',
});

const reducer = await import(pathToFileURL(path.join(tmp, 'agentReducer.js')).href);
const { uint8ToBase64 } = await import(pathToFileURL(path.join(tmp, 'base64.js')).href);
const { initialAgentTurn, applyAgentEvent, settleAgentTurn, resolveConfirm } = reducer;

const run = (events, start = initialAgentTurn(1000)) =>
  events.reduce((s, ev) => applyAgentEvent(s, ev, 2000), start);

let checks = 0;
const ok = (name, cond, detail) => { assert.ok(cond, name + (detail ? '：' + JSON.stringify(detail) : '')); console.log('PASS', name); checks++; };

// 1. delta 与 thinking 累积
{
  const s = run([
    { t: 'start' },
    { t: 'thinking', v: '先想' }, { t: 'thinking', v: '再想' },
    { t: 'delta', v: '答' }, { t: 'delta', v: '案' },
  ]);
  assert.equal(s.thinking, '先想再想');
  assert.equal(s.text, '答案');
  assert.equal(s.activity.kind, 'generating');
  ok('delta 与 thinking 正确累积', true);
}

// 2. connecting → start 后进入 thinking；正文后出现 generating
{
  const s0 = initialAgentTurn(1000);
  assert.equal(s0.activity.kind, 'connecting');
  const s1 = applyAgentEvent(s0, { t: 'start' }, 2000);
  assert.equal(s1.activity.kind, 'thinking');
  ok('connecting 在首个事件后转为 thinking', true);
}

// 3. tool_start → tool_end 配对：同名两次（无 callId，按出现顺序）
{
  const s = run([
    { t: 'start' },
    { t: 'tool_start', name: 'read', args: { p: 1 } },
    { t: 'tool_start', name: 'read', args: { p: 2 } },
    { t: 'tool_end', name: 'read', summary: '第一次', durationMs: 100 },
    { t: 'tool_end', name: 'read', summary: '第二次', durationMs: 200 },
  ]);
  assert.equal(s.tools.length, 2);
  assert.equal(s.tools[0].summary, '第一次', 'tool_end 必须对应最早一个仍在运行的同名项');
  assert.equal(s.tools[1].summary, '第二次');
  assert.equal(s.tools[0].durationMs, 100);
  assert.equal(s.tools[1].durationMs, 200);
  assert.ok(!s.tools.some((t) => t.running));
  ok('同名工具两次调用按顺序配对', true);
}

// 4. 交错工具：a 开始 → b 开始 → b 结束 → a 结束
{
  const s = run([
    { t: 'tool_start', name: 'search', callId: 'a' },
    { t: 'tool_start', name: 'bash', callId: 'b' },
    { t: 'tool_end', name: 'bash', callId: 'b', summary: 'b 完', durationMs: 50 },
  ]);
  assert.equal(s.tools[0].running, true);
  assert.equal(s.tools[1].summary, 'b 完');
  assert.equal(s.activity.kind, 'tool');
  assert.equal(s.activity.name, 'search', 'b 结束后活动态应落在仍在运行的 a 上');
  const s2 = applyAgentEvent(s, { t: 'tool_end', name: 'search', callId: 'a', summary: 'a 完', durationMs: 80 }, 3000);
  assert.equal(s2.tools[0].summary, 'a 完');
  assert.equal(s2.activity.kind, 'thinking', '工具全部结束、下一事件未到时显示思考中，不能空白');
  ok('交错工具按 callId 配对，结束后回落思考中', true);
}

// 5. 工具运行中的活动态带工具名
{
  const s = run([{ t: 'start' }, { t: 'tool_start', name: 'bash' }]);
  assert.deepEqual([s.activity.kind, s.activity.name], ['tool', 'bash']);
  assert.ok(s.tools[0].running && s.tools[0].startedAt > 0);
  ok('tool_start 置 running 并给出活动态', true);
}

// 6. confirm：设置 pendingConfirm 与 confirm 活动态；resolveConfirm 回落
{
  const s = run([{ t: 'start' }, { t: 'confirm', id: 'c1', tool: 'bash', args: { cmd: 'rm' } }]);
  assert.equal(s.pendingConfirm.id, 'c1');
  assert.equal(s.pendingConfirm.tool, 'bash');
  assert.equal(s.activity.kind, 'confirm');
  assert.ok(s.pendingConfirm.deadline > 0);
  const r = resolveConfirm(s, 3000);
  assert.equal(r.pendingConfirm, null);
  assert.equal(r.activity.kind, 'thinking');
  ok('confirm 设置 pendingConfirm 与活动态，应答后回落', true);
}

// 7. compaction start/end
{
  let s = run([{ t: 'start' }, { t: 'compaction', phase: 'start', reason: 'threshold' }]);
  assert.equal(s.activity.kind, 'compacting');
  s = applyAgentEvent(s, { t: 'compaction', phase: 'end', reason: 'threshold', tokensBefore: 120000, tokensAfter: 30000 }, 3000);
  assert.equal(s.compactions.length, 1);
  assert.equal(s.compactions[0].tokensBefore, 120000);
  assert.equal(s.activity.kind, 'thinking');
  ok('compaction start 置 compacting、end 记录并恢复', true);
}

// 8. error：失败落 state，活动态清零，运行中工具标记中断
{
  const s = run([
    { t: 'tool_start', name: 'bash' },
    { t: 'error', failure: { kind: 'context', title: '模型上下文超限', message: '超过 8192' } },
  ]);
  assert.equal(s.failure.kind, 'context');
  assert.equal(s.activity, null);
  assert.equal(s.tools[0].interrupted, true);
  assert.equal(s.tools[0].running, false);
  ok('error 事件置 failure 并中断运行中工具', true);
}

// 9. 流结束（无 error）时运行中的工具被标为中断
{
  const running = run([{ t: 'start' }, { t: 'tool_start', name: 'search' }]);
  const stopped = settleAgentTurn(running, 'stopped');
  assert.equal(stopped.tools[0].interrupted, true);
  assert.equal(stopped.tools[0].running, false);
  assert.equal(stopped.activity, null);
  const disconnected = settleAgentTurn(running, 'disconnected');
  assert.equal(disconnected.tools[0].interrupted, true);
  const finished = settleAgentTurn(running, 'finished');
  assert.equal(finished.tools[0].interrupted, undefined, '正常结束不标中断');
  ok('settle 时运行中工具按原因标记中断', true);
}

// 10. 界面特有事件不进状态（原样返回）
{
  const s0 = run([{ t: 'start' }]);
  assert.equal(applyAgentEvent(s0, { t: 'open_doc', path: 'a.md' }), s0);
  assert.equal(applyAgentEvent(s0, { t: 'settings_changed', category: 'theme' }), s0);
  ok('open_doc / settings_changed 不由共用函数处理', true);
}

// 11. G6：300KB 数据走分块 base64 不抛 RangeError，且结果与一次性编码一致
{
  const big = new Uint8Array(300 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  const encoded = uint8ToBase64(big);
  assert.equal(encoded.length, Math.ceil(big.length / 3) * 4);
  // 对照：小块用一次性编码验证正确性
  const small = new Uint8Array([1, 2, 3, 250, 251, 252]);
  assert.equal(uint8ToBase64(small), btoa(String.fromCharCode(...small)));
  assert.equal(uint8ToBase64(big.subarray(0, 1024)), btoa(String.fromCharCode(...big.subarray(0, 1024))));
  ok('300KB 分块 base64 编码不抛错且结果正确', true);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`全部通过（${checks} 项）`);
