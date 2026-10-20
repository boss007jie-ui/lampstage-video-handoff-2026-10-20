[待验收]

# 视频 Wave 2：持久提交门禁、原任务恢复与候选收取

依据用户已授权的本地实施。W1 backend 已验收，CORE-W2 已验收并冻结。本文经统筹定稿和明确派发后执行；真实 RunningHub mode 仍未验收，不开放业务能力。

## 文件所有权与验证时序

- 原“Lampstage Agent｜视频后端”聊天独占新增 `apps/web/lib/video/backend-runtime/**`、`apps/web/scripts/tests/agent-video-runtime-*.test.ts`、本任务单与 `.codex-tmp/commerce-agent/video/`。可读取我方视频代码、已验收 core/backends、实际 migration。
- 本批不改 schema/migration、生成客户端、core、lib/jobs、已有 video types/permits/repository/processors/worker、route/MCP、UI、Expert 或 package/lock。独立 runtime 的版本化 binding 在新目录解析 `VideoJob.data`，无需修改旧类型。需要共享旧代码的改动先列出，由统筹另批明确授权；不自行扩范围。
- PrismaClient 和 transport/storage/媒体验证依赖显式注入，不导入生产 DB 单例或自动加载环境密钥；不会被现有生产路由或 Worker 自动导入。本批所有业务 job 仅来自全新隔离库夹具。
- 图片聊天当前独占 schema/client 写入。**先实现代码、纯测试及数据库测试文件；在统筹确认图片 schema/client 冻结并通知前，不运行数据库测试或 Prisma generate。** 局部类型检查可使用当前已生成的既有 VideoJob/Permit/Agent 类型，不依赖新图片模型。收到通知后，实际执行隔离 DB 验证再交付；不得将暂未执行标为通过。
- 隔离数据库使用只读的 `scripts/tests/helpers/isolated-agent-postgres.ts`，真实完整 migrations；不改共享 helper、不连接既有业务库，不启动真实 Worker，不真实付费/存储调用，不 commit/push/deploy。不得为替代实现阅读 Hypit 上游源码。

## 本批闭环

已有、归属正确且准备/审阅完成的测试 VideoJob → core 事务准备器绑定 → 显式 jobId 的有界 runtime → 原子 gate 取得 permit 和唯一提交意图 → 注入 backend 提交一次 → 原任务查询 → 幂等收取候选 → 逐片段结算。

不在本批实现真实素材上传到供应商、全队列领取、真实应用节点填表、旧任务切换、视频拼接或 UI。不是把 `submitH3` 换名后沿用旧 buildId 分支。

## 1. 身份、绑定与执行权

- `VideoJob.data` 内保存带版本号的 runtime 私有绑定：user/run/step/coreAttempt、approval ID/revision、backendId、非密钥 accountId、configurationDigest、固定输入/消费审阅摘要。每片段固定 slot attempt、permit attempt、intentId、inputDigest、submissionState、providerTaskId 和产物 receipt。缺失/不支持版本拒绝，不按当前默认 backend 猜测历史配置。
- core 父 attempt 是一个业务 job；每片段有稳定子 attempt。现有 permit ID 为 `job:index:attempt`，core slot ID 不接受冒号，因此保存显式稳定映射，不直接复用非法 ID，不在恢复时生成新 attempt。
- core lease/fence 与 VideoJob 执行权分开。新 runtime 在自己的 binding 保存单调 fence，依赖数据库可信时间；claim/heartbeat/observe/release 均检查 jobId+owner+fence，不仅比较 owner 字符串。core 返回 pending 后释放自身 lease，不应阻止原业务 job 恢复。
- 为与旧 permit 的 orphan 判定共存，claim/heartbeat/release 同事务维护现有 `VideoJob.lease_owner/lease_until` 列；执行中的 `status=generating`、`phase=render` 及顶层 `data.segments[index].attempt` 必须与 permit 映射一致，不能只更新私有 binding。binding 内 fence 仍是新 runtime 的实际代际校验。
- 仅显式 jobId 领取，不轮询共享队列。没有新 binding 的旧 job 或有旧 buildId/providerTaskId/submissionIntent 的 job 不被新 runtime 接管。旧 Worker 目前不识别此绑定；正式排队前需要另批 dispatcher/claim 隔离，因此本批不注册到旧调度，也不对既有业务库创建可领取任务。

