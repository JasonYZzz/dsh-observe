# dsh-observe：DSH Web 0.2.0 日志链路插件开发实施计划

计划日期：2026 年 10 月 16 日。开发对象为可独立安装到原生 DSH Web 的 `dsh-observe` Bundle，首个插件版本建议为 `0.1.0`。

**首期交付一个安装即用的 Web 观测插件：内置执行列表、调用树与瀑布、关联日志、源事件检查和本地观测库。无需部署 Python Gateway、SigNoz 或其他服务。** 后续通过可选 OTLP 导出接入集中式观测平台。

宿主精确基线为当前已经研究的 **`@deepseek-ai/dsh@0.2.0-rc.2`、Cordis 4.0.4、Node.js 24.19.0**。“面向 0.2.0”在本计划中指先完成该 RC 的固定版本适配，不表示已经兼容未核验的所有 0.2.x 或正式 0.2.0 制品。

本计划面向个人 GitHub 开源项目 [JasonYZzz/dsh-observe](https://github.com/JasonYZzz/dsh-observe)，沿用前期日志链路研究结论，以“原生 Web 插件先落地”为本轮范围。前期研究文档尚未收录到本仓库；本文保留原实施范围，并按实际代码与验收记录更新完成状态。

实施更新（2026-10-16）：已交付 `0.1.0` 本地候选工程、两个 Web 入口、六个只读端点、事件/日志采集与 SQLite 查询。验收基于合成事件、原生 RC.2 冷日志和真实 Web 浏览器；按用户要求，真实模型、实际工具和子 Agent 调用留待模型配置后验收。完整证据与未覆盖项见 [验收记录](verification/README.md)。

本轮明确调整：源事件仅提供元数据白名单，不开放 Prompt/工具正文；大列表采用每页 50 条分页，暂不引入虚拟列表；页面使用有界轮询，服务端另提供版本水位。原生 `/api` 的 RPC interceptor 已被 Gateway 占用，实际采用 Connection 精确 Fetch 路由承载原生 RPC 信封。

升级更新：用户进一步要求改善真实请求可见性与 UI，已进入插件 `0.2.0` 升级；新的会话导航、执行链、正文/上下文/工具定义检查器与安全边界见 [0.2.0 升级说明](DSH-Observe-0.2.0升级说明.md)。下文 0.1.0 清单保留作为首期记录，当前版本另见验收目录。

## 1 本轮范围与架构调整

| 决策项 | 本轮实施方式 |
|---|---|
| 安装形态 | 一个 npm Bundle，同时包含 Host 和 Client，提供完整 tarball |
| 使用入口 | 原生 Web 全局“观测”页，以及当前会话中的“观测”Tab |
| 数据来源 | 原生 Session 事件、Assistant 实时 Frame、Agent/子 Agent 生命周期、Cordis Logger |
| 历史读取 | 通过 `ctx.sessionQuery` 读取原生日志，不接管持久化后端 |
| 本地查询 | 插件私有 SQLite 观测库，保存派生索引、脱敏运维日志和身份关联 |
| 实时刷新 | 可见页面有界轮询，查询支持版本水位；首期不新增 WebSocket/SSE 协议 |
| 原生行为 | 保留聊天、工具、审批、压缩、原生轨迹、官方反馈遥测的既有行为 |
| 业务身份 | 展示可验证的身份来源；提供受信 Host 插件绑定接口；缺失则明确显示未提供 |
| 集中观测 | OTLP/SigNoz 为后续独立阶段，不影响首期安装与使用 |
| 本轮不做 | Python SDK/Gateway 改造、企业多租户登录、分布式全栈 Trace、模型评测、工具重跑、全量 HTTP 抓包 |

与前一方案相比，基础交付从“插件向外部服务供数”收敛为“插件自身即可查看日志与链路”。因而必须交付内置 UI 与本地查询，同时缩小跨进程身份传播范围。

### 1.1 两项必须修正的前提

**不直接并行实例化官方采集协调器。** RC.2 的 `SessionTelemetryCoordinator` 使用模块级 `WeakMap<Session, seq>` 保存交接游标。原生 Web 中官方反馈后端可能仍在使用它；另建 live 协调器会共享该游标，可能改变后续反馈导出的前缀。本插件独立注册 `ctx.dshObserve`，订阅 `session/event` 并维护自己的索引水位；不注册第二个 `sessionTelemetry` 服务，不自动关闭官方后端。

**原生 Web 的 operator 不是企业用户体系。** Connection 将已认证请求视为同一个 operator Peer。插件必须区分 `operator_id`、业务 `user_id`、业务 Agent 定义 ID 与原生 `agent/session_id`。原生 prompt 契约只有 requestId、sessionId、mode、content、clientTimeZone；在浏览器请求里随意增加 userId 不会自动成为可信业务身份。

## 2 首期产品验收目标

安装插件并重启 DSH Web 后，用户应能完成以下操作：

1. 从全局观测页找到近期执行，按会话、原生 Agent、请求 ID、状态、模型和日志级别筛选。
2. 打开某次执行，看到 Turn、Step、每次模型尝试、重试等待、并行工具、子 Agent 和压缩。
3. 点击调用节点，查看相关日志、调用元数据、配置与源事件元数据，定位错误、取消和截断原因。
4. 切换到历史会话，查询结果不会启动 Agent、调用模型或重放工具。
5. 关闭浏览器再打开，已持久化日志仍可查询；重启 Host 后按原生日志补齐可恢复的索引。
6. 明确看到“执行停止原因”“模型用量是否上报”“身份来源”“索引是否完整”，不会把未知显示成成功或零。

“更完整”的验收对象是 **DSH Web Runtime 内有证据的执行链**。浏览器提交前网络延迟、尚未进入 Inbox 的拒绝请求、外部 MCP/HTTP 服务内部流程，以及强杀前未持久化的数据，不属于首期完整性承诺。

## 3 插件结构与宿主扩展点

### 3.1 一个包内完成 Host 与 Client

本仓库本身就是独立插件工程，直接在仓库根目录维护 package、锁文件和构建配置，不再嵌套 `plugins/` 目录。

| 命名项 | 本仓库约定 |
|---|---|
| GitHub 仓库 | `JasonYZzz/dsh-observe` |
| 项目名 / 拟定 npm 包名 | `dsh-observe`；发布前确认 npm 名称可用性 |
| Cordis 服务 / 上下文属性 | `dshObserve` / `ctx.dshObserve` |
| 全局页面 / 会话 Tab ID | `dsh-observe` |
| Connection RPC 前缀 | `dsh-observe/`，如 `/api/dsh-observe/health.get` |
| 私有存储目录 | `$DSH_HOME/storages/dsh-observe/` |
| 开源许可 | 沿用仓库现有 MIT `LICENSE` |

```text
dsh-observe/                     仓库根目录
  package.json                 Bundle、./client、发布文件与固定 peers
  cordis.patch.yml             只插入本插件 Host 行
  src/
    index.ts                   Host 装配与生命周期
    capture.ts                 Session、Frame、Logger 采集与异常隔离
    fold.ts                    原生事件到运行/调用节点的纯映射
    query.ts                   有界查询、源事件回查和身份检查
    store.ts                   单 Worker 入口与事务批处理
    store-worker.ts            SQLite 单写入者、查询、清理和迁移
    context.ts                 受信业务身份绑定与来源
    types.ts                   Host/Client 共用 DTO
    client/
      index.tsx                原生 Slots 注册与入口
      api.ts                   原生 Connection RPC 调用
      ObservePage.tsx           执行列表与健康状态
      RunView.tsx              调用树、瀑布和检查器
      LogView.tsx              关联日志与过滤
  tests/
    fixtures/                  RC.2 的脱敏最小事件样本
    fold.test.mjs               因果、配对、状态与计数
    recovery.test.mjs           历史、fork、重建与中断
    routes.test.mjs             认证、输入边界、分页与内容策略
    lifecycle.test.mjs          重载、卸载、Worker 和队列
  scripts/web-smoke.mjs       真实 DSH Web 装载与浏览器验收
  README.md
```

这是职责划分，不要求为每个小函数另设文件。OTLP 模块不进入首期依赖树。复用宿主 React、原生 UI primitives、locale 和主题；不嵌入第二个 React，也不增加独立前端服务。

### 3.2 已确认的公开接缝

| 功能 | 使用的 RC.2 接缝 | 实施约束 |
|---|---|---|
| Host 服务 | Cordis 插件与 `ctx.dshObserve` | 所有注册、定时器、Worker 均有 effect disposer |
| 全局页面 | `sidebar.panellist` + 同 ID 的 `main` keyed slot | 添加入口，不替换整个 sidebar/main 布局 |
| 会话页面 | `conversation.view`，ID 为 `dsh-observe` | 当前 sessionId 由宿主注入，复用同一个 RunView |
| 读 API | `ctx.connection.fetch.register({ path, methods, requestBody, fetch })` | 仅注册 `/api/dsh-observe/` 下的精确路径，保留原生认证与 RPC 信封 |
| 客户端调用 | `ctx.connection.rpc.call('/api', endpoint, payload, signal)` | 使用原生认证传输，不自行保管 token |
| 事件采集 | `session/event`、`session/created`、`session/disposed`、`agent/error` | 不修改事件；异常不得传播回 Session 热路径 |
| 模型实时状态 | `agent/assistant-stream` | Frame 是临时覆盖层，持久结算后回到 canonical 事件 |
| 运维日志 | `ctx.logger.exporter()` | 明确级别，避免自采集递归，卸载只删除自己的 exporter |
| 冷读取 | `sessionQuery.observeSession/readEvent/traceEvent/traceSession` | 观察结束释放 lease；不调用 resume |
| 数据路径 | `dshHomePath()` | 默认写插件私有目录，不使用用户可传任意文件路径 |

Client 制品必须使用 DSH 原生客户端模块装载格式；M0 验证 `dsh.bundle`、`dsh.client` 元数据、`exports['./client']` 与实际构建输出。普通 Vite 页面或一个 ESM 文件存在，不足以证明插件可被 Web 加载。

## 4 数据流与执行语义

### 4.1 单一映射逻辑

```text
Session durable event ───→ fold ───→ 派生运行/节点/关系 ───→ SQLite
Assistant live frame ────→ 临时进度 ─────────────────────→ 查询合并
Cordis logger record ────→ 关联与脱敏 ───────────────────→ SQLite
历史 Session Query ─────→ 同一个 fold ──────────────────→ 索引补齐
浏览器 Connection RPC ───→ 有界查询 ────────────────────→ 页面
```

实时与历史共用同一套语义映射。Client 不再折叠完整原生日志；Host 不复制原生 Trajectory 的全部内部组件。仅查询当页节点，按需从原生日志回查重内容。

### 4.2 标识与节点

| 对象 | 稳定键与处理规则 |
|---|---|
| 原始事件 | `(source_namespace, session_id, format_version, seq)`；命名空间在插件库中持久保存 |
| 执行 Run | `(source_namespace, session_id, turn_start_seq)`；首期一个原生 Turn 对应一个 Run |
| Step | 所属 Run + step，不能作为一次模型调用 |
| 模型尝试 | 结算后的事件键；临时使用 `(runtime_instance_id, attemptId)`，end Frame 的 seq 建立转换关系 |
| 工具 | `(session_id, turn, step, callId)`；结果取 `message.toolCallId`，错误取 `message.isError` |
| 压缩 | `compactionId`，允许 turn 为 null；轮次外压缩单独显示，不能强塞进前一 Run |
| 原生请求 | `user/message.source.rpcId` 与 Inbox inserted 消息关联；同一 Run 可吸收多个 request/message |
| 子 Agent | session 关系与调用证据分开；父目录/parentSession 只证明血缘，不一定证明调用父节点 |

插件自有 `run_id` 不与前一方案的 Gateway `execution_id` 混用。首期 `trace_id/span_id` 可为空；不为了显示 Trace 栏位先引入一整套 OTel Provider。后续导出时保存本地 node_id 与 OTel ID 的映射。

### 4.3 各事件的处理任务

- Turn/Step：建立和关闭节点，保留 end reason；无 Step 的 Turn 也合法。
- Assistant：识别 `assistant/message` 与 `assistant/attempt`；从原生紧凑流恢复已有时间与 usage，不使用已过时的持久 `assistant/chunk` 假设。
- Retry：`llm/retry` 与 `llm/retry-started` 建等待节点；只有计划而没有开始时标记 pending/interrupted。
- Tool：允许并行与乱序完成；没有结果时保留 unknown，不在 Turn 结束时伪造工具成功。
- Subagent：结合 `subagent/catalog`、相关生命周期和工具调用；能证明调用关系才嵌套，不能证明则显示相关会话链接。
- Compaction：关联 start/summary/end、相邻 Surface replacement 及 `compaction/prune`；模型调用型摘要与无模型裁剪分开。
- 嵌套代码工具：M0 固定当前包实际声明的事件形状，M1 纳入同一工具树；未识别的插件事件仍保留类型与源位置，不能静默宣称已覆盖。
- 日志：优先利用明确的 Agent/Session、当前 initiator 和运行位置；只有 service/fiber 来源时显示“未归属”，不按时间接近强行匹配。

### 4.4 状态与耗时

Run 保留 `running / completed / error / cancelled / truncated / blocked / unknown` 等归一状态，同时返回原生停止原因。`completed` 仅表示原生 Turn 正常结束；没有外部业务验收时，`task_outcome` 为 `not_evaluated`。

显示 Step 总时长、每次模型尝试耗时、已知工具耗时、重试等待。排队耗时从可观测的 Inbox 插入到消息消费计算；不冒充完整 HTTP 请求延迟。Attempt start Frame 不带原生起始时间时，只能使用带有“本地观察”标记的时间，历史缺失时不补造。无 usage 显示未上报；不重复累计 fork 继承前缀，不把并行子调用时长相加当总耗时。

## 5 用户与 Agent 上下文的首期实现

### 5.1 身份字段与可信度

| 字段 | 原生 Web 默认值 | 可信接入后的行为 |
|---|---|---|
| `operator_id` | Connection 生命周期内的 operator Peer | 仅表示原生操作者，不自动成为企业 user_id |
| `user_id / tenant_id` | null，页面显示未提供 | 来自受信 Host 插件的已验证主体 |
| `agent_definition_id / version` | null 或宿主明确提供的定义信息 | 与原生运行实例分别保存 |
| `dsh.agent_id / session_id` | 从原生 Registry/Session 取得 | 不能被传入的 agent_id 覆盖 |
| `identity_source` | native-operator 或 unknown | trusted-plugin，并保存来源插件名称 |
| `request_ids / message_ids` | 从 Inbox 与原生消息取得 | 与绑定记录合并，但不改变消息或权限 |

首期支持字段、查询和可信绑定，但不会凭空获得不存在的企业身份。浏览器填写的标签如未来需要，应命名为 declared label，不能显示为已认证用户。

### 5.2 一个受信 Host 绑定接口

拟提供 `ctx.dshObserve.bindContext(binding)`，输入包括 sessionId、requestId 或 messageId、已验证 user/tenant、业务 Agent 定义和来源。它仅供同进程受信插件使用，不暴露成浏览器可调用的“修改身份”RPC。

绑定按 request/message 保存，不能只在 Session 上放一个可变 `currentUser`。幂等重复可接受，冲突必须返回显式错误；绑定失败不应由观测插件抛进原生 Agent Loop。接入方若要求强关联，应先完成绑定，再调用原生 prompt；迟到绑定可以补充索引，但必须标明关联状态，不能篡改先前身份记录。

该接口只提供观测归属，不授予访问目标 Session 的权限。本轮仍按原生单 operator 的访问范围提供内部工作台，企业行级隔离留给以后明确的身份集成阶段。

验收包含两组数据：纯原生 Web 显示身份缺失；受信测试插件绑定两个不同 user_id 后，两个并行 Session 的归属不串线。不能只验收浏览器传一个 userId 就展示成功。

## 6 本地观测库与历史恢复

### 6.1 最小存储模型

默认目录为 `$DSH_HOME/storages/dsh-observe/`，使用独立 SQLite 文件与单个数据库 Worker。整个目录同一时间只允许一个插件实例/Host 写入，使用现有原子写/锁能力处理所有权。

| 表 | 内容 | 可否从原生日志重建 |
|---|---|---|
| `session_index` | 头信息、revision、inherited cut、索引水位与失败状态 | 可以 |
| `runs` | 每个 Turn 的状态、时间、usage 与摘要 | 可以，受原日志保留范围限制 |
| `nodes` | Step/Attempt/Tool/Compaction 等节点与源事件定位 | 可以 |
| `links` | 调用、请求消息关联、会话血缘；标注证据来源 | 原生派生部分可以；受信绑定依赖独立记录 |
| `logs` | 脱敏后的运维日志、来源和可用运行归属 | 不保证可以 |
| `context_bindings` | 受信插件提交的 request/message 身份关联 | 不可以 |

**整个数据库不能当作可随意删除的缓存。** 重建只清理可重建的派生表，并保留运维日志与身份绑定；损坏时保留原文件，拒绝自动删库重建。卸载插件默认保留数据，升级迁移先备份并确认 schema 版本。

首期不复制 Prompt、工具结果和 Assistant 原始流到数据库，不新增向量库或全文检索集群。日志先提供级别/来源/会话/执行/时间过滤及有界文本包含搜索；是否增加 FTS 由后续实测决定。

### 6.2 热路径与背压

Session 监听器只提取必要元数据、入有界队列；不 await 网络，不做同步 SQLite，不把完整流或附件深复制给 Worker。实时 Frame 在内存中增量统计首末 Token 等进度。SQLite 写入/查询由单 Worker 串行执行，批次提交同时更新派生结果与水位。

队列溢出时记录受影响的 Session 和索引缺口，后续从 canonical log 补齐；运维日志无法补齐的部分显示丢失计数。日志发送器自己的故障走独立有界诊断计数，不能反复调用同一个 exporter 引起递归。

日志保留天数、容量上限和单条摘要长度在 M2 固定默认值，首期建议 7 天、256 MiB 逻辑日志预算、8 KiB 单条摘要。容量是预算而非 SQLite 文件立刻缩小的承诺；包含 WAL 的物理大小与空闲页也要监控。不能靠删除身份绑定来腾出日志空间。

### 6.3 历史与重启

1. 安装后优先索引当前活动 Session。默认不在启动时扫描整个历史正文。
2. 历史列表先读取轻量头信息；打开某条历史会话时，使用 `sessionQuery` 观察稳定切面并补齐索引。
3. 活动订阅与历史基线使用 seq 水位对账：先注册监听，历史折叠到切面，再合并之后的事件；事务拒绝重复或缺号，不依赖先后碰运气。
4. 处理完一个批次才提交连续水位；崩溃前已入内存但未提交的数据可从原生日志重读。
5. 首期冷会话正文准备并发为 1，避免多份大日志同时解码。原生 observeSession 可能准备整份日志，输出分页不等于底层流式解码；M2 实测并给出可支持的单会话边界。
6. 索引重建不调用 `agents.resume`，不追加用户消息，不执行任何工具。
7. 标记 fork 继承前缀、格式迁移和恢复合成事件；读到未知格式/词汇时明确拒绝，不能跳过后宣称完整。
8. 重启后的开放执行显示需要对账/unknown；只有原生结束事实才能正常关闭，临时 Frame 不作为持久完成证明。

## 7 Web 页面与只读 API

### 7.1 全局观测页

“观测”入口注册到原生 sidebar.panellist。主区默认展示执行列表，列为时间、Session、请求 ID、模型、状态/停止原因、耗时、Token、重试、错误/警告和索引状态。

支持按会话/Agent、请求、用户身份、模型、状态、时间过滤。user_id 不存在时允许筛选“未提供”。无记录、索引中、索引失败、Host 重连、采集暂停分别有明确页面状态。

顶部只保留运行数、失败/截断、采集缺口等少量指标。首期不增加大量统计图或费用排行榜。

### 7.2 Run 详情与会话 Tab

左侧为因果树，中间为时间瀑布，右侧为检查器；窄屏切换为树/时间线/详情三个视图。列表、树和日志均有分页或虚拟化，选择节点不加载整场会话的正文。

检查器按需展示：身份及可信来源、原生请求配置、输入输出摘要、工具错误、相关日志、源事件 seq 与替换来源。正文只通过统一内容策略读取；普通脱敏正文查看不作为“显示原文”的绕过入口。

全局页与 `conversation.view` 的会话 Tab 共用组件。分享/复制定位先使用插件自身可解析的 session/run/node 参数；不得假设原生 Trajectory 已支持任意事件锚点。M3 验证宿主导航方式后再承诺刷新恢复的链接格式。

### 7.3 六个插件自有读端点

通过原生 Connection 注册以下逻辑 endpoint，名称均以 `dsh-observe/` 开头。RC.2 的 `/api` 拦截器已由 API Gateway 独占，M0 真实装载后改用 `connection.fetch.register` 的精确路径，如 `/api/dsh-observe/health.get`。Connection 保留认证与 Host/Origin 检查；插件复用原生信封 schema、有界读取请求体并返回相同 RPC 响应格式，客户端调用方式不变。

| Endpoint | 输入 | 输出 |
|---|---|---|
| `health.get` | 无 | 插件/宿主版本、数据库状态、队列、丢弃、索引水位与覆盖范围 |
| `runs.list` | 过滤器、limit、cursor | Run 摘要与下一页 |
| `runs.get` | runId | 身份、状态、配置摘要、统计、关系与完整性 |
| `runs.nodes` | runId、parent/node 过滤、limit、cursor、afterRevision | 有界节点及可用临时进度 |
| `logs.list` | run/session/node、时间、级别、来源、文本、cursor | 脱敏日志与下一页 |
| `events.get` | sessionId、seq、有界邻域 | 经策略过滤的源事件、来源关系及内容状态 |

所有客户端输入经运行时 schema 校验；SQL 参数化；不接收任意 SQL、文件路径、数据库路径或模块名。默认页面 50 条、最大 200 条；文本和时间范围有限额。游标与查询条件/排序绑定，失效明确返回，不静默换页。

页面可见且执行活动时每 1 秒刷新，空闲降至 5 秒，隐藏/卸载暂停，重新可见后先取新基线。返回 `asOfRevision/indexedThroughSeq/coverage`；Client 忽略过期响应，切换 Run 取消旧请求。首期不订阅或存储每个 Token 的完整文本日志。

### 7.4 认证与内容边界

自有 RPC 由原生 Connection 完成 browser session、Host/Origin 检查；不开放裸 HTTP 端口，不把 launch token 写入链接、日志或配置响应。当前工作台继承 operator 的本地管理权限，不把 user 过滤框描述为访问控制。

统一清理日志参数、异常 cause、URL query、工具 arguments/result 中的敏感字段与格式；支持循环对象和 Error 的安全摘要。脱敏器失败时保留事件定位与“内容不可用”状态，不回退到原始对象。原生日志本身不因插件脱敏而改写。

## 8 开发里程碑与任务清单

以下 M0–M5 构成首期交付，按依赖顺序推进。工作量是工程估算，不是已完成项。

### M0 固定兼容基线和安装骨架

预计 1 人日。

- [x] 在仓库根目录建立 `dsh-observe` 单包工程，锁定已验证宿主组件与 Node，生成真实依赖锁。
- [x] Host 注册 `dshObserve`，Client 增加一个全局入口和一个会话 Tab，均只显示健康信息。
- [x] 验证原生 Connection 自有 RPC、Session Query 能力与 SQLite Worker 可用性；缺少关键能力时给出明确不兼容原因。
- [x] 验证 tarball 的 files、exports、Bundle patch、Client 元数据与构建输出；安装 tarball 而非源码软链接验收。
- [x] 用隔离 DSH_HOME 启动真实 Web，验证加载、登录、主题、卸载和重启。
- [x] 收集最小脱敏 fixture：成功、失败、重试、取消、子 Agent、压缩、嵌套工具、fork、历史恢复。

退出条件：固定 RC 下一个 tarball 可安装、可见、可查询健康、可卸载；原生 Chat/Trajectory/反馈路径保持可用。未过该关不继续开发完整 Dashboard。

### M1 完成纯事件映射与实时采集

预计 3–4 人日，依赖 M0。

- [x] 明确定义 Run/Node/Link/Log DTO、原生事件键与覆盖状态。
- [x] 实现 Turn、Step、Attempt、工具、重试、子 Agent、压缩和嵌套工具映射。
- [x] 接入 `agent/assistant-stream` 的临时进度，end 时清除临时覆盖层，由 canonical 事件单独结算，避免重复模型计数。
- [x] 注册独立 Session 监听与 Logger exporter；明确 warning 阈值、递归保护与缺失归属。
- [x] 完成 `bindContext` 与冲突处理，纯原生身份缺失如实显示。
- [x] 编写最小 golden fixture 检查结构、配对、时间来源、停止原因和用量，不只比较序列化快照。

退出条件：相同 canonical 事件在实时和离线输入下得到相同最终结果；两个并发 Session 不串线；RC.2 工具结果正确闭合。

### M2 本地存储和可恢复查询

预计 2–3 人日，依赖 M1。

- [x] 实现数据库 Worker、单写入者、最小 schema、批处理与连续水位事务。
- [x] 保存非重建型日志/身份数据；定义升级迁移、损坏处理与备份。
- [x] 实现轻量会话发现、按需历史观察、live/cold 水位合并及 lease 释放。
- [x] 实现队列上限、采集缺口、日志保留与数据库/WAL 大小健康信息。
- [x] 提供六个只读端点，完成输入校验、分页、游标和取消处理。
- [x] 实测大日志准备的时延/内存，固定首期支持边界与明确的超限返回。

退出条件：重启后运维日志和身份仍存在；未提交事件从 canonical log 补齐；重建不删除独有数据；不启动任何历史 Agent。

### M3 内置 Web 观测界面

预计 4–5 人日，依赖 M2。

- [x] 全局执行列表、过滤器、健康状态、空态与错误态。
- [x] 复用的 RunView：调用树、时间瀑布、节点选择和并行关系。
- [x] 节点检查器：身份、配置、停止原因及源事件元数据。
- [x] LogView：级别、来源、运行归属与文本筛选，点击节点联动日志。
- [x] 当前会话 Tab、全局 Run 详情之间的跳转及可恢复定位。
- [x] 有界轮询、过期响应处理、隐藏暂停、每页 50 条分页、键盘操作与原生深浅主题。

退出条件：从执行列表定位一次失败工具及对应日志，再跳到准确源事件；会话 Tab 与全局页显示同一 Run 事实。

### M4 故障恢复和安全回归

预计 3–4 人日，依赖 M3。

- [x] 覆盖重试后成功、取消、max-tokens、unknown、无 usage、无业务身份。
- [x] 覆盖 fork 继承历史、轮次外压缩、未知插件事件、恢复合成事件和混合输入。
- [x] 模拟 Worker 故障、队列溢出、磁盘不可写、数据库损坏与查询取消；验证 Host 重启后的新连接与数据恢复。
- [x] 对比官方协调器的反馈导出内容与交接游标，确认本插件不消费该游标；真实反馈后端网络发送留待后续集成验收。
- [x] 验证日志/工具参数/异常的脱敏，未登录和错误 Origin/Host 被拒绝。
- [x] 验证重载十次无重复监听/重复 exporter/孤立 Worker；索引重复导入不改变计数。
- [x] 完成合成查询与原生冷读基线、大数据 UI 验证，记录真实限制；真实工具/模型端到端额外耗时目标留待配置后测量。

退出条件：关键行为、安全、恢复测试通过；采集故障只影响观测，不触发模型/工具重试或改写原生日志。

### M5 打包发布与使用验收

预计 2–3 人日，依赖 M4。

- [x] 生成本地候选包 `0.1.0`（未发布 npm），记录 tarball SHA-256、Node/DSH/Cordis 版本与锁文件。
- [x] 完成安装、配置、观测入口、身份接入、保留策略、升级和卸载文档。
- [x] 在全新隔离 DSH_HOME 进行 tarball 安装 → 重启 → 运行 → 冷读 → 再次重启 → 卸载回归。
- [ ] 使用受控提供方完成真实模型、实际工具、子 Agent 与浏览器验收；需要付费/真实调用时按既有授权执行。
- [x] 单独标注 fixture/mock 与真实调用结果，不以 dump-config 或静态页面作为最终验收。

退出条件：交付可安装制品、使用说明、兼容矩阵、测试结果与回退步骤。首期总计约 **15–20 人日**，单人连续投入约 3–4 个工作周；版本接缝或大日志准备若超出预期，在 M0/M2 调整范围与估算。

## 9 验收矩阵

| 编号 | 场景 | 必须满足的结果 |
|---|---|---|
| A01 | 原生 Web 安装 | tarball 安装即出现两处入口，无额外服务依赖 |
| A02 | 普通模型及工具回合 | Turn/Step/Attempt/Tool 层次与原生日志一致 |
| A03 | 工具并行与嵌套 | 不串 callId，不把工具总时长当模型延迟 |
| A04 | 429 重试后成功 | 失败尝试、等待、成功尝试均可见；Run 最终状态正确 |
| A05 | 子 Agent 与 fork | 调用证据与血缘区分，继承前缀不重复计入调用/usage |
| A06 | 压缩 | summary/prune、替换区间、失败及轮次外压缩均可解释 |
| A07 | 取消与截断 | cancelled/truncated 与 completed 区分；task_outcome 不虚报成功 |
| A08 | 身份 | 原生无业务身份显示未提供；受信绑定并发不串线；浏览器不能伪造 verified user |
| A09 | 队列及多输入 | request/message 与实际消费 Run 关联；没有 HTTP 证据就不显示完整请求耗时 |
| A10 | 历史冷读 | 不创建活动 Agent、不调用模型/工具；源文件不因插件回查被改写 |
| A11 | 强杀及恢复 | 仅恢复已有证据；开放节点标 unknown；临时流与持久事件不重复 |
| A12 | 数据库重建/迁移 | 不丢日志与身份绑定，不自动删除损坏库 |
| A13 | 认证/脱敏 | 全部自有 RPC 走原生认证；秘密不通过详情或错误回退泄露 |
| A14 | 官方遥测共存 | 反馈导出行为与未安装插件时一致；无第二个 sessionTelemetry |
| A15 | 生命周期 | 重载/卸载没有重复记录、计时器、Exporter 或孤立 Worker |
| A16 | UI 与查询 | 深浅主题、窄屏、键盘操作可用；分页无重复/漏项，过期响应不覆盖当前 Run |

### 9.1 性能验收目标

在固定 Node、固定机器和固定 fixture 下，与未安装插件的同一宿主比较。以下是拟定目标，开发后实测，不当作当前能力：

- 小记录采集监听器 p95 小于 1 ms，无同步数据库/网络操作；大记录独立报告。
- 常规有索引页的本地查询 p95 小于 300 ms；可见运行更新延迟不超过 2 秒。
- 合成 10 万条脱敏日志与 1 万个调用节点时，页面按页/虚拟化呈现，不一次传输全部数据。
- 队列、临时 Frame 覆盖层、客户端缓存均有上限；窗口隐藏后轮询停止。
- 历史准备同时最多一个大会话；准备期间与 native Session Query 本身的开销分别记录。
- 在受控确定性工具 fixture 上，对比 Turn 总耗时和事件循环延迟；若持续产生超过约 5% 的额外耗时，先定位采集、序列化与冷读开销，再扩大发布。

## 10 后续阶段

### M6 可选 OTLP 导出

首期稳定后预计另需 3–5 人日，作为独立可选模块：将本地 Run/Node 映射到 OTel Trace/Log，保证实际 Trace/Span 字段关联、失败状态、时长与用量正确；处理现有 Provider 共存、队列、停机排空与 Collector 故障。默认关闭，不影响本地 Dashboard。

只完成配置与模拟 Exporter 不算该阶段完成；至少用真实 Collector 接收并在选定后端核对日志/Span 跳转。远程 Prompt/工具正文保持独立显式策略，不能沿用本地查看权限自动上传。

### M7 企业入口与 SDK 集成

后续按独立集成需求评估 Gateway、Python SDK、可信 Principal、跨进程 TraceContext 与租户授权。此时才承诺完整 HTTP 请求链和业务用户访问隔离；首期不依赖外部业务仓库。

## 11 首期完成定义与回退

首期完成必须同时具备：

- 可安装 Bundle、固定宿主兼容说明与构建锁。
- 两个 Web 入口和六个受认证只读端点。
- 正确的 RC.2 事件映射、关联日志、历史回查与真实身份来源。
- 有界采集、可恢复索引、日志/身份保存以及失败降级。
- A01–A16 验收记录、真实性能结果和至少一次真实 Web 运行回归。
- 升级与卸载说明；停用插件并正常关闭后，原生 Web 继续工作，本地观测库保留。

回退以停用或卸载 Bundle、重启 Host 为主，不删除原生 Session、workspace 或观测库。数据库 schema 升级不兼容旧插件时，使用升级前备份恢复观测库；不能只回退 npm 包就保证旧版可读新库。

已完成工程、依赖锁、功能实现、隔离真实 Host/浏览器回归与本地候选包；未执行真实模型调用。按用户要求，M5 真实调用验收以及依赖真实执行的耗时比较仍保留为待配置项，不将合成事件视为真实工具或子 Agent 执行。外部观测平台与跨进程链路仍属后续阶段；主要风险为固定 RC 接缝和原生大日志准备成本。

## 12 实施依据

以下为前期在本机核对的 RC.2 契约，开发时以固定制品和真实装载结果为准。路径均相对于已安装的 `@deepseek-ai/dsh` 包根目录，行号仅用于定位当时的固定版本：

- Connection 的认证、RPC 与自有端点注册：`node_modules/@deepseek-ai/dsh-client-connection/lib/types/rpc.d.ts`。
- 共享 operator Peer：`node_modules/@deepseek-ai/dsh-client-connection/lib/types/operator-peer.d.ts`。
- SessionPromptRequest 原生字段：`node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/types.d.ts:319`。
- 遥测协调器的模块级交接游标：`node_modules/@deepseek-ai/dsh-session-telemetry/lib/index.js:17`。
- 全局侧栏入口：`node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts`。
- 原生 main keyed slot：`node_modules/@deepseek-ai/dsh-client-ui-layout/lib/types/client/index.d.ts`。
- 原生 Trajectory 的 conversation.view 注册示例：`node_modules/@deepseek-ai/dsh-client-ui-trajectory/lib/client.js:8736`。
- 模型实时 Frame 与 committed seq：`node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:107`。
- Subagent Catalog：`node_modules/@deepseek-ai/dsh-subagent/lib/types/catalog.d.ts`。
- 压缩事件及替换关联：`node_modules/@deepseek-ai/dsh-compaction/lib/types/types.d.ts`。
- 固定版本源码 hash 已收录于 `verification/source-manifest.json`，由 `npm run verify:host` 生成，并验证全部 fixture 的 RC.2 冷日志关系约束。
