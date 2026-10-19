import assert from 'node:assert/strict';
import { AgentHub } from '../server/agent/manager.js';

function run(events) {
  const hub = Object.create(AgentHub.prototype);
  const saved = [];
  const sent = [];
  hub._append = (_id, msg) => saved.push(msg);
  hub._touch = () => {};
  const response = { write: (chunk) => sent.push(JSON.parse(chunk.slice(6))), end: () => {} };
  const entry = { busy: true, sse: new Set([response]), curText: '', curTools: [], curThinking: '', curUsage: null };
  for (const event of events) hub._onEvent('test', entry, event);
  return { sent, saved };
}
const end = { type: 'agent_settled' };
const failed = { type: 'message_end', message: { role: 'assistant', stopReason: 'error',
  errorMessage: 'request (9905 tokens) exceeds the available context size (8192 tokens)',
  usage: { input: 0, output: 0 } } };
const failure = run([failed, end]);
assert.ok(failure.sent.some((e) => e.t === 'error'), '模型事件错误必须转发给界面');
assert.equal(failure.saved[0].failure.kind, 'context');
assert.match(failure.saved[0].failure.message, /8192/);
assert.ok(run([end]).sent.some((e) => e.t === 'error'), '正常结束但无正文必须提示');
const recovered = run([failed, { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: { input: 20, output: 3 } } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '恢复后的回复' } }, end]);
assert.equal(recovered.sent.filter((e) => e.t === 'error').length, 0, '自动恢复成功不显示中间错误');
assert.equal(recovered.saved[0].text, '恢复后的回复');
const stopped = run([{ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted' } }, end]);
assert.equal(stopped.saved[0].failure.kind, 'cancelled', '用户停止不显示模型故障');
console.log('PASS 模型失败、空回复、恢复成功与用户停止');
