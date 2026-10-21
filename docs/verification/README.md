# dsh-observe 0.2.1-rc.2 验收记录

日期：2026-10-21。插件版本与本机 DSH `0.2.1-rc.2` 对齐，Cordis 为 `4.0.5`，Node 为 `24.19.0`。沿用 schema 2，保留原有功能。此次验证使用临时 DSH_HOME，没有改动日常 Web profile，也没有发起真实模型、工具或子 Agent 调用。

## 实现复查与优化

- 队列溢出或冷读失败后释放会话的调度标记，后续原生事件可以重新触发历史补读，避免会话长期停在不完整状态。日志仍受原有队列上限约束，丢弃计数保留。
- 对已经完整索引、没有新增事件的会话，成功重试会清除数据库中的旧错误；内存与持久化健康状态恢复一致。
- 使用新宿主的 `connection.browserPeer`，通过真实插件挂载后的 HTTP 适配器验证 Run 中的身份来源。反复卸载仍会释放端点并排空已接受日志。
- 包版本、运行时常量、锁文件和 DSH 依赖统一为 `0.2.1-rc.2`；新增版本一致性检查。宿主契约脚本从包声明读取验证基线，并核对实际 Cordis 版本。
- 浏览器脚本适配新宿主的“开始使用”弹窗，通过关闭按钮继续无凭据验收。

三类恢复回归测试均先在旧实现中失败，再在修复后通过。没有增加运行时依赖或数据库迁移。

## 验证结果

| 检查 | 结果 |
|---|---|
| TypeScript 类型检查与构建 | 通过 |
| 自动测试 | 74 项通过，0 失败，0 跳过 |
| 本机宿主契约 | 13 类 fixture 与大日志样本通过 V4 冷日志关系校验 |
| 合成性能检查 | 100,000 条日志、10,002 个节点通过脚本断言 |
| 隔离浏览器验收 | 通过：安装、正文/日志、认证、分页、主题/窄屏、重启、卸载 |

[源码指纹](source-manifest.json) 记录本机宿主来源；[性能测量](benchmark.json) 记录本次合成数据结果；[浏览器验收](web-smoke.json) 和 [制品记录](release.json) 记录全部阶段及包指纹；最终 tarball 的 SHA-256 与浏览器实际安装的包一致。性能数据不代表真实模型请求或极端大正文的峰值内存。

## 历史与兼容边界

此前插件 `0.2.2` 的验收与真实历史抽查归档于 [0.2.2](0.2.2/README.md)；更早记录见 [0.2.1](0.2.1/README.md)、[0.2.0](0.2.0/README.md)、[0.1.0](0.1.0/README.md)。顶层 `installed-history.json`、`log-search-analysis.json` 与 `target-session-log-audit.json` 仍是 2026-10-16 的历史证据，不作为此次验证结果。

版本号按宿主基线调整，因此从原插件 `0.2.2` 或本地 `0.2.3` 切换时需要显式安装 tarball。此次没有安装到日常 profile，未发布 npm，也未创建 Git tag。

正文脱敏仍不能保证识别任意自然语言中的秘密；原生 Session Query 可能先解码完整历史。真实模型与并行工具/子 Agent 执行未验收；现有共享浏览器身份不提供企业多租户隔离。

## 复现

```sh
npm ci
npm run check
npm test
npm run verify:host
npm run benchmark
DSH_TEST_CHROME=/absolute/path/to/chromium npm run test:web
npm pack --pack-destination dist
```

安装与回退方式见 [项目 README](../../README.md)。
