# 生产调试示例：断言失败定位（debuggee_prod.py）

**用途**：在真实 dsh 会话中演示用 `debug` 工具定位断言失败的完整闭环。
本程序 `assert total == 34` 必然失败（`1!+2!+3!+4! = 1+2+6+24 = 33`）——断言的期望值故意写错一位。

**为什么有这个文件**：它不是单元测试夹具（`test/fixtures/` 下的 `.py` 才是被 `node --test`
驱动的样本），而是 0.1.5 真实 headless 会话验证用的可复现样本。放在 `examples/`
以避免污染测试夹具目录的语义。

## 在 dsh 中复现（headless profile 需已安装 dsh-debugger-dap 并加入 bundles）

```sh
dsh --profile headless "Python 程序 examples/debuggee_prod.py 断言失败（assert total == 34）。
请用 debug 工具调试定位根因：launch 停在入口，在 total += factorial(k) 行设断点，
continue 命中后检查 total/k/factorial(k) 的值，用一句话说明为何断言会失败，然后 disconnect。"
```

预期：模型 launch（debugpy）→ 断点 verified → continue 命中 4 次，逐次读到
`k/factorial(k)/total = 1/1/0 → 2/2/1 → 3/6/3 → 4/24/9` → 得出 `33 ≠ 34`，
给出根因（`range(1, 5)` 累加为 33，断言的期望值 34 是错的）。

## 提示

- 断点源路径必须与 debugpy 看到的路径一致（本文件相对仓库根路径）。
- 需要 debugpy 已安装：`pip install debugpy`。
