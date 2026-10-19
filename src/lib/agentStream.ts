import type { AgentFailure } from './api';

export type AgentStreamEvent = { t: string; [key: string]: unknown };

export function streamFailure(kind: 'empty' | 'connection' | 'cancelled', details?: string): AgentFailure {
  if (kind === 'empty') return { kind, title: '模型没有返回回答',
    message: '本次生成已结束，但没有收到正文。请检查模型是否加载，或打开 Agent 设置测试连通后重试。' };
  if (kind === 'cancelled') return { kind, title: '已停止生成', message: '本次生成已停止，可以重新提问。' };
  return { kind, title: '回答连接中断',
    message: '没有收到完整的生成结果。已有内容已保留，请检查本地服务与模型端点后重试。', details };
}

// 消费 SSE 并验证完成标记。HTTP 200、正常 EOF 都不能单独证明生成成功。
export async function readAgentStream(response: Response, onEvent: (event: AgentStreamEvent) => void): Promise<AgentFailure | undefined> {
  if (!response.ok || !response.body) {
    const details = await response.text();
    throw new Error(`HTTP ${response.status}${details ? ': ' + details.slice(0, 1000) : ''}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  let hasText = false;
  let reportedFailure = false;
  const consume = (frame: string) => {
    const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    const event = JSON.parse(data) as AgentStreamEvent;
    if (event.t === 'done') completed = true;
    if (event.t === 'delta' && String(event.v || '').trim()) hasText = true;
    if (event.t === 'error') reportedFailure = true;
    onEvent(event);
  };
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        consume(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
      if (done) {
        if (buffer.trim()) consume(buffer);
        break;
      }
    }
  } finally {
    if (completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (reportedFailure) return;
  if (!completed) return streamFailure('connection', '响应流在完成标记之前结束');
  if (!hasText) return streamFailure('empty');
}
