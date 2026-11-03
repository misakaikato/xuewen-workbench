// 全局索引就绪信号：store 轮询 /api/status 观察到链接索引推进（linksSeq 变化）时广播。
// 反链面板之外的「索引未就绪」消费者（自动链接、引用计数）订阅它，就绪后再取一次，
// 不再各自写固定次数的重试循环。事件由 src/store/app.tsx 的轮询发出。
export const INDEX_SETTLED_EVENT = 'wb-index-settled';

/** 等待下一次索引就绪信号（一次性）。 */
export function whenIndexSettled(): Promise<void> {
  return new Promise((resolve) => {
    const onSettled = () => {
      window.removeEventListener(INDEX_SETTLED_EVENT, onSettled);
      resolve();
    };
    window.addEventListener(INDEX_SETTLED_EVENT, onSettled);
  });
}
