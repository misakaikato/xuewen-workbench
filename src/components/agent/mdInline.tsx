// 行内 markdown 渲染（粗体/斜体/行内码/链接），独立于组件以便复用


export function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let key = 0;
  let rest = text;
  const push = (node: React.ReactNode) => out.push(node);
  const mk = () => keyPrefix + '-i' + (key++);

  while (rest) {
    // 图片 ![alt](url) —— 必须先于链接匹配
    let m = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (m) {
      const src = m[2];
      // 只自动加载生图结果与本机 data 图；其余 URL 只渲染为文字链接，不自动请求
      if (src.startsWith('/api/agent/generated/') || src.startsWith('data:image/')) {
        push(
          <img
            key={mk()}
            src={src}
            alt={m[1]}
            className="my-2 max-w-full rounded-lg border border-border"
            loading="lazy"
          />
        );
      } else {
        push(
          <a key={mk()} href={src} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
            {m[1] || '图片链接'}
          </a>
        );
      }
      rest = rest.slice(m[0].length);
      continue;
    }
    // 行内代码
    m = /^`([^`]+)`/.exec(rest);
    if (m) {
      push(<code key={mk()} className="px-1 py-0.5 rounded bg-muted text-[0.88em] font-mono">{m[1]}</code>);
      rest = rest.slice(m[0].length);
      continue;
    }
    // 粗体
    m = /^\*\*([^*]+)\*\*/.exec(rest);
    if (m) {
      push(<strong key={mk()} className="font-semibold">{inline(m[1], mk())}</strong>);
      rest = rest.slice(m[0].length);
      continue;
    }
    // 斜体
    m = /^\*([^*\s][^*]*)\*/.exec(rest);
    if (m) {
      push(<em key={mk()}>{inline(m[1], mk())}</em>);
      rest = rest.slice(m[0].length);
      continue;
    }
    // 链接 [text](url)
    m = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (m) {
      push(
        <a key={mk()} href={m[2]} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
          {m[1] || m[2]}
        </a>
      );
      rest = rest.slice(m[0].length);
      continue;
    }
    // 普通字符（到下一个特殊标记）
    const next = rest.slice(1).search(/[`*[!]/);
    if (next < 0) {
      push(rest);
      break;
    }
    push(rest.slice(0, next + 1));
    rest = rest.slice(next + 1);
  }
  return out;
}
