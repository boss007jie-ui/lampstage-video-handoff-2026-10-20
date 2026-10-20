[待验收]

# Agent 内核 Wave 2A：PostgreSQL 持久化与事务接线端口

依据：用户已授权统筹整体落地和分派本地实施。先读 AGENTS、控制单、CORE-W1 的最终执行记录。本单明确授权下面的本地 schema 草案、生成客户端和隔离数据库验证；不授权对既有本地业务库或生产库运行迁移。必须先由统筹确认 W1 审查问题关闭，再发执行指令。

## 独占范围与权限

- `apps/web/lib/agent/**`；`apps/web/scripts/tests/agent-core-*.test.ts`；新增 `apps/web/scripts/tests/helpers/isolated-agent-postgres.ts`；本任务单；`.codex-tmp/commerce-agent/core/`。
- 本批唯一 schema 写入者。可在 `apps/web/prisma/schema.prisma` 增加 Agent 专用模型与 User 的必要反向关系，不修改既有图片、视频、充值、人物字段/枚举；新增一个 `20261016*_agent_runtime` migration 目录，只含新增表/索引/FK。不得修改旧 migration。
- 可运行 Prisma validate/generate，但不得隐式加载或打印项目 `.env*` 凭据；使用显式的本地占位 datasource 配置。真正迁移测试只允许本任务新建的临时 PostgreSQL 实例、回环端口和显式测试 URL。不要执行可能默认连接真实库的 migrate 命令。
- 开始前核对当前 schema，保留所有未提交内容；以最小补丁追加，完成时列出准确 schema diff。不要生成或格式化无关区块。
- 禁止改 lib/jobs、视频 backend、generation/credits/provider、已有 route/MCP、UI、Expert、部署和 package/lock。无需真实模型或媒体供应商，不启动常驻 Worker。

## 架构要求

1. 持久化 W1 的完整恢复契约：线程归属、run/计划/限额/状态/租约/revision、完整模型回合、步骤和 attempt、审批、预算占用、安全事件。使用 Agent 专用 Prisma 模型；模型回合需有独立稳定 ID 和序号，不能只保存公开事件。媒体作品版本留后批，不为了表名齐全加入空实现。
2. 至少有数据库唯一约束：`(user_id,thread_id,client_request_id)`、`(run_id,step_key)`、attempt ID、`(run_id,turn_index)`、`(run_id,attempt_id,unit)`、`(run_id,event_seq)`。run/step/approval/事件必须有归属与外键约束或等价明确的服务端校验，不能只靠 UI 传 userId。新增线程的服务端创建/读取端口，并验证跨用户 thread ID 被拒。
3. 实现 `PrismaAgentRepository` 对 W1 repository port 的全部行为，显式注入 PrismaClient，不自动 import 生产单例。每次读取来自数据库；新建实例/新建进程后可以恢复同一个 run。不得用进程内 map/锁当跨实例正确性的依据。
4. 事务先锁账户，再锁 run，之后按固定顺序处理审批、step、reservation、业务 job 映射与事件；文档写明实际锁顺序。租约使用数据库可信时钟或在同一锁内读取的时间，fence 单调递增，旧执行者不能提交/写回/释放新租约。幂等冲突不能靠先查后写，唯一约束冲突后在正确事务外重新读取原请求结果。
5. 同一事务保证审批和预算校验、唯一提交意图、步骤状态与安全事件一起提交。预留/结算始终复用同一预算记录，pending/unknown 不释放；预算上界不能冒充实际费用。取消、终态、计划替换及 W1 新增的未提交证据校验保持一致。
6. 为后续业务 job 原子创建提供明确的事务内扩展端口：仅接受服务端注册的工具准备器，得到当前 transaction、actor/step/approval/reservation 的已校验快照，在同一个事务创建/绑定业务 job、一次扣费、回写 step.jobId。缺少要求的准备器时失败关闭；外部网络/媒体 IO 永远不在此回调。此批用隔离库中的最小 fake 业务记录证明回滚和复用，不改真实 GenerationJob/VideoJob。工具 execute 得到已保存 jobId 后必须复用，不能自己再次创建。
7. 可提取纯状态变换复用 W1 校验，但不要通过重放外部工具来恢复状态，也不要把整个内存仓库当生产状态缓存。数据库异常只暴露固定安全代码，不能打印连接 URL、参数/完整输入。
8. 本批不接 session API、模型 HTTP、常驻调度、真实图片/视频生成，不能宣称完整 Agent 可用。

