// Markdown 阅读器：GFM 渲染、语法高亮、语料引用自动解析、相对链接与图片解析
import { useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useNavigate } from 'react-router-dom';
import { remarkCorpusRefs, type RefNameEntry } from '@/lib/remarkRefs';
import { RefChip } from './RefChip';
import { rawFileUrl } from '@/lib/api';
import 'highlight.js/styles/github-dark.css';

function joinRel(baseDir: string, rel: string): string {
  const parts = (baseDir ? baseDir.split('/') : []).filter(Boolean);
  for (const seg of rel.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

export function MarkdownReader({
  content,
  docPath,
  refNames,
  collections,
}: {
  content: string;
  docPath: string;
  refNames: RefNameEntry[];
  collections: { name: string }[];
}) {
  const navigate = useNavigate();
  const plugins = useMemo(
    () => [remarkGfm, [remarkCorpusRefs, { names: refNames, collections }]],
    [refNames, collections]
  );
  const docDir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';

  return (
    <div className="reader">
      <ReactMarkdown
        remarkPlugins={plugins as never}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={(url) =>
          url.startsWith('ref://') || url.startsWith('refc://') ? url : defaultUrlTransform(url)
        }
        components={{
          a({ href, children, node }) {
            const url = href || '';
            if (url.startsWith('ref://') || url.startsWith('refc://')) {
              const firstChild = node?.children?.[0] as { type?: string; tagName?: string } | undefined;
              const inlineCode = firstChild?.type === 'inlineCode' || firstChild?.tagName === 'code';
              return (
                <RefChip href={url} inlineCode={inlineCode}>
                  {children}
                </RefChip>
              );
            }
            if (/^https?:\/\//i.test(url)) {
              return (
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            }
            // 锚点与相对路径
            return (
              <a
                href={url}
                onClick={(e) => {
                  e.preventDefault();
                  const [filePart, anchor] = url.split('#');
                  if (!filePart) {
                    // 本文件锚点
                    const el = document.getElementById(decodeURIComponent(anchor || ''));
                    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    return;
                  }
                  const target = joinRel(docDir, decodeURIComponent(filePart));
                  const nav = '/read/' + target.split('/').map(encodeURIComponent).join('/');
                  navigate(anchor ? nav + '#' + encodeURIComponent(anchor) : nav);
                }}
              >
                {children}
              </a>
            );
          },
          img({ src, alt }) {
            const url = String(src || '');
            const resolved = /^https?:\/\//i.test(url) || url.startsWith('data:')
              ? url
              : rawFileUrl(joinRel(docDir, decodeURIComponent(url)));
            return <img src={resolved} alt={alt || ''} loading="lazy" />;
          },
          table({ children }) {
            return (
              <div className="table-scroll">
                <table>{children}</table>
              </div>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
