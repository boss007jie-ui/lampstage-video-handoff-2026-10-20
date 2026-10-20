[待验收]

# 视频 backend Wave 1：RunningHub 官方接口适配与未知提交保护

依据：用户已批准自有 Agent 方案并要求统筹分派实施。先读 `AGENTS.md`、`tasks/LAMP-AGENT-CONTROL.md`、总方案第 3/5/7/8 节。当前只新增 backend，不切换正在使用的视频链路。

## 独占范围

`apps/web/lib/video/backends/**`、`apps/web/scripts/tests/agent-video-backend-*.test.ts`、本任务单、`.codex-tmp/commerce-agent/video/`。不改现有 processor/sixref-processor/hypit-runner/types/routes、Worker/package/schema、Expert、部署。

## 只读依据与来源

- 我方 `lib/video/types.ts`、`reference-inputs.ts`、`hypit-runner.ts`（仅我方适配代码）、`processor.ts`、`sixref-processor.ts`、`upstream.ts`、`media.ts`。
- 官方文档 `https://www.runninghub.cn/runninghub-api-doc-cn/`，AI应用提交 api-425749010、状态 api-425749003、结果 api-425749004；确认具体文档内容再实现，不能假定所有网关协议一致。
- 禁止阅读/复制 Hypit 上游代码。现有FFmpeg合成已存在，本任务不引入HyperFrames。

## 任务

1. 新建 `backends/contracts.ts`：backendId、capabilities、submit/status/results、可选cancel、attempt/intent；严格区分 definite_not_submitted、accepted(taskId)、submission_unknown。
2. 新建 RunningHub request builder、response parser 和 transport adapter。只使用显式注入的请求函数、假测试凭据/配置；默认不自动读取环境或发起网络请求；请求体可含供应商必需的key但绝不进入日志/异常/公开返回值。
3. nodeInfoList 映射从显式验证过的应用配置注入，不猜固定nodeId，不从Hypit provider复制。当前具体应用的6参考/窗口/音频能力未实测，capabilities必须诚实表达未知/未启用。
4. submit不做自动重试；网络断连/无法确定提交结果进入unknown；已有taskId的轮询只查询原任务。可确定的业务拒绝和可重试只读错误分别分类，所有错误对外只输出安全代码，不透传原body/URL/凭据。
5. 添加 backend registry/选择边界，job/attempt固定backendId；运行中不能随全局默认变化换后端；不实现未验证的供应商取消或账单能力。
6. 说明如何在下一批接入现有permit、review_token、reconcile、candidate和FFmpeg。列出官方字段已确认/当前应用字段未验证/真实调用需后续授权三类。

## 验证

fake transport 覆盖submit成功taskId、明确拒绝、HTTP/网络超时、非法JSON、未知状态、running、completed输出、failure、签名URL过期/重新查询、取消不支持；断连不得自动再次submit；原始错误/凭据不得出现在异常或公开结果；不调用Hypit CLI；默认能力不会声称当前应用未验证的6参考能力已可用。

测试名 `agent-video-backend-*.test.ts`；只运行注入fake的测试。公开官方网页只读可以查，不得访问用户凭据文件或创建付费任务。

## 完成记录

交付实际代码、测试输出、官方文档链接和确切协议证据、接口导出、尚未验证的应用语义；声明没有触碰Hypit上游实现，任务改 `[待验收]`。不得宣称“已完成生产去Hypit化”。

## 执行记录（2026-10-16）

### 已实现与文件清单

仅在独占范围写入以下文件，保留现有未提交工作，没有切换分支、commit/push、部署、schema/package/公共入口改动：

- `apps/web/lib/video/backends/contracts.ts`：`VideoGenerationBackend`；绑定 userId/runId/jobId/stepKey/inputDigest/attemptId/backendId 的 attempt；带 fencing 的 intent；一次性 `VideoSubmissionGate` 端口；accepted / definite_not_submitted / submission_unknown；只读错误分类；私有结果与公开投影；可选取消边界。
- `apps/web/lib/video/backends/runninghub-protocol.ts`：显式配置的 nodeInfoList 请求 builder、注入式 transport 类型、提交和 outputs 纯 parser；无固定应用节点；安全错误码；大整数 ID 保持字符串。
- `apps/web/lib/video/backends/runninghub.ts`：`createRunningHubBackend`；默认无环境读取/网络请求；一次性门禁后最多提交一次；网络/HTTP/解析不确定保持 unknown；请求超时及 AbortSignal；安全日志；配置快照与配置摘要；凭据反射保护。
- `apps/web/lib/video/backends/registry.ts`：`VideoBackendRegistry` 和 `VideoJobBackendBinding`；job/attempt 绑定后不随默认后端变化迁移，不自动 fallback。backendId 纳入账户、应用、映射、协议与配置 SHA-256，修改节点但漏升版本也会拒绝旧 intent。
- `apps/web/lib/video/backends/README.md`：确切协议字段、旧/新查询差异、已确认/未验证/需后续授权三类证据、permit/review_token/reconcile/candidate/FFmpeg 的下一批接线说明。
- `apps/web/scripts/tests/agent-video-backend-runninghub.test.ts`、`apps/web/scripts/tests/agent-video-backend-registry.test.ts`：首次交付 25 项，P2 修复后共 27 项离线测试（最新验证见文末）。
- 本任务单；`.codex-tmp/commerce-agent/video/` 内的基线路径记录、测试 TAP、局部类型检查输出。

