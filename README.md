# ShittimChest

让电脑成为什亭之匣，里面住着阿罗娜。

ShittimChest 是围绕《蔚蓝档案》阿罗娜构建的个人 AI 伴侣项目。当前提供独立运行的本地核心、交互式 TUI 和非交互 CLI：文字交流、后台任务与持续上下文、文件和终端操作、网页读取与可配置检索、MCP、定时职责、记忆整理，以及可复用的 Skill 和文件校验工作流。

核心只监听 `127.0.0.1`。退出终端对话不会停止核心或已受理的后台工作；关闭核心则会停止执行。当前没有桌面界面、语音、屏幕或鼠标键盘控制，也不会自动接入个人聊天、邮箱、浏览记录或系统监测。

## 启动

需要 **Node.js 24** 和 pnpm。

```powershell
pnpm install
pnpm build
pnpm cli
```

在交互终端中默认打开 TUI；它会连接已有核心，必要时启动独立核心。没有模型时可先从管理菜单添加配置，配置后再进行交流或派发工作。退出 TUI 不会停止核心。

编译后也可直接运行 `node dist/cli.js`。本地安装包提供 `shittimchest` 和兼容命令 `arona`；`shittimchest-core` 单独启动核心。Windows x64 编译包包含文件搜索工具及其许可证，无需另外安装 fd。

```powershell
pnpm cli help
pnpm cli status
pnpm cli --plain
```

`--plain` 使用普通文本交互；非交互环境继续保留 CLI 子命令。需要自行启动服务时可运行 `pnpm dev`，或在编译后运行 `pnpm start`。使用 `.env` 启动参数时先复制 `.env.example`；pnpm 脚本会读取它，直接运行编译入口则需用 Node 的 `--env-file-if-exists=.env` 参数显式加载。

### 配置模型

可在 `.env` 中填写以下四项，再重启核心：

| 变量 | 内容 |
| --- | --- |
| `SHITTIMCHEST_MODEL_PROTOCOL` | `chat-completions`、`responses` 或 `messages` |
| `SHITTIMCHEST_MODEL_BASE_URL` | 服务的基础地址，通常以 `/v1` 结尾 |
| `SHITTIMCHEST_MODEL_ID` | 所用服务实际支持的模型名称 |
| `SHITTIMCHEST_MODEL_API_KEY` | 接口凭据 |

不能仅凭模型名称推断协议。Messages 默认使用 `x-api-key`；需要 Bearer 时设置 `SHITTIMCHEST_MODEL_AUTH_HEADER=bearer`。Chat Completions 和 Responses 可用 `SHITTIMCHEST_MODEL_REASONING_EFFORT` 显式指定等级；此启动参数不适用于 Messages。

也可以在运行中添加命名配置。先安全输入凭据：

```powershell
pnpm cli credentials set MODEL_KEY
```

TTY 下输入隐藏；脚本可通过标准输入传入，不接受把密钥放进命令参数。保存以下内容为 `model.json`，将地址和模型名替换为实际值：

```json
{
  "id": "default",
  "name": "常用模型",
  "protocol": "chat-completions",
  "baseURL": "http://127.0.0.1:8000/v1",
  "modelId": "your-model-id",
  "apiKeyEnv": "MODEL_KEY"
}
```

```powershell
pnpm cli models save '@model.json'
pnpm cli contexts model main default
pnpm cli
```

输入 `/quit` 退出对话。命名配置的 `apiKeyEnv` 引用已保存的凭据或同名环境变量，配置查询不返回密钥。删除本地凭据不会删除进程已有的环境变量；环境回退仍有效时会在响应中说明。

思考等级需要按服务协议配置映射，不保证每种模型都支持所有等级。例如 Responses 配置可添加 `"thinking": { "high": { "reasoningEffort": "high" } }`，再执行 `pnpm cli contexts model main default high`。Messages 使用其自身的 `thinking`／`effort` 参数。当前运行保留已选择的模型和选项，变更在下一次运行采用；切换到不支持原等级的配置时清除该覆盖。

## 终端交互

`/help` 列出命令，`/menu` 打开管理菜单，`/quit` 退出。忙时发送可选择补充当前运行或排队下一次运行；`Alt+Enter`（或 `Ctrl+Q`）直接排队。排队消息显示在输入框上方，`Alt+↑`（或 `Alt+Q`）把尚未开始的排队消息全部撤回到输入框，`/queue` 可逐条查看、编辑或撤回。编辑会保留原记录，并将替代输入追加到队尾。迟到的补充与中断请求不会作用于后继运行。

交流上下文与后台工作上下文分开：前者可以直接聊天，后者通过任务管理补充和控制。在成功完成的对话轮次上可建立独立分支；原上下文不被改写，分支保留来源，不继承在途任务或审批。

模型管理支持供应商目录、授权入口和受模型实际能力约束的思考等级。配置默认等级与当前会话覆盖分开；选择配置默认会清除当前会话覆盖。密钥输入不回显，查询不返回密钥值。由启动参数提供的模型也可回填为命名配置；其中的启动凭据引用只有在该核心仍有对应启动凭据时可用。