## 共享预算与业务准备器的固定约定

- core 的 `step.jobId` 表示业务任务已经创建，不等于供应商已经收到请求。业务 job 存在后，禁止把图片领域的 `not_submitted` 直接转成 core 同名结果，也不能删 jobId/改回 planned；应根据可信业务终态与实际积分扣退结果收敛 core。增加“事务创建业务 job 后、供应商发送前明确失败”的 fake 验证。
- 平台积分单位明确一对一映射：core `image_credit` = 图片 `platform_credits`；供应商货币/秒数仍完全独立。父 core attempt 对应一次图片业务 job；每张图有独立稳定 slot attempt，并保存到父 attempt 的关联，不把 slot 当新的 core 工具调用。
- 准备器取得稳定的 `(runId,coreAttemptId,unit)` reservation 引用及已验证审批记录。审批 scope/报价/plan 版本不能由模型传入；审批需有可绑定的服务端 revision（新记录 1，撤销/实际变更递增），不把 run.revision 猜作 approvalRevision。
- 准备器是**事务内入口**，不能调用会自行开启事务的 `ImageRepositoryPort.createAtomic()`。本批给出事务内端口与 fake 实现，后批图片 DB adapter 复用它。公共单元和事务类型可放 core 下，由其他模块仅类型导入。
- 同一父 reservation 支持部分结算：保留原授权上界，记录已确认结算和已确认释放，剩余未决量可推导。预算占用 = 已确认结算 + 未决量，不能因一个 slot 失败释放全 job，也不能重复累计。所有值为同单位非负整数，总和不得超过原上界。
- 共享 reservation 的写入统一经过 core 导出的事务内结算操作，业务 adapter 提交幂等 slot 结算证据；业务 worker 与 core 结果回填不能各算一遍。已绑定业务 job 的 `recordOutcome()` 读取/核对该结算，不以缺 usage 的报价上界覆盖已确认的部分退款，不重复释放。无需在 W2A 实现真实图片表，但必须用 fake 业务表测试该协议。
- 验证 4 张图“2 成功 + 1 明确未提交已退款 + 1 unknown”：成功保留，1 份未决继续占用，已退款部分只释放一次；late success/重复回调不覆盖既有结算。次数限额仍按固定父/子尝试范围约束，退款不自动产生新尝试额度。

## 隔离验证

复用现有本地 embedded-postgres 二进制机制，新增专用 helper；临时目录必须在已核实的 ASCII temp 下，进程 windowsHide，清理路径先验证根与前缀，测试 URL/随机密码不出日志。不得复用用户本地业务库。测试真实应用新 migration SQL 或等价经核对的建表产物，不能仅手写一个漏约束的简化 fixture 冒充 migration 验证。

必须实际覆盖：

- 两个独立 PrismaClient/Repository 实例并发 10 次同 key：一个 run；同 key 不同输入冲突；跨用户线程/run/事件拒绝。
- 同一额度最后一次并发争用只有一个提交意图；预算预留、fake 业务记录、一次账务记录、step 映射全部同事务，故障注入后一起回滚。
- 保存模型工具回合后销毁 client/repository，使用新 client 恢复相同 turn/step/attempt；工具结果已保存后重启不再执行该工具。
- submitting/pending/unknown、租约过期接管、旧 Worker 恢复、取消与已知 job 的矛盾未提交结果；不重发、不错误释放。
- 重复结算不改变预算，不增加事件重复序号；公开事件重放只有安全投影。
- 所有 W1 离线测试继续通过；新增数据库测试不能仅 skip 后声称通过。记录实际命令、数量、失败修复和清理结果。

