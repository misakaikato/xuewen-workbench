#!/usr/bin/env python3
"""bge-m3 MLX 嵌入 sidecar：JSONL over stdio。

协议（每行一个 JSON）：
  请求 {"seq":1,"cmd":"load","dir":"/path/to/model"}
  请求 {"seq":2,"cmd":"embed","texts":["...","..."]}
  响应 {"seq":1,"ok":true} / {"seq":2,"vectors":[[...],[...]]} / {"seq":n,"error":"..."}

实现：mlx-embeddings 的 XLM-R 前向 + HF 分词；bge-m3 官方 CLS 池化 + L2 归一。
"""
import sys
import json

_model = None
_tok = None


def log_err(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


def do_load(dir_):
    global _model, _tok
    import os
    import mlx.core as mx
    from transformers import AutoTokenizer

    mx.set_default_device(mx.gpu)  # M 系列 Metal；不可用时 mlx 自动回退 cpu
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)  # vendor 的 mlx_model 就在本目录
    from mlx_model import load_bge_m3

    _model = load_bge_m3(dir_)
    _tok = AutoTokenizer.from_pretrained(dir_)
    # 预热一次，触发图编译（首条不等编译）
    _embed(["预热"])
    return {"ok": True}


def _embed(texts):
    import mlx.core as mx

    enc = _tok(texts, padding=True, truncation=True, max_length=1024)
    out = _model(
        input_ids=mx.array(enc["input_ids"]),
        attention_mask=mx.array(enc["attention_mask"]),
    )
    cls = out.last_hidden_state[:, 0]  # bge-m3 官方 CLS 池化
    return cls / mx.sqrt((cls * cls).sum(-1, keepdims=True) + 1e-12)


def do_embed(texts):
    v = _embed(texts)
    return {"vectors": v.tolist()}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            log_err("bad json: %s" % e)
            continue
        seq = req.get("seq")
        try:
            cmd = req.get("cmd")
            if cmd == "load":
                resp = do_load(req["dir"])
            elif cmd == "embed":
                resp = do_embed(req.get("texts", []))
            else:
                resp = {"error": "unknown cmd: %s" % cmd}
        except Exception as e:
            resp = {"error": repr(e)}
        resp["seq"] = seq
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
