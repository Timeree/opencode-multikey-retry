# opencode-multikey-retry

## 配置文件

路径：`$XDG_CONFIG_HOME`（缺省 `~/.config`）下 `opencode/opencode-multikey-retry.json`。插件启动时读取一次，改动后需重启 OpenCode 生效。

```jsonc
{
  "apiKeys": {
    "provider": ["sk-xxx", "sk-yyy"]
  },
  "isolated": {
    "provider": ["sk-zzz"]
  }
}
```

- `apiKeys`：键名为 provider ID，值为该 provider 的 key 列表。值会去空白、去重、剔除非字符串项；去重后不足 2 个 key 的 provider 不接管。
- `isolated`：`401` / `403` 时插件自动写入的隔离列表。隔离的 key 不参与轮换；删除其中的条目并重启即可人工恢复。
- 文件缺失：视为空配置，插件不接管任何 provider。
- 文件损坏（JSON 解析失败）：按空配置启动（记警告日志），不覆盖原文件。
- 写入：先写同目录临时文件，再原子 `rename`，避免中途崩溃留下截断的 JSON。

## 钩子

对每个接管的 provider，插件在 `session` 上注册三个钩子（按 providerID 过滤），全部只接管 `primary` 请求；旁路请求（compaction / title / generate）不受影响。

- `http.request`：把请求里的凭据换成当前应当使用的 key。首轮、或请求不在接管范围时原样放行。识别的凭据头（保留 scheme 前缀，如 `Bearer`）：`Authorization`、`x-api-key`、`api-key`、`x-goog-api-key`、`anthropic-api-key`、`x-stainless-api-key`。
- `http.response`：读取响应状态码与 `Retry-After`，记录到本轮状态。`2xx` 视为本轮结束，清理本轮状态；未接管的状态码不记录。
- `retry`：决定本次重试是否接管、延迟多久、换用哪个 key。

## 退避与隔离

- `401` / `403`（且请求失败时池内 ≥ 2 个可用 key）：失败 key 置为永久冷却并写入 `isolated`，随后从轮换池剔除。
- 其它可处理的失败（`429`、`5xx`、transport 类失败）：失败 key 按 `3 × 1.5^(n-1)` 秒退避，上限 1200s；`429` 优先采用 `Retry-After` 给出的时长（不截断）。`n` 为本轮连续失败次数。
- 池中其它 key 同步顺延 1s，避免原生调度立刻拿下一个 key 撞上。
- 冷却期间让出下一个可用 key 重发；池内全部在冷却时，把等待交给原生调度，到期后由请求侧放行。
- `transport` 类失败（`provider.transport` / `provider.timeout`）：锁定本轮 key 原样重发，不换 key。
- `400` / `provider.invalid-request`：不接管，直接判定放弃重试（`retry: false`）并结束本轮。
- 未接管的状态（如 `404`）：不设冷却、不计数，原生决策原样返回。
- 本轮按 `(sessionID, providerID, modelID)` 归类；新一轮（attempt 回落）或 30 分钟无活动时重置。最多保留 512 轮。