## 2. 消费审阅与准备器

- Agent 审批不能代替视频消费同意。消费记录必须绑定用户已审阅的素材/窗口/片段集合、明确 maxCoins、pricingBasis、报价版本，以及新增 backendId/configurationDigest；不得沿用缺少 backend 身份的旧 token。提供新的稳定审阅摘要及服务端校验，使用本地可信测试审批/消费记录验证。
- core `BusinessPreparer` 仅绑定同账户、准备完成、从未提交的测试 VideoJob；同事务核验计划/批准输入、建立父/子尝试及共享 slots、固定消费记录、返回原 jobId。业务 job 不重复创建，不调用旧 HTTP/MCP、文件下载或另开事务。
- 素材、节点 values 和配置从持久、服务端验证的准备结果取得；不接受模型传入的 userId、审批、accountId、providerTaskId、存储 key 或任意 URL。素材上传协议未经证实，本批只注入 fake 准备结果，不从旧供应商实现推断。
- `video_second` 明确定义为批准的请求时长额度，按固定请求 duration 分配。RunningHub 币保持在独立消费同意/permit 中，不能换算成美元/秒。确定未受理可释放时长份额；成功或已受理后的确定终态失败消耗该次请求时长额度；未决保持占用。此额度不是实际账单，permit 释放也不是退款；币的实际消耗没有证据就保持未报告。

## 3. 原子提交 gate 与 permit

- 统一锁序：User → core Run/Approval/Step/Reservation/Slot → VideoPermitAccount → VideoJob → 当前 attempt/permit。所有会调用 core 结算的事务先锁 core，再锁视频；不能先锁视频反向进入 core。
- 新目录可实现显式 transaction 的 permit 操作，使用已有 VideoPermitAccount 行锁和 VideoPermit 表，与既有代码共享同一并发事实。固定每账户最多 3 个 active permit，任何 unknown 阻止新的付费提交；失去有效执行权的 active orphan 保守隔离为 unknown，不因 lease 超时自动释放。
- 一次有界执行结束而仍有未决 permit 时，若释放视频 lease，须把相关 active permit 保守改为 unknown 并保留 taskId；重新领取不使 unknown 自动变回 active，后续只查询原任务直到可信终态。跨 job orphan 扫描只隔离 permit，不能反向锁别的用户/core run 或代替其预算结算。
- `VideoSubmissionGate.claim()` 必须同事务验证 owner、父绑定/审批 revision、当前计划/取消、消费同意、素材/config 摘要、视频 fence/lease、账户并发额度，并写唯一 submitting 意图和 permit 后返回 claimed。不调用自行开启事务的旧 `acquireVideoPermit()`。
- 已有 submitting/accepted/unknown 或已终态的同 intent 先于后来失效的审批判断，返回 already_claimed；不能变成 definite_not_submitted。任何失败都不触发 POST；回滚不留下部分 permit/意图。
- gate 事务提交是取消与提交竞争的裁定点：取消在 gate 提交前生效必须零 POST；gate 已提交后即进入可能已发送窗口，不能把数据库取消与网络 POST 视为同一原子操作。此后取消不得删除 intent/释放未知 permit/允许替代提交，即使尚未观察到 POST；尽力停止只保留保守恢复语义。
- 不能修改 W1 RunningHub 的 `enabledModes=[]`。新 runtime 真实 submit 必须按持久模式与实际 capabilities 检查；成功路径用独立 fake backend，RunningHub adapter 仅用 fake transport 做协议测试。模式未验收不能用“测试开关”放行真实 backend。