全局 typecheck 仍由统筹串行运行。实施方运行独占局部检查与本批隔离库测试，不运行全局 build/video 回归。

## 交付

将本单改为待验收，提供新模型/唯一约束、repository/事务准备器导出、准确文件清单、schema diff、实际数据库测试输出、后续图片 adapter 接线约定。不得自动开始下一批、部署或付费验证。

## 执行记录（2026-10-16，Wave 2A）

已实现显式注入 PrismaClient 的 `PrismaAgentRepository`、线程创建/读取端口、事务内业务准备器与共享 slot 结算端口。真实隔离 PostgreSQL 验证通过，保留 `[待验收]` 交由统筹验收。没有启动下一批。

### schema 与 migration 准确范围

开始前保存原 schema 到 `.codex-tmp/commerce-agent/core/w2-schema-before.prisma`；最终与该快照逐项比较，仅有：

- `User` 增加一条反向关系 `agent_threads AgentThread[]`。
- 文件末尾追加八个模型：`AgentThread`、`AgentRun`、`AgentModelTurn`、`AgentApproval`、`AgentStep`、`AgentReservation`、`AgentReservationSlot`、`AgentEvent`。既有模型的业务字段、枚举、关系与格式均未改动。
- 只新增 migration `apps/web/prisma/migrations/20261016160000_agent_runtime/migration.sql`，基于原 schema → 新 schema 的 Prisma diff 生成；SQL 只新建 Agent 表/索引/外键及这些新表的 CHECK，没有修改旧 migration 或既有业务表。CHECK 约束非负/安全整数金额、子份额上限与终态结算和、正审批 revision、非负 run 计数与租约字段成对存在。

主要唯一约束与归属链：

| 模型 | 键 / 约束 |
| --- | --- |
| Thread | 主键 id；`(id,user_id)` 唯一；user FK |
| Run | 主键 id；`(user_id,thread_id,client_request_id)` 唯一；`(id,user_id)` 唯一；复合 FK 指向自己的 thread/user |
| ModelTurn | 独立稳定 id；`(run_id,turn_index)`、`(id,run_id)` 唯一；完整 assistant 文本、calls、finish 持久化 |
| Approval | 独立 id；`(run_id,approval_index)`、`(id,run_id,user_id)` 唯一；复合 run/user FK |
| Step | 全局 attempt_id 主键；`(run_id,step_key)`、`(run_id,attempt_id)`、`(run_id,attempt_id,user_id)`、`(run_id,step_index)` 唯一；run/user、turn/run、approval/run/user 复合 FK |
| Reservation | `(run_id,attempt_id,unit)` 主键；step/run/user 与 approval/run/user 复合 FK |
| ReservationSlot | `(run_id,attempt_id,unit,slot_attempt_id)` 主键；`(slot_attempt_id,unit)` 唯一；父 reservation 复合 FK |
| Event | `(run_id,event_seq)` 主键；run/user 复合 FK；只有安全投影列 |

### Repository、锁序与原子提交