网页读取默认只访问公开 HTTP(S) 地址，网页正文作为外部资料处理。检索需要从管理菜单配置 Brave 凭据引用或公开 SearXNG 地址；未配置时不会伪造搜索结果。工具执行仍遵循任务权限与审批。

## 后台任务与上下文

可以直接交谈、交代工作、补充要求或询问进展。后台任务有自己的标识和工作上下文；持续工作可以复用上下文，不必每次寻找旧会话。

也可直接使用管理命令：

```powershell
pnpm cli tasks create "读取工作区中的 input.txt，检查内容并报告结果。"
pnpm cli tasks list
pnpm cli tasks get <任务ID>
pnpm cli tasks message <任务ID> "补充：请一并检查编码。"
pnpm cli tasks pause <任务ID> <revision>
pnpm cli tasks resume <任务ID> <revision>
pnpm cli tasks cancel <任务ID> <revision>
pnpm cli tasks retry <任务ID> <revision>
pnpm cli contexts list
pnpm cli history
```

向已有后台工作补充内容使用 `tasks message`；普通消息入口不会直接启动工作上下文。

JSON 参数支持 `@文件`。创建任务可指定 `contextId` 复用工作上下文；省略时创建新上下文。`--id` 为创建操作指定重试键，重复请求必须保留相同内容。控制操作使用查询得到的最新 `revision`，过期版本返回冲突。

- 排队期间的补充随实际派发进入后台，不额外启动一项执行。
- 任务区分排队、运行、等待、暂停中、取消中、已暂停、成功、失败、阻塞、中断、取消及未报告结果。
- 原生运行结束不等于业务成功；完成报告包含检查、实际交付和未解决项，文件交付会校验范围并记录 SHA-256。
- 暂停／取消是合作式停止，不会回滚已经发生的文件或远端操作。接续使用新一次尝试，保留历史，先核对已有结果；共享同一运行的任务可能同时被中断。
- 重启只自动派发能确认从未受理的排队工作；在途或结果不确定的工作标记中断，不盲目重放。

后台结果先保存，再交给主对话处理。处理失败的通知仍可查询；不要求每项结果都转成一条用户消息：

```powershell
pnpm cli notifications list
pnpm cli notifications retry <通知ID>
```

## 工作区、权限与 MCP

默认工作区为数据目录下的 `workspace`。可添加已有目录：

```powershell
pnpm cli workspaces add '{"id":"project","name":"项目","path":"C:/Work/my-project"}'
pnpm cli tasks create '{"title":"检查项目","content":"读取并检查说明文件。","workspaceId":"project"}'
pnpm cli approvals list
pnpm cli approvals approve <审批ID> once
pnpm cli approvals decline <审批ID>
```

普通受限读取可自动执行；敏感路径、写入、命令执行和 MCP 调用按实际权限处理。审批支持单次、当前任务及适用的持续职责范围，绑定实际调用与配置目标，不授予整个会话永久权限。配置变更和 MCP 连接操作单独审批，不能借此取得一般工具权限。

可信管理入口创建任务时还可显式给出 `grants: { "write": true, "execute": false, "mcp": false }`。只给必要权限。**本机终端不是操作系统沙箱**：获准的命令具有宿主账户实际权限，可能访问工作区外的资料或联网；不要将不可信命令视为已隔离。

MCP 配置不内嵌凭据。远端示例：

```json
{
  "id": "service",
  "url": "http://127.0.0.1:9000/mcp",
  "headersEnv": { "Authorization": "SERVICE_AUTH" }
}
```

本机 stdio 示例：

```json
{
  "id": "local",
  "command": "your-mcp-server",
  "args": [],
  "env": { "SERVICE_TOKEN": "SERVICE_TOKEN" }
}
```

```powershell
pnpm cli mcp add '@mcp.json'
pnpm cli mcp connect service
pnpm cli mcp list
pnpm cli mcp reconnect service
pnpm cli mcp disconnect service
```

连接 stdio 服务会启动所配置的进程。配置保存和实际连接分开；核心重启后按需连接。更换服务或凭据后重新连接，旧连接和旧目标授权不能沿用为新目标的授权。

## 定时职责

可在对话中安排、查询、修改、暂停、恢复、取消和立即执行职责，也可用 CLI：

```powershell
pnpm cli schedules create '@schedule.json'
pnpm cli schedules list
pnpm cli schedules history <职责ID>
pnpm cli schedules run <职责ID>
pnpm cli schedules pause <职责ID> <revision>
```

创建 JSON 包含 `name`、`task`、`timing`，可选 `contextId`、`timezone`、`output`。三种时间形式：

- 一次性：`{ "kind": "once", "at": "2027-01-01T09:00:00+08:00" }`
- 固定锚点间隔：`{ "kind": "interval", "anchorAt": "2027-01-01T09:00:00+08:00", "everyMs": 3600000 }`
- 日历时间：`{ "kind": "cron", "expression": "0 9 * * *" }`