## 4. 提交、恢复与结算

- backend.submit 一次性执行，gate 后不重试、不更换 backend/model/account。accepted 保存 taskId；HTTP 矛盾/断连/回执落库失败等进入 unknown，保留原 intent 和 permit，重启只查询原任务或本方产物。
- known taskId 始终从受归属检查的持久记录取得。查询失败、404/不可见、未知状态都不证明失败或未提交。当前配置变化时使用固定历史配置；缺失历史配置安全停下，不用新配置重新生成。
- 取消阻止新发送，但已提交/unknown 仍保留恢复和收取责任，不能释放未知占用。旧 fence 不能回填、释放 permit 或更改新租约。已验证终态更新 job、permit 状态和 core slot 结算必须处于同一事务。
- core 已有 jobId 后不返回 core not_submitted：业务领域根据可信结果结算后回填父 step。未决片段存在时父步骤不终结，不能用报价上界覆盖逐片段结算。
- 子尝试的确定终态不可被迟到矛盾回执覆盖。处理 fault injection 时持久化错误必须向外传播并停止发送，而不是吞错后补发。

## 5. 候选收取

- 下载、媒体探测和对象 IO 在事务外。显式注入下载策略，限制 HTTPS、允许目标/解析地址、重定向、大小和超时；供应商 URL 只在服务端私有路径使用，不能出现在公开 job/event/错误中。
- 本地固定视频 fixture 验证真实探测结果、SHA256、请求/可接受时长、尺寸和候选 key，不把任意成功 HTTP 字节当视频。可使用既有我方 `probeMedia` 或显式注入同契约验证器；至少一个本地有效/损坏媒体测试实际验证内容。
- 按 user/job/segment/attempt/inputDigest 固定不可覆盖的存储位置与 receipt。只有完整写入、可读回校验后才发布可信 receipt/候选；同摘要重放同作品，不同内容冲突。
- 下载失败、签名链接过期、存储后回包丢失只能查询原任务或恢复本方产物，不重新生成。无法收取时保留可恢复状态；何时释放已知供应商终态的并发名额与业务收取状态应明确分开，但未知提交一律不释放。

## 6. 必须验证

纯 fake 测试先执行；数据库测试等统筹冻结通知后，在两个独立 PrismaClient + 全量真实 migration 的新隔离库实际执行：

1. core 准备器同事务绑定一次、slot 分配、映射；不同用户/输入/消费范围/配置不匹配失败关闭。
2. 两个领取者并发竞争同一片段，仅一个 intent/permit/POST；重启恢复同 binding，旧 owner+旧 fence 即使字符串相同也不能写回。
3. permit/intent/映射故障点全部回滚；gate 提交前审批过期/撤销、素材或 config 改动、取消、额度占满/unknown 存在均零 POST。barrier 分别覆盖取消发生在 gate 前、gate 后、POST 后，后两者不错误释放或补发。
4. accepted、HTTP 带 taskId、无 taskId 超时、回执到达但保存失败；全程最多一次 POST，unknown 不补发。已有 intent 在审批失效后仍是 already_claimed。
5. running/completed/failed/read_error 查询和原产物恢复；未知账户阻止后续提交，已受理终态失败不伪造 RH 币退款。
6. 存储前后/receipt 发布前后崩溃、过期链接、损坏媒体、冲突内容、重复/乱序终态、跨账户产物，最终只有一个可信候选。
7. 取消与在途 unknown 并发；父 core 回填遵守同份预留和实际逐片段额度结果。
8. 旧 job/buildId 不由新 runtime 接管，真实 RunningHub 未验收模式保持关闭，公开事件无 URL/私有输入/凭据。
9. 同账户的旧 active/unknown permit 与新 runtime 共存：有效新 lease 不被旧 orphan 判定错误隔离，释放/失效 lease 后转 unknown 不丢 taskId，跨 job 扫描不反向取得 core 锁。