- `PrismaAgentRepository` 实现 W1 的全部 repository 方法，并实现 `AgentThreadRepository.createThread/loadThread`。不导入生产 Prisma 单例，不用 Memory 仓库、进程缓存或进程内锁保证正确性。读操作在 RepeatableRead 事务中读取数据库；每个写操作在交互式事务中读取新快照再变更。
- 状态校验提取到 `AgentRepositoryBase`，Memory 和 Prisma 共用审批/预算/计划摘要、取消、终态、租约 fence 和已知 job 的未提交证据规则。Memory 仍只用于离线参考。
- 实际写锁序固定为 **User 账户 → AgentRun → AgentApproval（id）→ AgentStep（attempt_id）→ AgentReservation（attempt_id,unit）→ AgentReservationSlot（attempt_id,unit,slot_attempt_id）→ 业务 job/账务 → Event**。同账户锁也保护线程创建、model turn 和尚不存在的子行。所有业务 adapter 必须先进入 core 事务入口取得这些锁，不能先锁业务表。线程创建先锁账户；首次 run 插入先锁账户并核验 thread 归属。
- 时间来自锁内的 `SELECT clock_timestamp()`。lease 到期接管使 fence 单调递增；旧 worker 不能派发、回填或释放新 lease。未改变 snapshot/events 的操作直接返回，忙 claim、旧 release、重复终态结果不会推进 revision。
- createRun 直接尝试唯一键插入；P2002 导致原事务回滚后，在事务外重新读取同一账户/thread/request，校验 creationDigest。同 key 不同输入返回 `idempotency_conflict`。
- `BusinessPreparer`、`BusinessPreparation`、`BusinessPreparers`、`AgentTransaction` 从 `business-preparer.ts` 导出。准备器仅来自 repository 构造时的服务端注册表，获得当前 tx、经过验证的 actor/step/approval、reservation 与稳定引用。需要审批或正费用的工具缺少准备器时返回 `business_preparer_required`，全部回滚。
- beginSubmission 在同一事务完成校验、次数与预留、step 提交意图、准备器的业务 job/单笔账务/slot、step.jobId、安全事件。准备器失败时全部回滚，对外数据库异常统一为 `repository_failure`，不返回 SQL、参数、完整输入或连接信息。

### 共享结算及后续图片 adapter 接线

1. `image_credit` 与 `platform_credits` 固定 1:1，`IMAGE_CREDIT_PLATFORM_UNITS = 1`。父 core attempt 对应一次业务 job；子图用稳定 slot attempt ID。slot 不增加 core 工具调用次数，退款不返还尝试次数。
2. 准备器必须使用传入的 `AgentTransaction`。禁止调用自行开启事务的 `ImageRepositoryPort.createAtomic()`；禁止网络/媒体/文件 IO。在同一事务完成业务创建和唯一扣费，并返回已有 jobId。runner 已将该 jobId 传入 `ToolContext`，execute/recover 必须复用原映射。
3. approval 新建 revision=1，首次撤销递增；step 保存真实 approvalId 与 approvalRevision，不从 run revision 推断。准备器使用服务端已验证的 scope、报价和计划摘要，不接受模型传来的审批声明。
4. `allocateReservationSlotsInTransaction(tx,actor,ref,allocations)` 和 `settleAgentReservationInTransaction(tx,actor,ref,evidence)` 从 `prisma-settlement.ts` 导出，使用调用者事务，先锁 core，再更新业务账务。ref 是 `(runId,attemptId,unit)`；子份额必须完整覆盖原上界。相同分配幂等，分配变化拒绝。
5. 原授权上界保持不变；确认结算、确认释放与未决量分开：`未决 = 上界 - 已结算 - 已释放`，`占用 = 上界 - 已释放`。部分退款只释放其 slot，不释放整 job。终态证据摘要不可改写，同一证据重复提交不写回，矛盾迟到成功返回 `settlement_conflict`。unknown 可在权威结果到达后收敛。
6. 业务 adapter 在同一 tx 核验可信证据、调用 core 结算并用业务唯一键记账；事务错误必须向外抛出以回滚。`recordOutcome` 对 businessManaged 步骤只核对结算和可选 usage，不修改共享 reservation 的金额或状态，不用缺 usage 的报价上界覆盖部分退款。仍有未决量时拒绝终态并由 runner 保守记录 unknown。
7. step.jobId 只表示业务 job 已建立。供应商发送前明确失败也不能回退 core `not_submitted`；业务先确认实际退款，再用带实际已结算语义的 failed/charged 结果收敛，job 映射保留。这里 charged 是 W1 终态分类，允许实际净费用为 0。

### 实际验证与审查修复

