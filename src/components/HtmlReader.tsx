// HTML 阅读器：DOMPurify 白名单消毒后渲染（脚本 / 事件属性 / 危险 URL 全部剥除）。
// CSS 保真：head 的 <style> 与相对路径 <link> 样式表提取后「作用域化」注入——
// 选择器全部限定到 .wb-html-body 内，语料样式不会泄漏到应用界面（DOMPurify 本身会剥 <link>，
// 且 DOMParser 只取 body.innerHTML 会丢 head，这两步必须自己在消毒前完成）。
// 指向库内文档的相对链接与 md 阅读同口径在应用内导航（服务端已把它们记入链接图），
// 目标不存在的标为断链；图片等相对资源重写到 /api/file/raw 直接出图。
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { rawFileUrl } from '@/lib/api';
import { useApp } from '@/store/app';
import type { TreeNode } from '@/lib/types';
import { ExternalLinkDialog } from '@/components/ExternalLinkDialog';
import { resolveDocTarget } from '@/lib/docLink';

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
// 与 server/links.js 的 HTML_DOC_EXTS 对齐：这些扩展名的 href 按文档处理
const DOC_EXTS = ['.md', '.json', '.txt', '.doc', '.docx', '.html', '.htm'];
const extOf = (p: string) => {
  const i = p.lastIndexOf('.');
  return i >= 0 ? p.slice(i).toLowerCase() : '';
};