完成后本单标 `[待验收]`，列准确导出/文件、固定映射、实际测试命令/计数、隔离实例清理和剩余真实接线。本批不称为真实供应商验收或旧视频链路已替换。全局 typecheck 与既有 video:test 由统筹在文件冻结后统一执行。

## 交付记录（2026-10-16，最终代码与隔离 DB 阶段冻结）

本批实现文件：

- `apps/web/lib/video/backend-runtime/binding.ts`：`VideoPreparation`/`VideoConsent`/`RuntimeBinding`、类型化 `Material`、`reviewDigest`、`createBinding`、`parseBinding`、`rejectLegacy`、`intentFor`、`collectorIdentity`、`validateReceipt`、`parentOutcome`。
- `apps/web/lib/video/backend-runtime/preparation.ts`：`preparedJobDigest`、`validatePreparedJob`，复核现有业务准备快照与合法状态/phase。
- `apps/web/lib/video/backend-runtime/preparer.ts`：`prepareVideoBusinessJob`、`createVideoBusinessPreparer(storageConfig)`，只使用 core 传入事务，绑定已有 job 和共享 slots。
- `apps/web/lib/video/backend-runtime/transitions.ts`：事务内 claim/heartbeat/release/gate/observe/finalize/receipt 状态变更、同账户 permit 并发和孤儿隔离。
- `apps/web/lib/video/backend-runtime/prisma-runtime.ts`：`PrismaVideoRuntimeStore`，显式 client、统一锁序、旧 lease/attempt 镜像、同事务 job/permit/slot 更新；`after_permits`/`after_binding`/`after_slots` 故障注入。
- `apps/web/lib/video/backend-runtime/runner.ts`：`VideoRuntime` 有界显式 job 执行；`HistoricalBackendResolver` 固定历史配置；无自动付费重试。
- `apps/web/lib/video/backend-runtime/collector.ts`：`createCandidateCollector`、`candidateKey`、`candidateIdentityDigest`、`MAX_CANDIDATE_DURATION_DRIFT_SECONDS` 与显式下载/媒体/存储端口。
- `apps/web/lib/video/backend-runtime/README.md`：接线契约、状态和恢复语义、尚未接入的部分。
- 测试：`apps/web/scripts/tests/agent-video-runtime-state.test.ts`、`agent-video-runtime-collector.test.ts`、`agent-video-runtime-preparation.test.ts`、`agent-video-runtime-postgres.test.ts`。

固定映射：`childHash=SHA256(canonical({jobId,coreAttemptId,index,attempt:1}))`；core slot 为 `video.<childHash>`，permit 为 `<jobId>:<index>:1`，intent 为 `vi.<childHash>`。恢复复用原 ID；输入摘要包含完整消费审阅摘要与片段准备记录。core lease/fence 与独立视频 lease/fence 分开。

统筹审查提出的兼容问题已修正并验证：

1. 不使用不存在的 `ready/review` 任务状态组合。已有 job 必须 `status=review`，phase 与模式对应 `prepare`/`prepare_references`/`prepare_sixref`，且无人持租约、有真实已准备片段/引用、新可信准备记录及消费同意。直接/传统模式复用现有 `segmentTimeline`，8 秒夹具真实分为请求 5+4 秒、第二段 trimStart=1，core 请求时长预算为 9。任意 review、缺素材、旧 render/reconcile 阶段不能通过。
2. 源视频查 `VideoAsset`；商品/参考图查真实 `UploadedAsset → ImageContent`，固定表来源、归属、内容 ID/SHA256 和两条独立本方路径。内容去重后 asset URL 与 canonical content URL 不同仍可合法通过；错误 owner/hash/location 关闭新提交。没有伪造商品 VideoAsset。
3. `submissionIntentAt`、build/task、candidate、terminal/accepted、output、cancellation、非零旧 attempt、非空/畸形 history 在绑定前均拒绝；顶层、片段和历史回归覆盖，不新建 slot/permit。gate 也拒绝绑定之后新增的旧链路证据；只允许自身映射对应的 top-level attempt。
4. 收取策略和 receipt 发布共用 0.5 秒最大偏差，策略只允许 `[0,0.5]`；0、0.5、越界与实际时长边界均有测试。
5. 六图只要求实际逐段引用的快照，允许未使用的顶层默认引用没有 key；本批选中的 `startFromSegment` 依赖片段失败关闭，等待另批可信前段末帧接线。

