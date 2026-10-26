# 阿里云百炼余额与代金券 · Codex 插件

在 Codex 中只读查询阿里云账户余额与现金代金券。使用只读 RAM AccessKey，通过阿里云 BSS OpenAPI 获取账户级数据，并在对话中以中文摘要和紧凑明细卡片展示。

> 这里的“百炼余额”指阿里云账户级可用金额与现金券，不包含百炼 Token 配额、模型调用量或消费账单。

## 功能

- 查询账户级**可用金额、现金余额、信控额度**及币种。
- 查询**现金代金券**：可用、已过期、已作废数量，可用券余额、面额合计、最近到期时间，并列出最多 5 张可用券明细。
- 同时返回中文摘要与结构化明细，便于继续分析。
- 两个接口并行请求，单个接口失败时仍返回另一部分结果。
- 10 秒请求超时，30 秒内存缓存。
- 凭据只从系统环境变量读取，不保存、不回显，也不接受聊天中粘贴的 AccessKey。
- 零 npm 依赖，基于 Node.js 内置模块实现。

## 数据边界

| 项目 | 说明 |
| --- | --- |
| 接口 | 阿里云 BSS OpenAPI `2017-12-14` |
| 固定地址 | `https://business.aliyuncs.com/` |
| 查询动作 | `QueryAccountBalance`、`QueryCashCoupons` |
| 数据范围 | 阿里云账户级余额与现金代金券 |
| 不包含 | 百炼 Token 配额、模型消费明细、账单趋势、充值记录 |

账户余额与代金券余额会**分开展示**，不会相加成一个“总余额”，也不会把账户可用金额描述成百炼专属额度。

## 环境要求

- Codex 桌面版或 Codex CLI。
- Node.js **>= 22**（本项目已在 `v24.22.1` 上验证）。
- 一个已授予 `AliyunBSSReadOnlyAccess` 权限的 RAM 用户 AccessKey。
- 不需要执行 `npm install`。

## 安全模型

1. 服务端只读取两个环境变量：

   ```text
   ALIYUN_ACCESS_KEY_ID
   ALIYUN_ACCESS_KEY_SECRET
   ```

2. 插件配置只透传变量名，不包含任何密钥值：

   ```json
   "env_vars": ["ALIYUN_ACCESS_KEY_ID", "ALIYUN_ACCESS_KEY_SECRET"]
   ```

3. MCP 工具不接受凭据参数。聊天中传入的任何 AccessKey 都会被忽略。
4. 请使用**只读 RAM 用户**，并只授予 `AliyunBSSReadOnlyAccess`。不要使用阿里云主账号 AccessKey。
5. 服务端不会把 AccessKey、AccessKey Secret、`Authorization`、签名或阿里云原始错误正文写入输出或日志。
6. 缓存键是 AK/SK 的 SHA-256 指纹，内存中不保存明文凭据。
7. 插件固定访问阿里云官方 BSS 地址，不提供 endpoint 或写操作配置。

## 创建 RAM 用户与 AccessKey

1. 登录阿里云控制台，进入 **RAM 访问控制 → 用户**，创建一个专用 RAM 用户（建议只用于本插件）。
2. 为该用户授予系统策略 `AliyunBSSReadOnlyAccess`。
3. 为该用户创建 AccessKey，并妥善保存 AccessKey Secret。
4. 不要给该用户授予写权限，也不要用主账号 AccessKey 代替。

## 配置系统环境变量（Windows）

推荐通过图形界面设置，避免密钥进入命令历史：

1. 按 `Win + R`，输入 `sysdm.cpl` 并回车。
2. 打开 **高级 → 环境变量**。
3. 在“用户变量”中新建：
   - `ALIYUN_ACCESS_KEY_ID`
   - `ALIYUN_ACCESS_KEY_SECRET`
4. 保存后**完全退出 Codex**（包括托盘中的进程），再重新启动，让新进程继承环境变量。
5. 不要在聊天、截图或日志中粘贴密钥。

macOS / Linux 可以在启动 Codex 的 shell 配置文件中导出这两个变量，同样需要重启 Codex。

## 安装插件

在 PowerShell 中执行：

```powershell
codex plugin marketplace add C:\Users\atlan\Desktop\aliyun-bailian-balance-codex
codex plugin add aliyun-bailian-balance@aliyun-bailian-tools
```

安装完成后再次完全退出并重启 Codex。新建对话，询问：

> 查询我的阿里云账户余额和可用代金券

Codex 应调用 `get_aliyun_overview` 工具并返回中文摘要。

可以用下面的命令检查插件是否已登记：

```powershell
codex plugin list --available
```

## 工具与返回结构

工具名：`get_aliyun_overview`，无输入参数。

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

金额统一为两位小数人民币字符串。字段缺失时按 `0.00` 处理，并在中文摘要中如实展示接口是否缺失。

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

当前测试覆盖 35 项，包括：

- ACS3-HMAC-SHA256 签名黄金用例；
- 金额精确到分、缺失字段与状态过滤；
- 到期排序和 30 秒缓存；
- 10 秒超时与单接口降级；
- 缺少凭据、权限不足、签名错误、网络失败的中文提示；
- 输出与日志不含 AK/SK、`Authorization` 或签名字段；
- MCP `initialize`、`tools/list`、`tools/call` 协议流程。

## 目录结构

```text
aliyun-bailian-balance-codex/
├─ .agents/plugins/marketplace.json      # 本地 marketplace
├─ plugins/aliyun-bailian-balance/
│  ├─ .codex-plugin/plugin.json          # Codex 插件清单
│  ├─ .mcp.json                          # MCP 配置（仅透传凭据变量名）
│  ├─ plugin.json                        # 便携插件清单
│  ├─ mcp.json                           # 便携 MCP 配置
│  ├─ skills/aliyun-balance/SKILL.md     # 调用规则与中文展示规范
│  ├─ server/                            # 零依赖 MCP 服务端
│  └─ test/                              # node:test 测试
├─ package.json
├─ LICENSE
└─ README.md
```

## 常见问题

**提示缺少凭据**

确认系统环境变量名称完全正确，并且是在启动 Codex 之前设置的。设置后需要完全退出并重启 Codex。

**提示 AccessKey 无效或签名错误**

检查 RAM 用户的 AccessKey 状态、Secret 是否复制完整，以及本机系统时间是否准确。

**提示权限不足**

确认 RAM 用户已授予 `AliyunBSSReadOnlyAccess`。

**提示网络或超时**

检查网络、代理、防火墙和 DNS；工具默认 10 秒超时。

**查询结果与百炼控制台不完全一致**

本插件查询的是阿里云账户级余额和现金券，不是百炼 Token 配额或模型消费明细。两者口径不同。

## v1 范围

不包含：消费趋势、账单明细、百炼 Token 用量、自定义 UI、凭据管理页面、自动远端发布。

## License

MIT。详见 [LICENSE](LICENSE)。
