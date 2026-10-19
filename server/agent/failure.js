// 用户可见的失败说明与原始诊断分开保存；不声称压缩或重试已经成功。
export function agentFailure(error, kind = 'model') {
  const details = String(error?.message || error || '');
  if (/exceed_context_size|exceeds the available context|context overflow/i.test(details)) {
    const limit = details.match(/"n_ctx"\s*:\s*(\d+)/)?.[1] || details.match(/context size \((\d+) tokens\)/i)?.[1];
    return { kind: 'context', title: '模型上下文超限',
      message: `本次请求超出模型当前可用的上下文窗口${limit ? `（${limit} tokens）` : ''}，未能完成回答。请新建对话减少历史，或在 LM Studio 调大上下文长度后重新加载模型。`, details };
  }
  if (kind === 'empty') return { kind, title: '模型没有返回回答',
    message: '本次生成已结束，但没有收到正文。可能是模型返回了空内容或端点响应异常。请检查模型是否加载，或打开 Agent 设置测试连通后重试。' };
  if (kind === 'cancelled') return { kind, title: '已停止生成', message: '本次生成已停止，可以重新提问。' };
  return { kind, title: '模型未能完成回答',
    message: '模型或端点返回错误，本次回答未完成。请检查 LM Studio 中的模型状态和服务日志，或打开 Agent 设置测试连通后重试。', details };
}