Prisma 工具通过 `.codex-tmp/commerce-agent/core/prisma-tooling.cjs` 从新建 ASCII temp 目录运行；显式回环占位 datasource、环境变量白名单，无项目 .env。执行过 `validate`、`generate`、`agent-sql`（Prisma migrate diff 的纯 schema 比较，不执行数据库迁移），均退出 0。生成 client 的 `relativeEnvPaths.rootEnvPath` 为 null，未配置 schemaEnvPath。没有输出凭据。

数据库测试使用新增 helper，在 ASCII temp 下新建 `lamp-agent-pg-*`，随机回环端口/随机密码，子进程 windowsHide。测试实际按顺序应用仓库全部 migration SQL，包含本批真实 migration；然后仅在该临时库新增最小 AgentTestJob/AgentTestLedger fake 表。没有用简化 Agent fixture 替代迁移。

工作目录 `apps/web` 下实际执行：

```powershell
.\node_modules\.bin\tsx.cmd --test scripts/tests/agent-core-policy.test.ts scripts/tests/agent-core-repository.test.ts scripts/tests/agent-core-runner.test.ts scripts/tests/agent-core-settlement.test.ts scripts/tests/agent-core-postgres.test.ts
```

最终结果：**57 tests / 57 pass / 0 fail / 0 skipped，退出码 0**。其中 W1 原有 44 项、纯 slot 结算 2 项、真实数据库 10 项子测试和 1 项父测试。完整安全输出保存在 `.codex-tmp/commerce-agent/core/w2-test-output.txt`，包含 `agent_postgres_stopped_and_cleaned`。实际覆盖：

- 两个独立 client/repository 并发 10 次同 key，只产生一个 run；不同输入冲突；跨账户 thread/run/events/写操作拒绝。
- 最后一次额度并发争用仅一个提交；重复提交不新建 job、slot 或账务；准备器失败与缺失全部回滚。
- 销毁 client 后新 client 恢复完整 turn、step、attempt；工具结果已保存后重启恢复，不再次 execute；pending 重启仅查询原 job，unknown 保持占用。
- submitting 状态在数据库时钟租约过期后接管；旧 fence 不能派发/写回/释放；取消、已知 job 与未提交矛盾结果；业务创建后供应商发送前失败实际退款。
- 4 slots 的 2 成功 + 1 退款 + 1 unknown；退款事务故障回滚；重复/迟到证据、部分退款不被缺 usage 覆盖、最终余量收敛，次数不回补；事件顺序连续、重放安全投影。
- 审批 revision、重复撤销、复合外键拒绝跨账户直接挂载 thread/approval/reservation；零费用只读工具无需准备器。

局部严格类型检查实际命令：

```powershell
.\node_modules\.bin\tsc.cmd --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --esModuleInterop --types node lib/agent/contracts.ts lib/agent/prisma-repository.ts lib/agent/prisma-settlement.ts lib/agent/memory-repository.ts lib/agent/runner.ts scripts/tests/agent-core-policy.test.ts scripts/tests/agent-core-repository.test.ts scripts/tests/agent-core-runner.test.ts scripts/tests/agent-core-postgres.test.ts scripts/tests/agent-core-settlement.test.ts scripts/tests/helpers/isolated-agent-postgres.ts
```

退出码 0，无诊断。没有运行全局 typecheck/build/video 回归。

失败与修复记录：首轮数据库测试有 2 项夹具失败。模型回复耗尽本应进入 attention，已修正恢复测试为新 client 人工 resume 后继续；原始 SQL 把 timestamptz 写入无时区字段受本地时区影响，已改用 Prisma UTC epoch 设置测试过期 lease。随后独立审查指出无操作请求推进 revision、审批/预留缺少完整复合归属 FK；两处已修复并补直接回归，最终复核无新增具体缺陷。

