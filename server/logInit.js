// 后端进程日志初始化：接管 console 写入 backend.log，并启动事件循环卡顿看门狗。
// 由 server/index.js 作为第一条 import 引入，保证后续所有日志都进入文件。
import { dataDir } from './store.js';
import { initProcessLogger, logsDir } from './logger.js';
import { startLagWatch } from './lagWatch.js';

initProcessLogger({ dir: logsDir(dataDir()), name: 'backend', tag: 'backend' });
startLagWatch({ tag: 'backend' });
