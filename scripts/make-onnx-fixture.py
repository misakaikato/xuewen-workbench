"""生成与 bge-m3 ONNX 签名一致的夹具模型（输出 float16、隐藏维 256）。

用法：uv run --with onnx --with numpy python scripts/make-onnx-fixture.py <输出目录>
产出：<输出目录>/onnx/model_fp16.onnx
结构：Gather(固定种子词表嵌入 250002x256) → 24 x (MatMul(256x256)+Tanh) → Cast(float16)。
计算全程 float32，只在最后 Cast 到 fp16，避免 CPU EP 缺少 fp16 MatMul 内核。
"""
import os
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

VOCAB = 250002
HIDDEN = 256
# 层数按本机实测校准：单批 8x512 的同步推理需 ≥ 50ms 才足以暴露主线程阻塞
LAYERS = 200


def main(out_dir: str) -> None:
    rng = np.random.default_rng(0)
    inits = []
    nodes = []

    # 词表嵌入（Gather 表）
    embedding = (rng.standard_normal((VOCAB, HIDDEN)) * 0.02).astype(np.float32)
    inits.append(numpy_helper.from_array(embedding, 'embedding.weight'))

    # input_ids [batch, seq] -> Gather(axis=0) -> [batch, seq, HIDDEN]
    nodes.append(helper.make_node('Gather', ['embedding.weight', 'input_ids'], ['emb_out'], axis=0))

    prev = 'emb_out'
    for i in range(LAYERS):
        # 固定种子，缩放到单位谱半径附近，避免 Tanh 饱和或数值发散
        w = (rng.standard_normal((HIDDEN, HIDDEN)) / np.sqrt(HIDDEN)).astype(np.float32)
        inits.append(numpy_helper.from_array(w, f'layer.{i}.weight'))
        mm = f'layer.{i}.mm'
        act = f'layer.{i}.tanh'
        nodes.append(helper.make_node('MatMul', [prev, f'layer.{i}.weight'], [mm]))
        nodes.append(helper.make_node('Tanh', [mm], [act]))
        prev = act

    # 最后 Cast 到 float16；attention_mask 仅作输入签名，不参与计算
    nodes.append(helper.make_node('Cast', [prev], ['last_hidden_state'], to=TensorProto.FLOAT16))

    graph = helper.make_graph(
        nodes,
        'bge_m3_fixture',
        [
            helper.make_tensor_value_info('input_ids', TensorProto.INT64, ['batch', 'seq']),
            helper.make_tensor_value_info('attention_mask', TensorProto.INT64, ['batch', 'seq']),
        ],
        [helper.make_tensor_value_info('last_hidden_state', TensorProto.FLOAT16, ['batch', 'seq', HIDDEN])],
        inits,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 13)])
    model.ir_version = 8
    onnx.checker.check_model(model)

    dest = os.path.join(out_dir, 'onnx', 'model_fp16.onnx')
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    onnx.save(model, dest)
    print(f'wrote {dest} ({os.path.getsize(dest)} bytes)')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '.')