### 官方协议核对与采用决策

根据统筹在本对话追加的授权，重新核对当前替代协议，不受原任务单旧文档 ID 限制：

1. [AI 应用提交](https://www.runninghub.cn/runninghub-api-doc-cn/api-425749010)确认 POST `/task/openapi/ai-app/run`，Bearer + JSON `apiKey/webappId/nodeInfoList`，节点为 `nodeId/fieldName/fieldValue`。[AI 应用接入示例](https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287339)确认 `code:0`、`data.taskId` 回执。
2. [旧 status](https://www.runninghub.cn/runninghub-api-doc-cn/api-425749003)标将废弃，接入示例称已停止维护；实现不调用它。`status()` 与 `results()` 均使用官方 AI 应用示例的 [outputs](https://www.runninghub.cn/runninghub-api-doc-cn/api-425749004)，请求 `apiKey/taskId`；成功数组 `data[].fileUrl/fileType`；依据[高阶示例](https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287340)及[错误码表](https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287338)识别 804 运行、813 排队、805 失败。该 outputs 端点本身也标将废弃，不能作为生产长期兼容保证。
3. 已核对正式 [V2 query](https://www.runninghub.cn/runninghub-api-doc-cn/api-425767306)：POST `/openapi/v2/query`，Bearer，JSON 仅 taskId；顶层 `status/results[].url/outputType/errorCode/errorMessage`，与旧 `code/data[].fileUrl/fileType` 不同。可见官方资料没有明确确认它接收旧 AI 应用提交产生的 taskId、Key 类别兼容性及完整状态枚举。本批保留有 AI 应用接入示例支撑的旧 outputs 协议并显式命名 `legacy-outputs-v1`；不静默迁移，也不混合解析。未证明兼容不等于证明不兼容，下一批可取得官方补充证据或已授权只读查询证据后新增协议版本。
4. 未发现官方对结果 URL 有效期及重查必定更新 URL 的保证。测试模拟过期返回 403 后查询同一 taskId 获得新链接，证明无缓存/无重提路径；不承诺供应商实际刷新。`expiresAt` 为 null。

### 首次交付实际验证（最新 P2 验证见文末）

在 `apps/web` 执行（只用已安装的工具，无依赖安装）：

```powershell
.\node_modules\.bin\tsx.cmd --test scripts/tests/agent-video-backend-registry.test.ts scripts/tests/agent-video-backend-runninghub.test.ts
```

实际末尾输出：

```text
1..25
# tests 25
# suites 0
# pass 25
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 511.1798
test_exit_code=0
```

完整输出：`.codex-tmp/commerce-agent/video/offline-tests.tap`。

独占文件局部严格类型检查（不运行全局 tsc，不产生共享增量缓存）：

```powershell
.\node_modules\.bin\tsc.cmd --noEmit --incremental false --strict --target ES2022 --module esnext --moduleResolution bundler --esModuleInterop --skipLibCheck lib/video/backends/contracts.ts lib/video/backends/registry.ts lib/video/backends/runninghub-protocol.ts lib/video/backends/runninghub.ts scripts/tests/agent-video-backend-registry.test.ts scripts/tests/agent-video-backend-runninghub.test.ts
```

实际无诊断输出，退出 0，记录 `.codex-tmp/commerce-agent/video/isolated-types.txt` 中 `isolated_typecheck_exit_code=0`。

开发过程中局部类型检查曾发现 submit 参数隐式 any，已加类型修复；新增畸形凭据能力声明测试曾实际失败（true !== false），修正后最终全通过。两份测试在对应实现文件建立前运行曾报模块缺失；不把这种加载失败当作业务断言验证。一次带 `|` 的测试名称过滤命令被 Windows cmd shim 解释失败，未用于验收；最终使用无过滤完整测试命令。

故障覆盖：明确拒绝、HTTP 400/401/403/408/429/5xx、断连、非法 JSON、缺失/不安全 taskId、矛盾回执、未知状态、排队/运行/完成/失败、任务不存在、签名 URL 过期后同任务重查、取消不支持、并发/跨实例门禁、真实计时器超时/晚到回执、默认后端变更、配置冻结与映射漂移、原始异常/URL/凭据不进入公开错误或日志（含数字凭据反射）。全部 transport、gate、凭据与 URL 都是离线假数据。

只读子代理实际 spawn 参数：协议核对 `gpt-6-luna` / `low`；代码审查 `gpt-6-sol` / `medium`，均 `fork_turns="none"` 且未写文件。审查指出的数字凭据反射与映射同版本漂移已由主代理修复，审查者随后静态复核通过；测试结果由主代理执行取得，不以子代理自述代替测试。

### 未做、限制与下一批

- 本次为离线协议/契约实现完成，未接入生产链路，**不是已完成生产去 Hypit 化**。当前 mode、六参考、源视频窗口、时长/音频能力保持未知/未启用；registry 拒绝给新业务 job 选择未验收 mode。
- `VideoSubmissionGate` 只有契约及测试假实现；尚无数据库事务、持久化 CAS/fencing、审批/预算/permit 实现。下一批必须原子写 intent 并持久化回执；unknown 不释放占用、不自动重提。内存测试不能证明生产跨进程防重。
- 后续接线沿用 review_token、permit、reconcile、candidate 检查/审阅和 FFmpeg 合成。真实媒体收取、存储、安全校验及用户验收尚未完成。供应商取消/退款/账单能力未实现。
- 没有读取用户凭据文件或凭据值，没有认证验证，没有真实模型/图片/视频任务、付费探测、Hypit CLI 调用或 Worker 启动。
- **是否为复刻目的触碰 Hypit 上游源码：否。** 仅依据官方文档及我方契约/调用边界；未新增第三方依赖。
- 按统筹约定未跑全局 `npm run typecheck`、`npm run video:test` 或生产/数据库回归，由统筹验收时串行执行。
- 需要下一批裁定：数据库 gate/回执落库接线、V2 与当前 AI 应用兼容性证据、当前应用真实节点映射和按模式验收；本批没有需要用户再次确认才能完成的操作。

## 统筹 P2 审查修复与重新交付（2026-10-16）

审查指出 HTTP 200 的明确拒绝码同时带数值/非法非空 taskId 时，旧实现会误归类为 `definite_not_submitted`。源码与失败测试已复现，现已修复。

- `runninghub-protocol.ts` 独立检查 `data` 是否实际包含 `taskId` 字段，不再用 ID 格式校验的结果来判断字段是否存在。字段存在但不可安全使用时返回 `submission_unknown/submission_conflict`，不回传数值、非法字符串、对象、数组、布尔值或显式空值；安全字符串可以保留用于核对。大整数不会被强制转字符串或据此释放未知提交占用。
- 新增 2 项测试：全部 12 个明确拒绝码 × 9 类非空/非字符串非法 ID，覆盖 parser、注入 fake transport 后端、重复提交被阻止和 HTTP 非成功；另覆盖字段完全缺失与显式 null/空字符串/空白字符串的区别。保留原 25 项断言。
- `backends/README.md` 同步说明字段存在与 ID 可用性的区别。
- 仅修改上述协议文件、独占测试、README、本任务单及独占测试记录；没有扩大范围，没有付费调用或凭据读取，也没有触碰 Hypit 上游实现。

红灯验证使用与上文相同的完整两文件 tsx 命令，实际输出 `tests 27 / pass 25 / fail 2`，退出 1；两处失败均为实际返回 `definite_not_submitted` 而预期 `submission_unknown`，记录为 `.codex-tmp/commerce-agent/video/p2-task-id-red.tap`。

修复后重新运行相同完整命令，实际输出：

```text
1..27
# tests 27
# suites 0
# pass 27
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 462.9118
test_exit_code=0
```

完整输出 `.codex-tmp/commerce-agent/video/p2-task-id-green.tap`。重新运行上文所列六个独占文件的严格局部 tsc 命令，无诊断，退出 0；记录 `.codex-tmp/commerce-agent/video/p2-task-id-types.txt` 中 `isolated_typecheck_exit_code=0`。

状态恢复为 `[待验收]`。全局检查仍留统筹串行执行，原有生产集成和应用能力限制不变。
