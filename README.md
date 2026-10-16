# dsh-observe

为 DeepSeek Harness Web 提供本地执行链路与关联日志的独立开源插件。
[JasonYZzz/dsh-observe](https://github.com/JasonYZzz/dsh-observe)，MIT 许可。

`0.2.2` 候选版已实现采集、SQLite 查询和两个原生 Web 入口。已完成合成事件、真实宿主和浏览器验收；**真实模型、实际工具和子 Agent 调用按用户要求留待配置后验收**。详见[验收记录](docs/verification/README.md)。

## 兼容基线

| 组件 | 固定验证版本 |
|---|---|
| DSH Web | `@deepseek-ai/dsh@0.2.0-rc.2` |
| Cordis | `4.0.4` |
| Node.js | `24.19.0`（仅支持 Node 24） |

未声明支持其他 RC 或正式版。使用宿主 React、UI primitives、locale、认证和主题；无需独立前端、数据库服务或模型配置即可查看已有日志。

## 安装与使用

在已安装固定版本 DSH 的机器上，用本地候选包安装到 Web profile：

```sh
dsh plugin --profile web add /absolute/path/dsh-observe-0.2.2.tgz
dsh web
```

重启宿主后，打开侧栏“观测”，或当前原生会话中的“观测”Tab。0.2.2 将轮次、步骤和运维日志筛选统一中文显示，并明确日志采集与搜索范围。0.2.1 使用中文消息类型标签，并按原生来源区分用户输入与注入上下文。0.2.0 按 Context Insights 与原生 Trajectory 的查看任务重新组织界面：

1. 左侧按标题、目录或 ID 搜索原生会话；共享宿主会话目录，不要求记住 ID，也不预先解码所有历史正文。
2. 选择一次 Turn，在执行链中查看模型请求、工具、重试和时间段；节点带真实内容预览。
3. 右侧“输入 / 输出”直接查看用户输入、模型输出，或工具参数与结果。
4. “请求上下文”按该次请求之前的原生 surface 重建 system/user/assistant/tool/developer 消息；“工具定义”显示该次请求生效的完整工具 schema。
5. “源事件”按需打开脱敏原始记录。长正文按每页 16,384 字符读取，可翻页查看后续内容；200 万字符的总显示预算有明确提示。
6. 关联日志留在详情 Tab；宿主运维日志独立为次级入口。身份、配置与采集健康信息采用折叠展示。

按页读取的原生内容只返回给已经通过宿主认证的本地浏览器，不复制进派生 SQLite 索引、不外发。查看历史不会创建模型请求或重跑工具。真实模型调用仍按先前要求留待配置；本轮可以读取已有的真实历史记录。

推荐先用隔离目录验证，不要将自动化测试指向日常数据：

```sh
DSH_HOME=/absolute/path/isolated-home dsh plugin --profile web add /absolute/path/dsh-observe-0.2.2.tgz
DSH_HOME=/absolute/path/isolated-home dsh web
```

当前没有额外配置项。可见执行页运行中约每秒刷新、空闲约每 5 秒刷新；隐藏页面暂停轮询。正文按需加载，不反复刷新。执行链每页 50 条，上下文/工具定义每页 30 条。

## 数据与内容边界

数据位于 `$DSH_HOME/storages/dsh-observe/observe.sqlite`。Session 是原生事实来源；插件只读原生日志，不调用 Agent resume、模型或工具来补历史。

- SQLite 使用独立 Worker、单写入者锁、WAL 和连续水位事务。重复索引不重复计数；重启时未闭合节点先标记未知，等待后续原生证据。
- 模型用量来自原生上报；缺失显示未上报。执行停止与任务是否成功分开，`taskOutcome` 当前始终为 `not_evaluated`。
- 0.2.0 新增显式正文查看接口，保留密钥、认证信息、URL 参数和 replayState 脱敏；二进制 data URI 省略。日志摘要仍限制为 8 KiB。正文和配置中的任意自然语言秘密无法保证全部识别。旧的 `events.get` 元数据接口继续保留。
- 请求上下文表示原生日志中当时可见的消息与工具定义，不声称是提供方 HTTP 传输体。未记录的网络 headers/adapter 最终序列化不可凭空还原；缺失插件消息投影时显示无法重建，不冒充完整输入。
- 运维日志采集 error/warn/info，debug 不采集；保存 7 天，逻辑预算 256 MiB。预算针对日志，不限制整个索引库或 WAL 的物理大小。身份绑定不随日志清理删除。
- 采集队列 2,048 条、临时模型进度 128 个、待冷读请求 64 个；冷读串行。单会话最多接受 100,000 条事件，开放节点、输入消息等也有上限，超限明确显示索引失败并保留源文件。
- **原生 Session Query 会先准备完整日志，然后才执行插件事件数限制。** 大正文的解码和内存成本仍由原生实现决定；十万条事件上限不是内存保证。

保留六个自有只读端点： `/api/dsh-observe/{health.get,runs.list,runs.get,runs.nodes,logs.list,events.get}`，并新增 `requests.get`（请求检查器）与 `content.get`（脱敏正文分页）。全部使用原生 RPC 信封和 Connection 的认证、Host/Origin 校验。请求体上限 16 KiB；RC.2 HTTP bridge 在超限时可能直接关闭连接。浏览器没有身份写入端点，也不能输入任意数据库路径或 SQL。

## 可信业务身份接入

原生 Web 的认证 operator 不等于业务用户。没有外部身份接入时显示“未提供”，不虚构 userId 或 Agent 定义。

受信 Host 插件可以声明 `inject: ['dshObserve']`，在已取得可靠业务身份后调用：

```ts
const result = await ctx.dshObserve.bindContext({
  sessionId,
  requestId,                 // requestId / messageId 至少一个，必须来自实际提交
  userId: principal.userId,
  sourcePlugin: 'my-integration',
  // tenantId, agentDefinitionId, agentVersion 为可选元数据
});
if (!result.ok) throw new Error(result.error);
```

只有实际消费对应 request/message 的 Run 才获得关联；不同会话隔离，重复相同绑定幂等，冲突返回 `binding_conflict`。`boundAt` 由 Host 记录，晚于 Run 起点的标记为迟到绑定。`sourcePlugin` 是受信插件声明的来源，不是额外的身份验证机制。当前仍是原生共享 operator 权限模型，没有企业多租户访问隔离。

## 升级、停用与回退

升级前正常关闭 Host，备份整个 `storages/dsh-observe/` 目录，再安装新 tarball 并重启。schema 升级先备份 SQLite；未知 schema、损坏库或写入者锁冲突会拒绝启动插件，不自动删库。

停用可在原生插件管理界面完成；卸载后重启：

```sh
dsh plugin --profile web remove dsh-observe
dsh web
```

正常卸载会停止采集、排空已接受记录、关闭 Worker，保留观测库与原生 Session。回退插件版本时，如果旧版不能读取新 schema，应在 Host 关闭后恢复升级前的观测目录备份。当前没有浏览器端删库或全量重建入口。

## 开发与验收

```sh
npm ci
npm run check
npm test
npm run verify:host           # 需本机安装固定版本 DSH；记录源码 hash 并验证冷日志契约
npm run benchmark             # 10 万日志 / 10,002 节点的合成基线
npx playwright install chromium
npm run test:web              # 全新临时 DSH_HOME，自动安装/重启/卸载，零模型调用
npm pack                     # prepack 自动执行类型检查和测试
```

已有 Chromium 可通过 `DSH_TEST_CHROME=/absolute/path/to/chromium npm run test:web` 指定。
浏览器验收仅创建自己的临时 Host 和数据目录，完成后删除；不会修改日常 profile。测试结果在 `docs/verification/`，本机截图和 tarball 在忽略的 `.test-results/`。

[实施计划](docs/DSH-Web-0.2.0日志链路插件开发实施计划-2026-10-16.md)记录里程碑与范围调整。OTLP、外部观测平台、Python/Gateway 和跨进程链路属于后续阶段。


运维日志搜索匹配插件启用后采集的错误、警告和信息级诊断摘要，支持连续关键词子串（英文字母忽略大小写），来源字段要求完整精确匹配。它不检索聊天、模型请求上下文或工具正文，也不会从历史会话补录过去的运维输出。会话/轮次/节点筛选依赖明确关联标记；没有标记的记录可通过“未关联会话的日志”或“全部运维日志（跨会话）”查看。界面分别提示无采集记录与筛选未命中，并提供清空筛选。