核心必须持续运行才能到点执行。停机和暂停不补跑；运行时每个到期点仍会受理，即使上一项尚未完成。立即执行不改变原节奏，修改不改写已产生的触发快照。

新的 CLI 职责使用持久工作上下文，每次触发分别报告结果。默认不强制生成消息或 Markdown；需要交付时指定 `output.kind` 为 `message`、`artifact` 或 `both`，可指定交付 `contextId`。

## 记忆、方法与交付

记忆整理在后台运行，显式“记住”请求同样进入后台。来源保留完整会话与原始工具往返；原始归档、实际请求快照和整理后的正文分开保存。正文以完整版本原子发布，失败不推进处理水位，未变化时不创建新版本。模型容量不足或处理失败会暴露错误，不静默裁剪历史。

```powershell
pnpm cli memory status
pnpm cli memory resident
pnpm cli memory request <运行ID>
pnpm cli memory retry <记忆作业ID>
pnpm cli methods list
pnpm cli methods get <方法名>
pnpm cli workflows list
```

成功且完成检查的工作可以沉淀为 Skill，供其他任务按需加载。运行尚未结束时提交的方法先保留，实际任务成功后才发布。方法支持 revision、启用／禁用和回退；不会自行扩大工具权限。当前 `verify-files` 工作流在选定工作上下文内读取并校验文件：

```powershell
pnpm cli workflows run verify-files '{"contextId":"work.example","input":{"paths":["result.txt"]}}'
```

消息、独立 Markdown 产物和实际文件交付分开。普通模型文本、工具日志不会自动发布为用户消息：

```powershell
pnpm cli outputs message
pnpm cli outputs artifact
pnpm cli watch artifact
pnpm cli events
pnpm cli usage
```

观察客户端保存游标，重连继续读取。用量只显示供应商实际返回的字段；未知的缓存用量和费用显示为空。完整上下文复用不保证不同工具集之间命中同一供应商缓存，长期记忆质量也仍需实际使用检验。

## 数据与 HTTP

默认数据目录仍为用户目录下的 `.arona`。可用 `SHITTIMCHEST_DATA_DIR` 修改；`SHITTIMCHEST_PORT` 修改服务端口，`SHITTIMCHEST_CORE_URL` 指定客户端地址，`SHITTIMCHEST_CONTEXT_ID` 选择当前上下文。旧 `ARONA_*` 变量仍兼容，同名新变量优先。数据目录包含历史、记忆、凭据及执行状态，不应放入公开仓库或共享目录。

首次升级旧数据库前，会在数据目录的 `migration-backups` 中保存一致的数据库备份；旧标识、输出游标和历史仍可查询。

除 `GET /health` 外，HTTP 请求需要 `Authorization: Bearer <control-token>`。令牌保存在数据目录的 `control-token` 文件；本机客户端自动读取。非默认连接可显式设置 `SHITTIMCHEST_CONTROL_TOKEN`。不要发布令牌或凭据文件。

主要接口：

| 接口 | 功能 |
| --- | --- |
| `POST /signals`、`GET /signals/:id`、`GET /runs/:id` | 消息／事件受理和运行关联 |
| `GET /outputs?after=0&kind=message` | 消息或产物游标 |
| `GET/POST /tasks`、`GET /tasks/:id` | 任务创建和实际状态 |
| `POST /tasks/:id/messages`、`pause`、`resume`、`cancel`、`retry` | 补充和任务控制 |
| `GET/POST /contexts`、`GET /contexts/:id/history` | 上下文与分页历史 |
| `POST /contexts/:id/model` | 模型／思考等级切换 |
| `GET /configuration`、`POST /configuration/:kind` | 运行、模型、工作区和 MCP 配置 |
| `GET /approvals`、`POST /approvals/:id` | 审批 |
| `GET /notifications`、`POST /notifications/:id/retry` | 待处理结果通知 |
| `/credentials`、`/mcp`、`/methods`、`/workflows`、`/memory` | 对应管理接口 |
| `/schedules`、`/schedules/:id/occurrences` | 职责与触发记录 |
| `GET /events`、`GET /usage` | 事件和实际用量 |

新 HTTP 消息和职责使用 `version: 2`。用户消息默认允许消息输出，外部事件默认 `none`；事件自身不是管理授权。省略版本仍按旧协议解释，保留旧输出默认值和同 ID 重试行为。创建操作支持 `Idempotency-Key`；相同键与不同内容冲突。

## 检查

```powershell
pnpm typecheck
pnpm test
pnpm build
```

普通测试只使用合成资料、模型替身和本机模拟服务，不调用真实模型。

`pnpm test:live` 会调用已配置的真实服务。确认服务、费用与权限后，显式设置 `SHITTIMCHEST_ALLOW_LIVE_TESTS=1` 才能运行；它使用临时合成文件，验证交流及实际文件读写，不读取个人资料。此测试不是长期语义质量或缓存性能的完整验收。
