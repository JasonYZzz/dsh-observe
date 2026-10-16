# dsh-observe 0.1.0 候选版验收记录

日期：2026-10-16。范围为 `JasonYZzz/dsh-observe` 的本地独立 Bundle。已完成首期功能开发与非真实调用验收；**按用户指示，真实模型、实际工具执行和子 Agent 调用留待模型配置后验收**。当前是本地候选包，没有发布 npm 或推送 GitHub。

## 可复现环境与制品

| 项目 | 已验证内容 |
|---|---|
| 宿主 | `@deepseek-ai/dsh@0.2.0-rc.2` |
| Cordis / Node | `4.0.4` / `24.19.0` |
| 本机 | macOS / arm64 / Apple M5 |
| 安装 | 全新临时 DSH_HOME 中通过 `dsh plugin --profile web add <tarball>` 安装 |
| Client | 原生 ModuleLoader、React、UI primitives、locale、主题与 Slots |
| 构建 | `npm ci`、`npm run check`、`npm pack` 的 prepack 检查通过 |
| 自动测试 | 50 项通过，0 失败，0 跳过 |
| 发布内容 | 32 个文件；Host、Client、Worker、类型、Bundle patch、README、MIT LICENSE |

制品与锁文件的 SHA-256 见 [release.json](release.json)，原生契约源码的 13 个 hash 见 [source-manifest.json](source-manifest.json)。本次构建来自尚未提交的工作区，不能将仓库原 HEAD 当作插件实现的源码版本。

```sh
npm ci
npm run check
npm test
npm run verify:host
npm run benchmark
npm run test:web
npm pack --pack-destination dist
```

`verify:host` 核对本机固定版本安装并验证所有 fixture 的原生 V4 冷日志关系约束。`test:web` 需要 Playwright Chromium，支持 `DSH_TEST_CHROME` 指定已有可执行文件。测试临时目录自动清理，本机截图在忽略的 `.test-results/`。

## A01–A16 验收对照

“fixture”指合成、脱敏的原生 Session 事件，**不代表模型或工具实际执行**。

| 编号 | 结果与证据 | 边界 |
|---|---|---|
| A01 原生安装 | 全新 profile tarball 安装、全局入口和会话 Tab 通过 | 固定 RC.2 |
| A02 模型/工具层次 | fixture 验证 Turn/Step/Attempt/Tool、用量、停止原因；浏览器检查工具节点 | 真实调用待配置 |
| A03 工具并行/嵌套 | callId 配对、PTC 父子、两会话隔离、缺失结果 unknown | 真实并行工具待配置 |
| A04 重试 | 失败尝试、等待、成功尝试和缺失用量；retry fixture 通过原生冷读 | 未发送真实 429 请求 |
| A05 子会话/fork | catalog 只作为血缘证据，继承前缀不计入子运行；原生冷读通过 | 实际子 Agent 调用待配置 |
| A06 压缩/裁剪 | 失败压缩、成功 summary、替换范围、无模型 prune；原生冷读通过 | 合成摘要，不调用摘要模型 |
| A07 取消/截断 | cancelled/truncated/blocked/unknown 区分；任务结果不虚报成功 | 合成停止事件 |
| A08 可信身份 | 并发会话同 requestId 不串线、幂等/冲突、迟到绑定；浏览器写入口 404 | 共享原生 operator，无多租户鉴权 |
| A09 多输入/队列 | Inbox 只在实际消费时关联 request/message 和等待时长 | 不推算完整 HTTP 请求耗时 |
| A10 历史只读 | 原生 observeSession/readEvent，释放 lease；查询前后源文件 SHA-256 不变；历史会话仍为非活动 | 未调用 resume 或重跑工具 |
| A11 中断恢复 | Worker terminate、未闭合运行 unknown、后续事件恢复；真实 Host SIGKILL/重启与失效锁接管 | 不能恢复强杀前未持久化内容 |
| A12 存储恢复 | 水位事务、重复导入、重建保留日志/身份、schema 备份、损坏库原样保留、只读目录拒绝 | 重建仅为内部操作，没有浏览器删库入口 |
| A13 认证/脱敏 | 原生 401、错误 Host/Origin 403、输入校验、16 KiB 限制、秘密脱敏、源事件元数据白名单 | RC.2 bridge 超限可能关闭 TCP；自然语言秘密无法穷举 |
| A14 官方遥测 | 官方 Coordinator 对照测试：导出内容与序列完全相同，重复 capture 不重发；本插件不提供 sessionTelemetry | 没有调用真实反馈后端或外发网络 |
| A15 生命周期 | 十次装卸、exporter/RPC/Worker 释放、接受日志先排空再关库；真实卸载后原生 Web 可用且保留库 | 正常卸载排空；强杀仅保证已落盘部分 |
| A16 UI/查询 | 深浅主题、390px 窄屏、键盘选择、节点定位刷新、50 行分页无重复、过期结果抑制、隐藏停止/恢复轮询 | 分页代替虚拟化；未做全量读屏器审计 |

