// Markdown 阅读器：GFM 渲染、语法高亮、语料引用自动解析、服务端词条自动内链、相对链接与图片解析
import { useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useNavigate } from 'react-router-dom';
import { remarkCorpusRefs, type RefNameEntry } from '@/lib/remarkRefs';
import { remarkAutoLinks, decodeWblink } from '@/lib/remarkAutoLinks';
import type { DocLink } from '@/lib/api';
import { RefChip } from './RefChip';
import { LinkChip } from './LinkChip';
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
  links = [],
}: {
  content: string;
  docPath: string;
  refNames: RefNameEntry[];
  collections: { name: string }[];
  /** 服务端算好的本篇自动内链（/api/links/doc），与编辑器实时预览同源 */
  links?: DocLink[];
}) {
  const navigate = useNavigate();
  const plugins = useMemo(
    () => [
      remarkGfm,
      [remarkCorpusRefs, { names: refNames, collections, fileLinks: false }],
      [remarkAutoLinks, links],
    ],
    [refNames, collections, links]
  );
  const docDir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';

  return (
    <div className="reader">
      <ReactMarkdown
        remarkPlugins={plugins as never}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={(url) =>
          url.startsWith('ref://') || url.startsWith('refc://') || url.startsWith('wblink://')
            ? url
            : defaultUrlTransform(url)
        }
        components={{
          a({ href, children, node }) {
            const url = href || '';
            if (url.startsWith('wblink://')) {
              // 服务端词条链接：携带 kind 信息，由 LinkChip 区分样式与交互
              const info = decodeWblink(url);
              return (
                <LinkChip href={url} kind={info?.kind || 'auto'}>
                  {children}
                </LinkChip>
              );
            }
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
