# 阿里云百炼余额与代金券 · Codex 插件

在 Codex 左侧提供一个常驻的「阿里云余额与代金券」面板，直接查看阿里云账户余额和现金代金券，无需每次在对话里发问。使用只读 RAM AccessKey，通过阿里云 BSS OpenAPI 获取账户级数据。

> 这里的「百炼余额」指阿里云账户级可用金额与现金券，不包含百炼 Token 配额、模型调用量或消费账单。

## 功能

- Codex 左侧**全局面板**：打开 Codex 即可查看，不用每次发消息查询。
- 面板内填写、替换、清除只读 RAM AccessKey；**保存后自动查询，无需重启**。
- Windows 使用当前用户的 **DPAPI** 加密保存密钥，不需要再去系统属性配置环境变量。
- 查询账户级**可用金额、现金余额、信控额度**及币种。
- 查询**现金代金券**：可用、已过期、已作废数量，可用券余额、面额合计、最近到期时间，并列出最多 5 张可用券明细。
- 同时提供中文摘要与结构化数据，面板支持明暗主题和窄窗口布局。
- 两个接口并行请求，单个接口失败时仍返回另一部分结果。
- 10 秒请求超时，30 秒内存缓存。
- 零 npm 依赖，基于 Node.js 内置模块实现。

## 数据边界

| 项目 | 说明 |
| --- | --- |
| 接口 | 阿里云 BSS OpenAPI `2017-12-14` |
| 固定地址 | `https://business.aliyuncs.com/` |
| 查询动作 | `QueryAccountBalance`、`QueryCashCoupons` |
| 数据范围 | 阿里云账户级余额与现金代金券 |
| 不包含 | 百炼 Token 配额、模型消费明细、账单趋势、充值记录 |

账户余额与代金券余额会**分开展示**，不会相加成一个「总余额」，也不会把账户可用金额描述成百炼专属额度。

## 环境要求

- Codex 桌面版（支持插件全局面板的版本）。
- Node.js **>= 22**（本项目已在 `v24.22.1` 上验证）。
- 一个已授予 `AliyunBSSReadOnlyAccess` 权限的 RAM 用户 AccessKey。
- 不需要执行 `npm install`。

## 安装

把仓库克隆到本地（也可以直接用已下载的目录）：

```powershell
git clone https://github.com/atlantisgq/aliyun-bailian-balance-codex.git
cd aliyun-bailian-balance-codex
```

然后注册本地 marketplace 并安装插件：

```powershell
codex plugin marketplace add .
codex plugin add aliyun-bailian-balance@aliyun-bailian-tools
```

安装完成后**完整退出并重新打开 Codex 一次**，让面板入口注册生效。之后更换或清除密钥都不再需要重启。
## 配置凭据

**不需要系统属性，也不需要设置环境变量。**

1. 打开 Codex 左侧的「阿里云余额与代金券」。
2. 在面板中填入只读 RAM 用户的 AccessKey ID 和 AccessKey Secret。
3. 点击保存。插件会立即发起一次只读查询。

密钥处理方式：

- Windows：使用 **DPAPI（CurrentUser）** 加密后保存到
  `%LOCALAPPDATA%\aliyun-bailian-balance\credentials.json`，只有当前 Windows 用户能解密。
- 密钥不进入命令行参数、日志、MCP 返回值或面板回显。
- 面板提供「替换密钥」和「清除密钥」；清除后不会残留明文。

系统环境变量 `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET` 仅作为**可选兼容方式**保留：面板中没有保存密钥时才会读取它们。已有面板配置时优先使用面板保存的凭据。

## 创建 RAM 用户与 AccessKey

1. 登录阿里云控制台，进入 **RAM 访问控制 → 用户**，创建一个专用 RAM 用户（建议只用于本插件）。
2. 为该用户授予系统策略 `AliyunBSSReadOnlyAccess`。
3. 为该用户创建 AccessKey，并妥善保存 AccessKey Secret。
4. 不要给该用户授予写权限，也不要用主账号 AccessKey 代替。

## 安全模型

1. 凭据只从面板保存的加密文件或可选环境变量读取。
2. MCP 工具不接受聊天中粘贴的凭据；聊天参数中的 AccessKey 会被忽略。
3. 服务端不会把 AccessKey、AccessKey Secret、`Authorization`、签名或阿里云原始错误正文写入输出或日志。
4. 缓存键是 AK/SK 的 SHA-256 指纹，内存中不保存明文凭据。
5. 插件固定访问阿里云官方 BSS 地址，不提供 endpoint 或写操作配置。
6. 面板页面无外部资源、无 `localStorage` / `sessionStorage`、无动态 HTML 注入，只接受来自 Codex 宿主的消息。

## 使用面板

- 首次打开且尚未保存密钥时，面板显示配置表单。
- 保存成功后立即展示账户余额、代金券统计和可用券明细。
- 右上角可手动刷新；30 秒内重复刷新会命中缓存。
- 可随时替换或清除密钥，操作立即生效。
- 查询失败时显示可操作的中文提示，不会输出阿里云原始错误正文。

