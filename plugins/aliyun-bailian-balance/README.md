# 阿里云余额与代金券

Codex 插件：通过只读 RAM AccessKey 查询阿里云账户级余额与现金代金券，在对话中返回中文摘要和紧凑明细。

- 工具：`get_aliyun_overview`
- 接口：阿里云 BSS OpenAPI `2017-12-14`
- 地址：`https://business.aliyuncs.com/`
- 权限：只读（`AliyunBSSReadOnlyAccess`）
- 依赖：Node.js >= 22，无需 npm 安装

## 能查什么

- 账户可用金额、现金余额、信控额度、币种。
- 现金代金券的可用 / 过期 / 作废数量。
- 可用券余额、面额合计、最近到期时间与最多 5 张明细。

账户余额与代金券余额分开展示。**不包含**百炼 Token 配额、模型消费明细或账单趋势。

## 配置凭据

只从系统环境变量读取：

```text
ALIYUN_ACCESS_KEY_ID
ALIYUN_ACCESS_KEY_SECRET
```

Windows 推荐通过 `sysdm.cpl → 高级 → 环境变量` 在“用户变量”中设置，避免密钥进入命令历史。配置后完全退出并重启 Codex。

请使用授予了 `AliyunBSSReadOnlyAccess` 的 RAM 用户 AccessKey，不要使用主账号 AccessKey。不要在聊天中粘贴密钥。

## 安装

在仓库根目录执行：

```powershell
codex plugin marketplace add C:\Users\atlan\Desktop\aliyun-bailian-balance-codex
codex plugin add aliyun-bailian-balance@aliyun-bailian-tools
```

然后完全退出并重启 Codex。

## 使用

直接说：

> 查询我的阿里云余额和可用代金券

或：

> 看看代金券最近什么时候到期

Codex 会调用 `get_aliyun_overview`，并固定使用中文摘要：

1. 数据时间；
2. 账户余额（可用金额、现金余额、信控额度）；
3. 代金券（数量、可用余额、面额、最近到期、明细）；
4. 部分失败时的查询提示；
5. 账户级数据边界说明。

## 行为说明

- 两个查询并行执行。
- 单个接口失败仍返回另一部分，`ok: true` 并在 `errors` 中说明。
- 两个接口都失败或缺少凭据时返回 `isError: true`。
- 请求超时 10 秒；结果缓存 30 秒。
- 输出经过脱敏，不包含 AccessKey、Secret、`Authorization`、签名或阿里云原始错误正文。
- 工具为只读：`readOnlyHint: true`、`destructiveHint: false`、`idempotentHint: true`、`openWorldHint: true`。

## 测试

在仓库根目录执行：

```powershell
node --test plugins/aliyun-bailian-balance/test/*.test.js
```

## 常见问题

| 提示 | 处理 |
| --- | --- |
| 缺少凭据 | 设置两个环境变量后完全重启 Codex |
| AccessKey 无效 | 检查 RAM AccessKey 状态，必要时重新创建 |
| 签名错误 | 核对 Secret 与本机系统时间 |
| 权限不足 | 授予 `AliyunBSSReadOnlyAccess` |
| 网络或超时 | 检查代理、防火墙、DNS 后重试 |

## License

MIT