最终验证均从 `apps/web` 执行：

```powershell
npx tsx --test scripts/tests/agent-video-runtime-state.test.ts scripts/tests/agent-video-runtime-collector.test.ts scripts/tests/agent-video-runtime-preparation.test.ts
npx tsx --test scripts/tests/agent-video-runtime-postgres.test.ts
npx tsc --noEmit --strict --target ES2022 --moduleResolution bundler --module esnext --esModuleInterop --skipLibCheck lib/video/backend-runtime/binding.ts lib/video/backend-runtime/transitions.ts lib/video/backend-runtime/prisma-runtime.ts lib/video/backend-runtime/preparer.ts lib/video/backend-runtime/preparation.ts lib/video/backend-runtime/runner.ts lib/video/backend-runtime/collector.ts scripts/tests/agent-video-runtime-state.test.ts scripts/tests/agent-video-runtime-collector.test.ts scripts/tests/agent-video-runtime-preparation.test.ts scripts/tests/agent-video-runtime-postgres.test.ts
```

结果：纯/fake/真实本地媒体 **38/38 通过**（state 26、collector 8、preparation 4）；真实隔离 PostgreSQL **18/18 通过**（17 子项+父项）；合计 **56/56、0 fail、0 skip**。定向严格 TypeScript 检查 exit 0。没有执行全局 tsc 或既有 video:test；由统筹在冻结后统一执行。

数据库验证在统筹明确释放阶段后执行，使用原只读 `isolated-agent-postgres.ts`、完整真实 migrations、两个独立 PrismaClient。覆盖准备器回滚、双实例领取/gate 竞争、同 owner 旧 fence、真正 slot 写入后的整体回滚、三个取消时点、逐片段预算与父 core 回填、receipt 发布后崩溃恢复、租约到期保留原 taskId、旧 active/unknown permit 共存。最终输出 `agent_video_runtime_postgres_stopped_and_cleaned`，helper 已停止临时 PostgreSQL 并删除临时目录；未连接既有业务库。

最终证据：`.codex-tmp/commerce-agent/video/w2-pure-final.log`、`w2-db-final.log`、`w2-types.log`、`w2-final-manifest.json`。较早的 w2-tests.log 是修正前阶段记录，不作为本次冻结通过证据。

本批没有修改 schema/migration/generated client、core、既有 video 后端/processor/worker/route/UI/package 或共享 helper；未运行 Prisma generate，未真实请求供应商或对象存储，未 commit/push/deploy。RunningHub `enabledModes=[]` 原样保留，实物 adapter 搭配 fake transport 的 runtime 测试确认零发送。

剩余真实接线：可信准备/消费记录写入服务、供应商素材上传与已验收 mode/节点映射、准确历史配置解析器、遵守地址钉扎/禁止重定向的真实下载端口、不可覆盖并可回读的本方存储、独立 dispatcher/旧 worker 领取隔离与心跳调度、依赖片段末帧授权、候选审阅/拼接/UI。候选完成只投影 `review/render`，混合失败为 `attention/render`，不宣称成片已交付。

独立分工的实际 spawn 参数：`w2_core_ports`/`w2_collector`/`w2_database_tests` 为 `gpt-6-sol` + `medium`；`w2_runtime_review` 为 `gpt-6-astra` + `high`。代码文件所有权互不重叠；主代理负责设计、关键修正和最终定向验收。
