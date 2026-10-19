// 输入框内容模型：引用块与文本块交替排列
// 引用来自「对话消息」或「上传的文本文件」；图片走独立附件通道
export interface QuoteBlock {
  id: string;
  type: 'quote';
  text: string; // 引用原文
  source: string; // 来源标签（如「第1章.md」或「助手回复」）
}

export interface TextBlock {
  id: string;
  type: 'text';
  value: string;
}

export type Block = QuoteBlock | TextBlock;

let seq = 0;
const nid = () => 'b' + (++seq) + '_' + Date.now().toString(36).slice(-4);

export const newTextBlock = (value = ''): TextBlock => ({ id: nid(), type: 'text', value });
export const newQuoteBlock = (text: string, source: string): QuoteBlock => ({ id: nid(), type: 'quote', text, source });

/** 空状态：一个空文本块 */
export const initialBlocks = (): Block[] => [newTextBlock()];

/** 把 blocks 拼成发给模型的文本（引用转为 markdown 引用块） */
export function blocksToPrompt(blocks: Block[]): string {
  return blocks
    .map((b) => (b.type === 'quote' ? b.text.trim().split('\n').map((l) => '> ' + l).join('\n') : b.value))
    .filter((s) => s.trim())
    .join('\n\n')
    .trim();
}

/** 是否为空（无任何文本、无引用） */
export function blocksEmpty(blocks: Block[]): boolean {
  return !blocks.some((b) => (b.type === 'quote' ? b.text.trim() : b.value.trim()));
}

/** 去掉引用块后是否还有用户输入的文字（用于决定是否自动加「请基于引用回答」） */
export function hasUserText(blocks: Block[]): boolean {
  return blocks.some((b) => b.type === 'text' && b.value.trim());
}

/** 末尾追加一个引用块，并在其后补一个空文本块（便于继续输入） */
export function appendQuote(blocks: Block[], text: string, source: string): Block[] {
  const next = [...blocks];
  const last = next[next.length - 1];
  // 最后一个块若是空文本块，先移除（避免多出一个空行）
  if (last?.type === 'text' && !last.value.trim()) next.pop();
  next.push(newQuoteBlock(text, source));
  next.push(newTextBlock());
  return next;
}

/** 删除引用块（相邻文本块保持独立） */
export function removeBlock(blocks: Block[], id: string): Block[] {
  const next = blocks.filter((b) => b.id !== id);
  return next.length ? next : initialBlocks();
}
