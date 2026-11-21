# ShittimChest

让电脑成为什亭之匣，里面住着阿罗娜。

ShittimChest 是围绕《蔚蓝档案》阿罗娜构建的个人 AI 伴侣项目。当前提供独立运行的本地核心、交互式 TUI 和非交互 CLI：文字交流、后台任务与持续上下文、文件和终端操作、网页读取与可配置检索、MCP、定时职责、记忆整理，以及可复用的 Skill 和文件校验工作流。

核心只监听 `127.0.0.1`。退出终端对话不会停止核心或已受理的后台工作；关闭核心则会停止执行。不会自动接入个人聊天、邮箱、浏览记录或系统监测。

## 启动

安装包需要 **Node.js 24** 及其附带的 npm。下载后在安装包所在目录运行：

```powershell
npm install --global ./arona-0.1.1-alpha.tgz
shittimchest
```

从源码运行还需要 pnpm：

```powershell
pnpm install
pnpm build
pnpm cli
```

在交互终端中默认打开 TUI；它会连接已有核心，必要时启动独立核心。没有模型时可先从管理菜单添加配置，配置后再进行交流或派发工作。退出 TUI 不会停止核心。

编译后也可直接运行 `node dist/cli.js`。本地安装包提供 `shittimchest` 和兼容命令 `arona`；`shittimchest-core` 单独启动核心。编译包包含 macOS、Linux、Windows 的 x64/arm64 文件搜索工具及许可证；目前已在 macOS arm64 验证安装与搜索。

`shittimchest --version` 查看客户端版本；TUI 的 `/status` 同时显示客户端与所连接核心的版本和构建标识。

`pnpm package` 构建并在系统临时目录的 `shittimchest-packages` 中生成本地安装包；命令输出包含文件名。需要指定输出目录时，先执行 `pnpm build`，再运行 `node scripts/package.mjs <目录>`。

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

不能仅凭模型名称推断协议。Messages 默认使用 `x-api-key`；需要 Bearer 时设置 `SHITTIMCHEST_MODEL_AUTH_HEADER=bearer`。也可以用 `SHITTIMCHEST_MODEL_REQUEST_AUTH` 明确选择 `api-key` 或 `bearer`：Messages 的 API key 使用 `x-api-key`，Chat Completions 和 Responses 使用 `api-key`。未设置时保留原有认证方式。Chat Completions 和 Responses 可用 `SHITTIMCHEST_MODEL_REASONING_EFFORT` 显式指定等级；此启动参数不适用于 Messages。

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

自定义接口可填写可选的 `contextWindow` 和 `maxTokens`，分别声明服务的上下文窗口和最大输出能力，用于容量管理；请使用服务实际提供的数值。启动配置对应 `SHITTIMCHEST_MODEL_CONTEXT_WINDOW` 和 `SHITTIMCHEST_MODEL_MAX_OUTPUT_TOKENS`，不会按模型名称猜测容量。

`pnpm cli core status` 查看核心，`pnpm cli core stop` 关闭核心及其工作；TUI 中也可使用 `/shutdown`，确认后关闭。单纯 `/quit` 只退出当前界面。

供应商目录模型及能精确匹配目录的自定义接口自动采用模型的思考能力；自定义 `thinking` 映射可覆盖该设置。未声明能力的未知模型不会被假定支持所有等级。`/think` 打开当前模型的等级选择器，输入参数时提供可用等级补全；`/think default` 恢复模型默认。当前运行保留已选择的模型和选项，变更在下一次运行采用。切换模型优先采用目标配置的默认等级，否则保留会话偏好，并按目标模型支持的等级调整实际值。

## 终端交互

`/help` 列出命令和快捷键，`/menu` 打开管理菜单，`/quit`、`Ctrl+D`（空输入）或连按两次 `Ctrl+C` 退出。`Esc` 停止当前回复，`Shift+Tab` 切换思考等级，`Ctrl+P` 切换模型，`Ctrl+L` 打开模型选择，`Ctrl+O` 展开或折叠工具记录。设置 `NO_COLOR` 可关闭配色。

`↑`／`↓` 可找回已提交的输入，调出后光标位于末尾，返回未发送草稿时恢复原光标位置；多行输入先移动到首尾，再浏览历史。普通消息发送失败后仍可找回，`/` 命令和 Shell 输入也进入本次界面的输入历史。

工作区命令、文件读取和编辑等工具在卡片中显示脱敏后的输出，默认预览 10 行；点击卡片或按 `Ctrl+O` 展开正文。成功编辑显示增删差异，写文件显示实际写入内容。长输出截断时会标明，旧记录可能仅有统计。

供应商返回的思考内容会显示在回复上方，`Ctrl+T` 展开或折叠。`!命令` 在本机 shell 中执行（目录为启动 TUI 的位置），结果会附在下一条消息里交给阿罗娜；`!!命令` 只执行不带入。这些命令以你的账户直接运行，不经过审批，也不是沙箱，与在自己的终端里输入相同；`Esc` 可取消正在运行的命令。