原生持久化 fixture 共十一类：success、failure、retry、cancel、subagent、compaction、nested、fork、recovery、summary、prune。另有 3,334 Step / 10,002 节点的大样本。浏览器运行的精确检查阶段和样本冷读指标见 [web-smoke.json](web-smoke.json)。

## 性能实测与含义

[benchmark.json](benchmark.json)记录 10 万条日志、10,002 节点、16,672 条事件元数据的本机合成结果。查询在独立 SQLite Worker 中执行，页面/API 均分页；全文搜索为有界返回的文本扫描，没有额外搜索服务。

| 项目 | 本次结果 |
|---|---|
| 单条 summarize 元数据转换 p95 | 0.0007 ms |
| 50 节点页查询 p95 | 0.169 ms |
| 50 日志页查询 p95 | 0.108 ms |
| 10 万日志全文无匹配扫描 p95 | 36.303 ms |
| 合成事件导入 / 10 万日志导入 | 754.3 / 515.7 ms |
| 测试进程 RSS 前 / 后（包含 Worker） | 约 71.6 / 131.8 MiB |
| 观测库 / WAL | 约 32.4 / 4.5 MiB |

这组值不是模型或工具调用开销，也不是整个同步监听器的延迟。原生 JSONL/Zstandard 大日志准备与“准备 + 派生索引”另见 `web-smoke.json` 的 `nativePreparation` / `indexedLargeMs`：前者是原生读取单次测量，后者包括 RPC 和索引，不能相减当作精确插件开销。RSS 是采样值，不是峰值；其中还包含 Host、Web 和测试样本创建成本。

仍有这些明确限制：

- 原生 Query 在插件判断 100,000 事件上限前已准备完整日志。大量正文仍可能占用较多内存；事件数量限制不等同于内存上限。
- 当前只测了本机 JSONL/Zstandard 合成历史，没有覆盖全部存储后端、操作系统和极端大正文。
- “相对原生工具/模型端到端耗时增加约 5% 以内”的目标尚未验证，不能用快速 SQL 查询结果代替。
- 不宣称适配其他 RC、正式 0.2.0、远程 OTLP、跨进程身份传播或企业权限隔离。

## 本轮实现调整与问题修复

- RC.2 `/api` 单例 RPC interceptor 已由 Gateway 占用，改为六条精确 Connection Fetch 路由，仍使用官方 RPC schema/信封与原生认证。
- 干净 DSH profile 禁用 peer 自动安装，运行时使用的原生包改为显式固定 dependencies；实际 tarball 安装验收。
- Cordis 以并行方式运行 disposer，改为一个清理 owner 先排空 Capture 再关闭 Worker。
- Cordis 日志阈值使用 `levels.default`；避免错误的阈值键静默漏掉 warn。
- 原生 V4 冷读比内存 Session 更严格，补齐 retry 的 request/header，验证完整生命周期关系。
- 工具结果的 surface replacement 只修改历史表面，不计为新执行；轮次外摘要不再绑定已结束 Run。
- Native Agent ID 可在 Turn 开始后才出现，后续原生证据会补充到当前 Run；历史中没有证据仍为 null。
- 源事件采用白名单投影，省略第三方私有字段；当前只查看元数据，不开放正文。

## 待配置后完成

按照用户指示，本轮不发起真实模型调用。下一轮在可用的隔离配置中验证真实模型、实际工具、实际并行/嵌套工具、子 Agent、真实取消/重试及端到端开销；单独记录结果，不将本记录的 fixture 标记改为真实调用。

升级、停用、保留策略、可信身份接口和回退操作见 [项目 README](../../../README.md)。
