# Windows RAG 验收手册（M2 收尾，需 Windows 机器执行）

日期：2026-10-18 ｜ 对应规格：specs/2026-10-18-rag.md M2、ARCHITECTURE 5.2.1

## 背景

- npm 版 onnxruntime-node（1.30）Windows 构建自带 **DirectML.dll**（DX12，RTX 5070 直接可用，零安装），**不带 CUDA 库**——原「win 用 CUDA」决策修订为：首发 DML（包内），CUDA 为实测不达标后的升级路径（Python 边车 + onnxruntime-gpu）。
- 嵌入会话 EP 链：默认 `dml → cpu` 自动回退；可用环境变量 `WORKBENCH_RAG_ONNX_EP=dml,cuda` 调整顺序（RAG 管理页 status 会显示实际生效的 `ep`）。

## 步骤（Windows 11 + RTX 5070）

1. **取包**：GitHub Releases 最新 draft/published 的 `Xuewen-Workbench-Setup-*.exe`，或本机 `npm run electron:build:win` 自打。
2. **安装并打开**，添加测试语料（可用仓库 `test-data/ds-a` 复制一份），进入「RAG 管理」。
3. **模型**：点「下载模型」（HF → hf-mirror 自动回退，约 1.1GB；或从 Mac 拷贝 `models/bge-m3/onnx-fp16` 目录后用「手动导入」）。
4. **建索引**：记录总耗时与任务管理器内存（预期：13 块小语料秒级；关注 GPU 占用确认 DML 生效——status 的 `model.ep` 应显示 `dml`；若显示 `cpu`，截图事件查看器/应用日志回报）。
5. **采集一致性数据**（在仓库目录）：
   ```powershell
   node scripts/rag-consistency.mjs run --url http://127.0.0.1:7410 --out win-dml.json
   # 再强制 CPU 跑一遍（自检 ②：CPU 模式两边 Top-10 顺序相同）：
   # 关闭应用 → 设 WORKBENCH_RAG_ONNX_EP=cpu → 重启应用 → 重建索引 →
   node scripts/rag-consistency.mjs run --url http://127.0.0.1:7410 --out win-cpu.json
   ```
6. **把两个 json 传回 Mac**，与 mac 参照比对（自检 ①③）：
   ```bash
   node scripts/rag-consistency.mjs diff win-dml.json mac-mlx.json   # 跨平台 GPU↔GPU
   node scripts/rag-consistency.mjs diff win-cpu.json win-dml.json   # 同机 CPU↔GPU
   ```
7. **回报内容**：两个 diff 结果、建索引耗时、内存峰值、`model.ep` 实际值、断网后应用可正常建索引/检索（模型就绪后完全离线）。

## 判据（5.2.1）

- ① 应命中段落两边都命中；② Top-10 顺序一致；③ 分数差 >1e-4 的题必须列出（量化边界例外可放过）。
- DML 性能若明显低于预期（对比 Mac MLX 的秒级/13 块），启动 CUDA 边车升级评估。

## Mac 侧已完成的参照数据（2026-10-18）

- MLX(Metal) ↔ ONNX(CPU) 同机：**20/20 完全一致**
- 打包应用（离线 MLX 引导）↔ ONNX(CPU)：**20/20 完全一致**
- 参照文件可由 `node scripts/rag-consistency.mjs run --url http://127.0.0.1:7410 --out mac-mlx.json` 现采
