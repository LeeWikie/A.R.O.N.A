# A.R.O.N.A

让电脑成为什亭之匣，里面住着阿罗娜。

A.R.O.N.A 是一个围绕《蔚蓝档案》阿罗娜构建的个人 AI 伴侣项目，以“什亭之匣的管理者”为角色定位。

当前提供本地核心和终端客户端，支持文字交互、外部事件输入、定时职责、独立 Markdown 产物保存和会话历史查询。核心只监听 `127.0.0.1`，终端关闭后已受理的工作继续运行。

## 运行

需要 Node.js 24 和 pnpm。

```powershell
pnpm install
Copy-Item .env.example .env
```

在 `.env` 中填写模型配置：

| 变量 | 内容 |
| --- | --- |
| `ARONA_MODEL_PROTOCOL` | `chat-completions`、`responses` 或 `messages` |
| `ARONA_MODEL_BASE_URL` | 兼容接口的基础地址，通常以 `/v1` 结尾 |
| `ARONA_MODEL_ID` | 模型名称 |
| `ARONA_MODEL_API_KEY` | 接口凭据 |

Messages 默认使用 `x-api-key`；需要 Bearer 认证时设置 `ARONA_MODEL_AUTH_HEADER=bearer`。模型和协议必须由所用接口支持。

Chat Completions 和 Responses 可通过 `ARONA_MODEL_REASONING_EFFORT` 显式传递推理等级；未设置时不发送该参数。此项不适用于 Messages。

分别在两个终端启动：

```powershell
pnpm dev
```

```powershell
pnpm cli
```

输入 `/quit` 退出对话。默认数据保存在用户目录下的 `.arona`；可用 `ARONA_DATA_DIR` 修改目录，用 `ARONA_PORT` 修改核心端口。客户端可用 `ARONA_CORE_URL` 指定核心地址、`ARONA_CONTEXT_ID` 选择上下文。

## 消息与产物

```powershell
pnpm cli send "你好"
pnpm cli event "资料整理已完成，请保存一份简短记录。"
pnpm cli watch artifact
pnpm cli outputs artifact
pnpm cli history
pnpm cli run <运行ID>
pnpm cli signal <信号ID>
```

消息和独立产物分别读取。观察客户端保存读取游标，重连后继续读取；`outputs` 可从指定游标重新查询，`history` 可按页读取。

重启保留会话和已保存的产物。在途执行标记为中断，不自动重跑。会话历史保存不等同于长期记忆整理；目前没有接入个人聊天记录、浏览记录或系统监测。

## 定时职责

可以直接在对话中安排任务，例如“十分钟后提醒我休息”“每天晚上九点整理当前对话中能看到的内容，保存为 Markdown”。也可以查询安排、修改时间或内容、暂停、恢复、取消，以及立即执行一次。执行能力取决于当前可用工具；目前没有系统操作或外部资料读取工具。

支持一次性时间、从指定起点计算的固定间隔，以及按时区重复的日历时间。默认使用运行环境的时区，可用 `ARONA_TIMEZONE` 指定 IANA 时区，例如 `Asia/Shanghai`。职责保存自己的时区，不随之后的默认设置改变。

核心需要保持运行才能到点执行。停机或暂停期间错过的时间不补跑，错过的一次性安排显示为过期。运行期间即使上一项还没结束，下一次仍会触发。修改、暂停和取消影响后续触发，已经提交的工作继续执行；立即执行不改变原有节奏。

每次触发都能查看受理情况、关联执行、职责报告和产物。没有报告结果的执行不会显示为职责成功。独立产物仍通过产物出口查看。

终端调试入口：

```powershell
pnpm cli schedules list
pnpm cli schedules get <职责ID>
pnpm cli schedules history <职责ID>
pnpm cli schedules run <职责ID>
pnpm cli schedules pause <职责ID> <revision>
pnpm cli schedules resume <职责ID> <revision>
pnpm cli schedules cancel <职责ID> <revision>
pnpm cli schedules create '@schedule.json'
pnpm cli schedules update <职责ID> '@patch.json'
```

创建 JSON 包含 `name`、`task` 和 `timing`，可选 `contextId`、`timezone` 和 `output`。`timing` 有三种形式：`{ "kind": "once", "at": "2027-01-01T09:00:00+08:00" }`、`{ "kind": "interval", "anchorAt": "2027-01-01T09:00:00+08:00", "everyMs": 3600000 }`、`{ "kind": "cron", "expression": "0 9 * * *" }`。固定间隔至少一秒；首次时间是起点上第一个未来时间点。

修改 JSON 只填写需修改的字段和查询得到的 `revision`。版本过期时返回冲突，重新查询后再修改。职责默认允许 `output.kind=both`，也可限定 `message` 或 `artifact`；可用 `output.contextId` 指定交付上下文。

## HTTP 接口

默认地址为 `http://127.0.0.1:4111`。

| 接口 | 功能 |
| --- | --- |
| `POST /signals` | 提交用户消息或外部事件 |
| `GET /signals/:id` | 查询受理记录与运行关联 |
| `GET /runs/:id` | 查询运行状态 |
| `GET /outputs?after=0&kind=message` | 按游标读取消息；`kind=artifact` 读取产物 |
| `GET /contexts/:id/history?page=0&perPage=40` | 分页读取历史 |
| `GET /health` | 就绪状态 |
| `POST /schedules`、`GET /schedules` | 创建或列出职责；列表可按 `contextId` 筛选，并返回当前时间与默认时区 |
| `GET /schedules/:id`、`PATCH /schedules/:id` | 查询或修改职责；修改需要 `revision` |
| `POST /schedules/:id/pause`、`resume`、`cancel` | 控制后续触发；正文为 `{ "revision": 1 }` |
| `POST /schedules/:id/run` | 立即执行一次 |
| `GET /schedules/:id/occurrences?offset=0&limit=40` | 分页读取触发记录及结果 |

提交内容包含 `source`、`type`（`user-message` 或 `external-event`）和 `content`。可指定 UUID `id`、`contextId` 和 `output: { kind, contextId }`；未指定时用户消息输出为消息，外部事件输出为产物。相同 ID 与内容重复提交返回原记录，修改内容后复用 ID 会被拒绝。

职责变更和立即执行接口支持可选 `Idempotency-Key` 请求头（1–128 个字母、数字、下划线、点或连字符）。重试时沿用同一个键，同一键用于不同内容会被拒绝。取消保留职责和触发历史。

## 检查

```powershell
pnpm typecheck
pnpm build
pnpm test
```

本地配置好模型后，可运行 `pnpm test:live` 检查真实消息与产物处理。此命令会调用配置的模型，普通测试使用合成数据和本地模拟接口。