忙时发送可选择补充当前运行或排队下一次运行；`Alt+Enter`（或 `Ctrl+Q`）直接排队。排队消息显示在输入框上方，`Alt+↑`（或 `Alt+Q`）把尚未开始的排队消息全部撤回到输入框，`/queue` 可逐条查看、编辑或撤回。编辑会保留原记录，并将替代输入追加到队尾。迟到的补充与中断请求不会作用于后继运行。

需要审批的操作（包括后台任务的）会在输入框空闲时直接弹出：数字键快选，`Esc` 暂缓而不是拒绝，`/approvals` 随时回到暂缓的请求。

`/hotkeys` 查看快捷键；多行输入可用 `Ctrl+J`，附件粘贴可用 `Ctrl+V` 或 `Alt+V`。管理菜单的“界面设置”可选择深色、浅色或无颜色主题。重新打开 TUI 时恢复同一核心存储中的上次上下文；设置 `SHITTIMCHEST_CONTEXT_ID` 可明确选择上下文。

交流上下文与后台工作上下文分开：前者可以直接聊天，后者通过任务管理补充和控制。`/sessions` 浏览、搜索和重命名对话；`/tree` 查看当前会话的分支、搜索节点、添加标签或回到历史位置，切换时可选择保留分支摘要。`/fork` 从选中用户消息前建立独立对话，并将该消息恢复为草稿；`/clone` 复制完整会话树。忙时复制会先停止当前回复，并将尚未开始的排队消息保留为草稿。分支保留来源，不继承在途任务或审批。

`/export` 支持 HTML、Markdown 和本产品的 JSONL；HTML 可离线浏览完整会话树。`/export --pi <路径.jsonl>` 导出 Pi 会话格式，`/import <路径>` 可识别本产品和 Pi 的 JSONL，导入为独立对话。导入不会把原会话的目录或扩展设置变成执行权限。

普通导出去除系统内容、隐藏推理和供应商私有回放数据。`/export --backup` 保存接续所需的完整会话树、工具记录与附件；`/export --pi --backup <路径.jsonl>` 保存 Pi 格式的接续数据。接续备份可能含私有原始内容与供应商回放数据，请仅保存到私有位置。

已知模型容量接近上限时，核心可自动整理较早上下文；明确的容量溢出最多触发一次恢复尝试，不重复受理原消息。手动 `/compact [侧重说明]` 在当前会话中压缩较早内容，带着摘要和最近几轮继续；原始历史和压缩节点可用 `/tree` 查看。连接旧版核心时沿用派生上下文方式。摘要可能遗漏细节。

需要回答问题或确认计划时，可从提示或 `/questions` 进入；暂缓不等于拒绝，回答只恢复对应运行。供应商支持 OAuth 时，主动 `/login` 会在本机浏览器发起登录；授权界面保留完整链接复制、重新打开、输入和取消操作。

模型管理支持供应商目录、授权入口和受模型实际能力约束的思考等级。配置默认等级与当前会话覆盖分开；选择配置默认会清除当前会话覆盖。密钥输入不回显，查询不返回密钥值。由启动参数提供的模型也可回填为命名配置；其中的启动凭据引用只有在该核心仍有对应启动凭据时可用。

网页读取默认只访问公开 HTTP(S) 地址，网页正文作为外部资料处理。检索需要从管理菜单配置 Brave 凭据引用或公开 SearXNG 地址；未配置时不会伪造搜索结果。工具执行仍遵循任务权限与审批。

工作区文件读取支持 DOCX、XLSX、PDF 文本层、Jupyter Notebook 和 SQLite 预览。提取内容附原文件长度与 SHA-256，仍受原文件读取权限约束；提取文字不等于原始文件字节，也不能据此直接用纯文本覆盖 Office 等二进制文档。图片型 PDF 尚不提供 OCR。

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

TUI 的 `/tasks` 提供报告、执行时间线、父子任务及按当前状态可用的控制动作。新建任务提交失败后，再次输入 `/task` 可继续本次界面的表单草稿；提交结果未确认时应先核对任务列表。

JSON 参数支持 `@文件`。创建任务可指定 `contextId` 复用工作上下文；省略时创建新上下文。`--id` 为创建操作指定重试键，重复请求必须保留相同内容。控制操作使用查询得到的最新 `revision`，过期版本返回冲突。

- 排队期间的补充随实际派发进入后台，不额外启动一项执行。
- 任务区分排队、运行、等待、暂停中、取消中、已暂停、成功、失败、阻塞、中断、取消及未报告结果。
- 原生运行结束不等于业务成功；完成报告包含检查、实际交付和未解决项，文件交付会校验范围并记录 SHA-256。
- 暂停／取消是合作式停止，不会回滚已经发生的文件或远端操作。接续使用新一次尝试，保留历史，先核对已有结果；共享同一运行的任务可能同时被中断。
- 重启会自动派发能确认从未受理的排队工作；具备有效原生等待快照的问答和审批可继续。源记录、配置、凭据或权限发生变化时不会自动恢复，无法确认恢复状态的执行标记中断。