也可以在对话中询问：

> 查询我的阿里云账户余额和可用代金券

Codex 会调用 `get_aliyun_overview`，并按中文紧凑明细展示。

## 工具

| 工具 | 作用 |
| --- | --- |
| `get_aliyun_overview` | 查询账户余额与现金代金券（无输入参数） |
| `get_credential_status` | 面板内部：查看是否已配置凭据（不返回密钥） |
| `save_aliyun_credentials` | 面板内部：保存或替换只读 RAM AccessKey |
| `clear_aliyun_credentials` | 面板内部：清除本机保存的凭据 |
| `open_aliyun_dashboard` | 面板内部：打开全局面板资源 `ui://aliyun-bailian-balance/dashboard` |

`get_aliyun_overview` 的只读注解：`readOnlyHint: true`、`destructiveHint: false`、`idempotentHint: true`、`openWorldHint: true`。

成功时返回：

```json
{
  "ok": true,
  "fetchedAt": "2026-10-26T08:00:00.000Z",
  "cached": false,
  "accountBalance": {
    "currency": "CNY",
    "availableAmount": "123.45",
    "cashAmount": "100.00",
    "creditAmount": "0.00"
  },
  "cashCoupons": {
    "counts": {
      "total": 3,
      "available": 2,
      "expired": 1,
      "cancelled": 0,
      "other": 0
    },
    "availableCount": 2,
    "availableBalance": "50.00",
    "availableNominalValue": "60.00",
    "nearestExpiryTime": "2026-12-31T15:59:59.000Z",
    "items": []
  },
  "errors": []
}
```

金额统一为两位小数人民币字符串，内部按分计算，避免浮点误差。字段缺失时按 `0.00` 处理，并在中文摘要中如实展示接口是否缺失。

## 部分失败与错误处理

- **只有一个接口成功**：返回 `ok: true`，`errors` 中说明缺失的是账户余额还是代金券。
- **两个接口都失败，或未配置凭据**：MCP 返回 `isError: true`，并给出可操作的中文提示。
- 覆盖的提示包括：缺少凭据、AccessKey 无效、签名错误、RAM 权限不足、请求超时、网络不可达、阿里云限流或服务不可用。
- 阿里云原始错误正文不会出现在输出中。

## 测试

在仓库根目录执行：

```powershell
node --test plugins/aliyun-bailian-balance/test/*.test.js
```

当前测试共 49 项（48 项通过，1 项 Windows DPAPI 集成测试默认跳过），覆盖：

- ACS3-HMAC-SHA256 签名黄金用例；
- 金额精确到分、缺失字段与状态过滤；
- 到期排序和 30 秒缓存；
- 10 秒超时与单接口降级；
- 缺少凭据、权限不足、签名错误、网络失败的中文提示；
- 输出与日志不含 AK/SK、`Authorization` 或签名字段；
- 凭据保存、读取、替换、清除与缓存失效；
- 面板无外部资源、无持久化存储、消息来源校验；
- MCP `initialize`、`tools/list`、`tools/call` 协议流程。

在正常 Windows 用户上下文中运行 DPAPI 集成测试：

```powershell
$env:ALIYUN_TEST_DPAPI = "1"
node --test plugins/aliyun-bailian-balance/test/credentials.test.js
```

## 目录结构

```text
aliyun-bailian-balance-codex/
├─ .agents/plugins/marketplace.json      # 本地 marketplace
├─ plugins/aliyun-bailian-balance/
│  ├─ .codex-plugin/plugin.json          # Codex 插件清单
│  ├─ .mcp.json                          # Codex MCP 配置
│  ├─ plugin.json                        # 便携插件清单
│  ├─ mcp.json                           # 便携 MCP 配置
│  ├─ skills/aliyun-balance/SKILL.md     # 调用规则与中文展示规范
│  ├─ server/                            # 零依赖 MCP 服务端
│  ├─ ui/dashboard.html                  # 全局余额面板
│  └─ test/                              # node:test 测试
├─ package.json
├─ LICENSE
└─ README.md
```

## 常见问题

**左侧没有出现面板**

确认插件已安装，然后完整退出 Codex（包括后台进程）并重新打开一次。

**提示需要配置凭据**

打开左侧「阿里云余额与代金券」面板，在面板内填写 AccessKey 并保存。不要在聊天里粘贴密钥。

**提示 AccessKey 无效或签名错误**

检查 RAM 用户的 AccessKey 状态、Secret 是否复制完整，以及本机系统时间是否准确。可在面板中替换密钥。

**提示权限不足**

确认 RAM 用户已授予 `AliyunBSSReadOnlyAccess`。

**提示网络或超时**

检查网络、代理、防火墙和 DNS；工具默认 10 秒超时。

**查询结果与百炼控制台不完全一致**

本插件查询的是阿里云账户级余额和现金券，不是百炼 Token 配额或模型消费明细。两者口径不同。

## License

MIT。详见 [LICENSE](LICENSE)。