function joinRel(baseDir: string, rel: string): string {
  const parts = (baseDir ? baseDir.split('/') : []).filter(Boolean);
  for (const seg of rel.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function collectPaths(node: TreeNode | null, out: Set<string>): Set<string> {
  if (!node) return out;
  for (const f of node.files) out.add(f.path);
  for (const d of node.dirs) collectPaths(d, out);
  return out;
}

// ---------- CSS 作用域化：语料样式限定在 .wb-html-body 内 ----------

const HTML_SCOPE = '.wb-html-body';

// 单条选择器：html/body/:root 开头 → 映射为容器本身；其余前置容器后代选择器
function scopeSelector(sel: string): string {
  const s = sel.trim();
  if (!s) return s;
  const m = /^(?:html|body|:root)\b(.*)$/.exec(s);
  if (m) return HTML_SCOPE + m[1];
  return HTML_SCOPE + ' ' + s;
}

// CSS 消毒：剥掉脚本载体（expression / javascript: URL）。
// 不经过 DOMPurify——它处理 style 标签内容时经常整段清空，且本地语料场景里
// CSS 的威胁面就是这两类脚本通道（外链 http 图片与 <img> 同策略，保留）
function sanitizeCss(css: string): string {
  return css
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/url\(\s*(['"]?)\s*javascript\s*:[^)]*\)/gi, 'url()');
}

// 按花括号配对扫描的规则级 scoper：@media/@supports 递归，@font-face/@keyframes 原样保留，
// @import 删除（可能引外网资源），position:fixed 删除（会脱离文档流盖住应用界面）
function scopeCss(css: string): string {
  const src = sanitizeCss(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const prelude = src.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < n && depth > 0) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
      j++;
    }
    const body = src.slice(open + 1, j - 1);
    if (prelude.startsWith('@')) {
      const at = prelude.toLowerCase();
      if (at.startsWith('@import') || at.startsWith('@charset')) {
        // 丢弃
      } else if (at.startsWith('@media') || at.startsWith('@supports') || at.startsWith('@layer')) {
        out += prelude + '{' + scopeCss(body) + '}';
      } else {
        // @font-face / @keyframes / @page 等：原样保留（不含文档选择器）
        out += prelude + '{' + body + '}';
      }
    } else if (prelude) {
      const sels = prelude.split(',').map(scopeSelector).join(',');
      const decls = body.replace(/(?:^|;)\s*position\s*:\s*fixed\s*(!\s*important)?\s*(?=;|$)/gi, '$1');
      out += sels + '{' + decls + '}';
    }
    i = j;
  }
  return out;
}

// 从原文提取样式：<style> 文本 + 相对路径 <link> href（CSS 消毒在 scopeCss 内统一做）
function extractStyles(rawHtml: string): { css: string; links: string[] } {
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
  const cssParts: string[] = [];
  for (const st of Array.from(doc.querySelectorAll('style'))) {
    if (st.textContent?.trim()) cssParts.push(st.textContent);
  }
  const links: string[] = [];
  for (const ln of Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'))) {
    const href = (ln.getAttribute('href') || '').trim();
    if (href && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) links.push(href.split('#')[0]);
  }
  return { css: cssParts.join('\n'), links };
}

export const HtmlReader = memo(function HtmlReader({
  content,
  docPath,
  onContentReady,
}: {
  content: string;
  docPath: string;
  onContentReady?: () => void;
}) {
  const navigate = useNavigate();
  const { tree, config } = useApp();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [extPath, setExtPath] = useState<string | null>(null);
  const docDir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';

  const existing = useMemo(() => collectPaths(tree, new Set<string>()), [tree]);

  // 样式提取（消毒前：<link> 会被 DOMPurify 剥除，head 样式也在 body.innerHTML 之外）
  const styles = useMemo(() => extractStyles(content), [content]);
  // 外链样式表（相对路径）：经 /api/file/raw 拉取后走同一作用域化管线
  const [linkedCss, setLinkedCss] = useState('');
  useEffect(() => {
    if (!styles.links.length) {
      setLinkedCss('');
      return;
    }
    let dead = false;
    Promise.all(
      styles.links.map(async (href) => {
        let target: string;
        try {
          target = joinRel(docDir, decodeURIComponent(href));
        } catch {
          return '';
        }
        const res = await fetch(rawFileUrl(target)).catch(() => null);
        if (!res || !res.ok) return '';
        return res.text().catch(() => '');
      })
    ).then((parts) => {
      if (!dead) setLinkedCss(parts.filter(Boolean).join('\n'));
    });
    return () => {
      dead = true;
    };
  }, [styles.links, docDir]);

  const scopedCss = useMemo(() => scopeCss(styles.css + '\n' + linkedCss), [styles.css, linkedCss]);

  // 消毒 + 资源重写 + 断链标记（一次性产出稳定 HTML，避免全局状态重置内部 DOM）
  const html = useMemo(() => {
    const clean = DOMPurify.sanitize(content, { USE_PROFILES: { html: true } });
    const doc = new DOMParser().parseFromString(clean, 'text/html');
    // body 内的 <style> 已被 extractStyles 收集并将以作用域化形式统一注入，
    // 这里必须移除——否则未加作用域的 CSS 会泄漏到整个应用界面
    for (const st of Array.from(doc.querySelectorAll('style'))) st.remove();
    const resolveRel = (raw: string): string | null => {
      if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) return null;
      const filePart = raw.split('#')[0].split('?')[0];
      if (!filePart) return null;
      try {
        return joinRel(docDir, decodeURIComponent(filePart));
      } catch {
        return joinRel(docDir, filePart);
      }
    };
    for (const img of Array.from(doc.querySelectorAll('img[src]'))) {
      const t = resolveRel(img.getAttribute('src') || '');
      if (t) img.setAttribute('src', rawFileUrl(t));
    }
    for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
      const t = resolveRel(a.getAttribute('href') || '');
      if (t && DOC_EXTS.includes(extOf(t)) && !existing.has(t)) {
        a.classList.add('wb-link-missing');
        a.setAttribute('title', '目标文档不存在：' + t);
      }
    }
    return doc.body.innerHTML;
  }, [content, docDir, existing]);

  useEffect(() => {
    onContentReady?.();
    // 从其他文档带 #锚点 跳入：按元素 id / name / 标题文本定位
    const hash = window.location.hash;
    if (hash.length > 1 && bodyRef.current) {
      const term = decodeURIComponent(hash.slice(1));
      const el =
        bodyRef.current.querySelector('#' + CSS.escape(term)) ||
        bodyRef.current.querySelector(`[name="${CSS.escape(term)}"]`) ||
        Array.from(bodyRef.current.querySelectorAll('h1,h2,h3,h4,h5,h6')).find(
          (h) => h.textContent?.trim() === term
        );
      el?.scrollIntoView({ block: 'start' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(href) || href.startsWith('//')) {
      window.open(href, '_blank', 'noopener,noreferrer');
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return; // mailto/tel 等非 http 协议不处理
    const [filePart, anchorRaw] = href.split('#');
    const anchor = anchorRaw ? decodeURIComponent(anchorRaw) : '';
    if (!filePart) {
      if (anchor) {
        const el =
          bodyRef.current?.querySelector('#' + CSS.escape(anchor)) ||
          bodyRef.current?.querySelector(`[name="${CSS.escape(anchor)}"]`);
        el?.scrollIntoView({ block: 'start' });
      }
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(filePart);
    } catch {
      return;
    }
    const resolved = resolveDocTarget(docDir, decoded, config?.baseDir);
    if (resolved.kind === 'external') {
      // 越过知识库根的链接：弹确认框，用户同意后才用系统默认应用打开
      setExtPath(resolved.path);
      return;
    }
    const target = resolved.path;
    if (DOC_EXTS.includes(extOf(target))) {
      const nav = '/read/' + encPath(target);
      navigate(anchor ? nav + '#' + encodeURIComponent(anchor) : nav);
    } else {
      // 非文档资源（图片/附件等）：直接打开原始文件
      window.open(rawFileUrl(target), '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <>
      <div ref={bodyRef} className="reader wb-html-body min-w-0" onClick={onClick}>
        {scopedCss && <style>{scopedCss}</style>}
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      <ExternalLinkDialog path={extPath} onClose={() => setExtPath(null)} />
    </>
  );
});