独立工作实际 delegation 参数：隔离 helper `/root/w2_postgres_helper` 与只读审查 `/root/w2_isolation_review` 均为 `model=gpt-6-sol, reasoning_effort=medium, fork_turns=none`（以 spawn 调用记录为依据）。主代理负责 schema、核心实现、故障诊断和最终测试验收。helper 的正常查询与回调抛错清理均独立检查通过；最终全量测试断开所有 client 后 pg_ctl 确认停止，再校验临时路径并删除，TEMP 下无 `lamp-agent-pg-*` 残留。停止失败不会吞掉错误后删除运行中的数据目录。

### 准确文件清单与边界

- 修改：`apps/web/lib/agent/contracts.ts`、`approvals.ts`、`policy.ts`、`memory-repository.ts`、`runner.ts`。
- 新增：`apps/web/lib/agent/repository-base.ts`、`settlement.ts`、`business-preparer.ts`、`prisma-state.ts`、`prisma-repository.ts`、`prisma-settlement.ts`。
- 新增测试：`apps/web/scripts/tests/agent-core-settlement.test.ts`、`agent-core-postgres.test.ts`、`helpers/isolated-agent-postgres.ts`。W1 三个测试文件断言保持原样并继续通过。
- 修改 `apps/web/prisma/schema.prisma`，新增上述一个 migration，以及本任务单。
- 本地辅助证据均在 `.codex-tmp/commerce-agent/core/`：原 schema/状态快照、纯 schema SQL 产物、隔离 Prisma 工具、提取过程备份和最终测试输出。Prisma client 已在既有 node_modules 内生成；没有修改 package/lock。

本批仍未接真实 GenerationJob/VideoJob、用户积分账本、session API、模型 HTTP、供应商、SSE/UI 或常驻调度；fake 账务验证证明事务协议，不代表真实业务 adapter 已接线。没有对既有本地业务库或生产库应用迁移，没有部署、commit、push、付费调用或启动常驻 Worker。共享工作区其他已有变更保留，W1 验收记录未修改。不能将本批称为完整 Agent 已可用。

### schema 写入权交接

按统筹收尾指令，当前 schema、Agent migration 和已生成 Prisma client 冻结为本批交付状态；core 不再运行 generate 或更改 schema，也不自行开启下一批。后续图片持久化由统筹指定的图片聊天接任唯一 schema 写入者。最终 57/57 证据包含最后的 no-op revision、复合归属 FK 与 reservation 状态修复，后续统筹复跑应以此版本为准。

- schema SHA256：`84BCE8F60A7D585968C508B11F806631F4287CE2B7270456216F797F747A0883`
- 新 Agent migration SHA256：`1FEB0F32B62D065AF64BCEB841A6B70896FDB16C422BEAFBB5A45999331BB68B`

### 统筹全局类型检查补丁（2026-10-16）

统筹反馈其 9 个 Agent 测试文件合计 **157/157 pass、0 fail/skip**，schema/migration SHA 与本记录一致；全局 `npm run typecheck` 唯一失败为 helper 第 26 行 TS2741：Next ambient 声明要求 `NodeJS.ProcessEnv.NODE_ENV`，此前局部 tsc 未带入该声明。

按指定范围，仅将 `apps/web/scripts/tests/helpers/isolated-agent-postgres.ts` 的子进程环境初始化改为 `{ NODE_ENV: "test" }`。这是显式测试常量，原系统变量白名单保持不变；不读取项目 .env 或密钥。未改 schema、migration、生成客户端或其他实现。

本次在 `apps/web` 实际复跑：

```powershell
.\node_modules\.bin\tsx.cmd --test scripts/tests/agent-core-postgres.test.ts
```

结果 **11/11 pass、0 fail、0 skipped，退出码 0**；输出包含 `agent_postgres_stopped_and_cleaned`，复核 TEMP 下没有 `lamp-agent-pg-*` 残留。记录保存在 `.codex-tmp/commerce-agent/core/w2-helper-node-env-test-output.txt`。未重复纯测试或运行全局 typecheck；全局检查仍由统筹复跑。本任务保持 `[待验收]`，schema/client 冻结状态不变。