后台结果先保存，再交给主对话处理。处理失败的通知仍可查询；不要求每项结果都转成一条用户消息：

```powershell
pnpm cli notifications list
pnpm cli notifications retry <通知ID>
```

## 工作区、权限与 MCP

在本机项目目录运行 `arona` 会新建该项目的终端会话；`arona --continue`（或 `-c`）接续此目录最近的会话。`--context ID`（或 `--session ID`）打开指定会话并保留它原来的工作区。

独立核心的默认工作区仍为数据目录下的 `workspace`。连接远端核心时使用服务端配置的工作区，`arona --workspace ID` 可选择其中一个；不会将本机当前目录套用到远端。也可添加已有目录：

```powershell
pnpm cli workspaces add '{"id":"project","name":"项目","path":"C:/Work/my-project"}'
pnpm cli tasks create '{"title":"检查项目","content":"读取并检查说明文件。","workspaceId":"project"}'
pnpm cli approvals list
pnpm cli approvals approve <审批ID> once
pnpm cli approvals decline <审批ID>
```

管理菜单可修改工作区名称或目录。目录变更要求相关执行处于空闲状态，原历史保留，旧目录的写入及执行预授权会撤销。移除工作区配置不删除目录文件；仍被上下文引用的工作区不能移除。

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

`/mcp` 可查看发现的工具和连接失败原因，也可断开并删除配置。

支持 OAuth 的 HTTP MCP 服务可从管理页登录或注销；同一入口还可浏览资源、填写资源模板和提示词参数。服务返回的提示词和资源始终是外部资料，不会扩大工具权限。

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

新的 CLI 职责使用持久工作上下文，每次触发分别报告结果。需要交付时指定 `output.kind` 为 `message`、`artifact` 或 `both`，可指定交付 `contextId`。

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

ChatGPT 导出 ZIP 可以通过 `pnpm cli memory import @import.json` 逐批导入。配置示例：

```json
{
  "archivePath": "/absolute/path/export.zip",
  "namespace": "personal",
  "sourceRef": "chat-export",
  "memberIndex": 0,
  "conversation": { "index": 0 },
  "maxNodes": 8
}
```

导入操作默认只在本地保存所选历史，不立即调用模型；符合近期窗口的用户原文会用于后续对话。`branchLeafId` 选择分支，`replayUntil` 限制历史时间；重复导入沿用原来源身份。需要后台整理时，先启用 V1 记忆模式，再设置 `organize: true` 和当前 `expectedHead`，或在导入后执行 `memory request <导入ID>`；这会把选中的材料发送给配置的记忆模型。作业结果通过 `memory status` 查看。缺失的媒体保留来源缺口，导出的历史语音转写与未经核验的原录音分别处理。

配置 `.env.example` 中四项 `SHITTIMCHEST_AUDIO_*` 后，核心可使用本地 whisper.cpp 转写 16 kHz、单声道、16 位 PCM WAV（最长 60 秒）。音频作为附件提交，机器转写与用户手打原文分别保留；转写失败不会被记为已理解。

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

升级前先用 `shittimchest core stop` 关闭核心，并另存整个数据目录。需要回退时，先关闭新版核心并保留当前数据副本，再使用旧版安装包和升级前的数据目录。若使用自动迁移备份，先将当前这两库及各自的 `-wal`、`-shm` 文件一并移入保留副本，再从同一份备份成对恢复 `records.sqlite` 与 `history.sqlite`，不能沿用当前数据库的日志文件。恢复后回到该备份时刻的数据状态。

除 `GET /health` 外，HTTP 请求需要 `Authorization: Bearer <control-token>`。令牌保存在数据目录的 `control-token` 文件；本机客户端自动读取。非默认连接可显式设置 `SHITTIMCHEST_CONTROL_TOKEN`。不要发布令牌或凭据文件。

主要接口：

| 接口 | 功能 |
| --- | --- |
| `GET /protocol`、`GET /version` | 能力握手与实际核心构建信息 |
| `POST /signals`、`GET /signals/:id`、`GET /runs/:id` | 消息／事件受理和运行关联 |
| `GET /outputs?after=0&kind=message` | 消息或产物游标 |
| `GET/POST /tasks`、`GET /tasks/:id` | 任务创建和实际状态 |
| `POST /tasks/:id/messages`、`pause`、`resume`、`cancel`、`retry` | 补充和任务控制 |
| `GET/POST /contexts`、`GET /contexts/:id/history` | 上下文与分页历史 |
| `GET /contexts/:id/tree`、`POST /contexts/:id/tree/navigate` | 会话树与历史路径切换 |
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
