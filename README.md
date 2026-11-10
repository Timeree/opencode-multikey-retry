# opencode-multikey-retry

OpenCode V2 多 API key 重试插件：请求失败时换下一个可用 key 重发；`401` / `403` 的 key 持久隔离，不再参与轮换。

## 配置

`opencode.json` 的 `plugins` 里登记插件路径即可，无需 options：

```jsonc
{
  "plugins": ["/path/to/opencode-multikey-retry"]
}
```

key 池与隔离记录在独立配置文件中，路径为 `$XDG_CONFIG_HOME`（缺省 `~/.config`）下 `opencode/opencode-multikey-retry.json`：

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

- `apiKeys`：键名为 provider ID，至少 2 个 key 才接管该 provider；改动重启 OpenCode 后生效
- `isolated`：插件在 `401` / `403` 时自动写入；删除其中的条目并重启即可人工恢复
- 失败的 key 进入冷却退避，池中其它 key 冷却顺延 1s，到期换下一个 key 重发

## 开发

```sh
npm install
npm run typecheck
npm test
```
