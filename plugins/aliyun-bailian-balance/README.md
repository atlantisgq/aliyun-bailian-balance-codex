# 阿里云余额与代金券

Codex 插件：在 Codex 左侧提供常驻的余额面板，通过只读 RAM AccessKey 查询阿里云账户级余额与现金代金券。

- 全局面板：`ui://aliyun-bailian-balance/dashboard`
- 查询工具：`get_aliyun_overview`
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

**不需要系统属性，也不需要环境变量。**

1. 安装插件后完整退出并重新打开 Codex 一次。
2. 打开左侧「阿里云余额与代金券」。
3. 填入只读 RAM AccessKey ID 和 AccessKey Secret，保存。

保存后会立即查询。更换或清除密钥都不需要重启。

密钥在 Windows 上使用当前用户的 DPAPI 加密，保存在
`%LOCALAPPDATA%\aliyun-bailian-balance\credentials.json`，只有当前 Windows 用户能解密。密钥不会进入命令行参数、日志或 MCP 返回值，也不会在面板中回显。

系统环境变量 `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET` 仅作为可选兼容后备；面板凭据优先。

请使用授予了 `AliyunBSSReadOnlyAccess` 的 RAM 用户 AccessKey，不要使用主账号 AccessKey，也不要在聊天中粘贴密钥。

## 安装

把仓库克隆到本地后，在仓库根目录执行：

```powershell
git clone https://github.com/atlantisgq/aliyun-bailian-balance-codex.git
cd aliyun-bailian-balance-codex
codex plugin marketplace add .
codex plugin add aliyun-bailian-balance@aliyun-bailian-tools
```

然后完整退出并重启 Codex 一次。
## 使用

打开左侧「阿里云余额与代金券」面板即可查看；也可以直接说：

> 查询我的阿里云余额和可用代金券

Codex 会调用 `get_aliyun_overview`，并固定使用中文摘要：

1. 数据时间；
2. 账户余额（可用金额、现金余额、信控额度）；
3. 代金券（数量、可用余额、面额、最近到期、明细）；
4. 部分失败时的查询提示；
5. 账户级数据边界说明。

## 工具

| 工具 | 作用 |
| --- | --- |
| `get_aliyun_overview` | 查询账户余额与现金代金券 |
| `get_credential_status` | 面板内部：查看是否已配置凭据（不返回密钥） |
| `save_aliyun_credentials` | 面板内部：保存或替换只读 RAM AccessKey |
| `clear_aliyun_credentials` | 面板内部：清除本机保存的凭据 |
| `open_aliyun_dashboard` | 面板内部：打开全局面板 |

## 行为说明

- 两个查询并行执行。
- 单个接口失败仍返回另一部分，`ok: true` 并在 `errors` 中说明。
- 两个接口都失败或缺少凭据时返回 `isError: true`。
- 请求超时 10 秒；结果缓存 30 秒。
- 输出经过脱敏，不包含 AccessKey、Secret、`Authorization`、签名或阿里云原始错误正文。
- 查询工具为只读：`readOnlyHint: true`、`destructiveHint: false`、`idempotentHint: true`、`openWorldHint: true`。
- 面板无外部资源、无浏览器持久化存储、无动态 HTML 注入，只接受 Codex 宿主消息。

## 测试

在仓库根目录执行：

```powershell
node --test plugins/aliyun-bailian-balance/test/*.test.js
```

## 常见问题

| 提示 | 处理 |
| --- | --- |
| 左侧没有面板 | 完整退出并重新打开 Codex 一次 |
| 缺少凭据 | 打开左侧面板，填入 AccessKey 并保存 |
| AccessKey 无效 | 检查 RAM AccessKey 状态，可在面板中替换 |
| 签名错误 | 核对 Secret 与本机系统时间 |
| 权限不足 | 授予 `AliyunBSSReadOnlyAccess` |
| 网络或超时 | 检查代理、防火墙、DNS 后重试 |

## License

MIT

