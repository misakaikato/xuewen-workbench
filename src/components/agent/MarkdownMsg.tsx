// 聊天消息的 markdown 渲染（轻量行解析器——覆盖聊天场景：标题/代码块/列表/粗斜体/行内码/链接/引用/表格）
// 独立于阅读页的 CM 渲染，聊天需要的是快、可嵌流式更新、代码块带复制按钮
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

// ---- 行内解析：**bold** *italic* `code` [text](url) ----
function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let key = 0;
  let rest = text;
  const push = (node: React.ReactNode) => out.push(node);
  const mk = () => keyPrefix + '-i' + (key++);

  while (rest) {
    // 行内代码
    let m = /^`([^`]+)`/.exec(rest);
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
    const next = rest.slice(1).search(/[`*[]/);
    if (next < 0) {
      push(rest);
      break;
    }
    push(rest.slice(0, next + 1));
    rest = rest.slice(next + 1);
  }
  return out;
}

// ---- 代码块 ----
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const doCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="my-2 rounded-lg overflow-hidden border border-border">
      <div className="flex items-center justify-between px-3 py-1 bg-muted text-xs text-muted-foreground">
        <span>{lang || 'text'}</span>
        <button onClick={doCopy} className="flex items-center gap-1 hover:text-primary" title="复制代码">
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-[13px] leading-relaxed bg-card">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}

// ---- 主组件：按行解析块级结构 ----
export function MarkdownMsg({ text, richRefs }: { text: string; richRefs?: (t: string) => React.ReactNode }) {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let bk = 0;
  const mk = () => 'b' + (bk++);

  while (i < lines.length) {
    const line = lines[i];

    // 代码围栏
    const fence = /^```(\w*)/.exec(line.trim());
    if (fence) {
      const lang = fence[1];
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        code.push(lines[i]);
        i++;
      }
      i++; // 跳过闭栏
      blocks.push(<CodeBlock key={mk()} lang={lang} code={code.join('\n')} />);
      continue;
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)/.exec(line);
    if (h) {
      const level = h[1].length;
      const cls = level === 1 ? 'text-lg font-semibold mt-3 mb-1' : level === 2 ? 'text-base font-semibold mt-2.5 mb-1' : level === 3 ? 'text-sm font-semibold mt-2 mb-0.5' : 'text-sm font-semibold mt-1.5';
      blocks.push(<div key={mk()} className={cls}>{richRefs ? richRefs(h[2]) : inline(h[2], mk())}</div>);
      i++;
      continue;
    }

    // 无序列表
    if (/^[-*]\s+/.test(line.trim())) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={mk()} className="list-disc pl-5 my-2 space-y-1">
          {items.map((it, j) => <li key={j} className="text-sm">{richRefs ? richRefs(it) : inline(it, mk())}</li>)}
        </ul>
      );
      continue;
    }

    // 有序列表
    if (/^\d+\.\s+/.test(line.trim())) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={mk()} className="list-decimal pl-5 my-2 space-y-1">
          {items.map((it, j) => <li key={j} className="text-sm">{richRefs ? richRefs(it) : inline(it, mk())}</li>)}
        </ol>
      );
      continue;
    }

    // 引用块
    if (line.trim().startsWith('> ') || line.trim() === '>') {
      const quoted: string[] = [];
      while (i < lines.length && (lines[i].trim().startsWith('> ') || lines[i].trim() === '>')) {
        quoted.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote key={mk()} className="border-l-3 border-primary/50 pl-3 my-1.5 text-muted-foreground text-sm">
          {quoted.map((q, j) => <div key={j}>{richRefs ? richRefs(q) : inline(q, mk())}</div>)}
        </blockquote>
      );
      continue;
    }

    // 水平线
    if (/^---+$/.test(line.trim())) {
      blocks.push(<hr key={mk()} className="my-3 border-border" />);
      i++;
      continue;
    }

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 普通段落（连续非空行）
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^```|^#{1,4}\s|^[-*]\s|^\d+\.\s|^>\s|^---/.test(lines[i].trim())) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) {
      blocks.push(
        <p key={mk()} className="my-2 text-sm">
          {richRefs ? richRefs(para.join(' ')) : inline(para.join(' '), mk())}
        </p>
      );
    } else {
      i++; // 安全推进
    }
  }

  return <div className="space-y-2">{blocks}</div>;
}
