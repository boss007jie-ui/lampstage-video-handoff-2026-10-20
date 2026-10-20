# 视频依赖闭包审计（2026-10-20）

范围：只读 `apps/web/lib/video/**/*.ts`、其第一方静态 import/export 闭包、相关入口、依赖元数据、Prisma schema/迁移及第三方声明。未运行测试、网络、数据库或 Git；未读取密钥或禁止的 Hypit 源码。精确文件数组与 222 条第一方导入边见 [dependency-files.json](./dependency-files.json)。统计：视频目录 45 个 TS 源文件，静态闭包共 84 个第一方 TS 文件，其中 39 个在视频目录之外。闭包包含 `video-calls/{contract,engine,processor}.ts`；`video-calls/{assets,service,http}.ts` 是独立 API 入口的补充文件，不是从视频目录严格导入得到。

## 结论与入口

- 现役入口是 `apps/web/scripts/video-worker.ts`，动态载入 `lib/video/{repository,processor,hypit-runner,media,control,worker-loop,job-quota,draft-expiry-loop}` 和 `lib/db`。领取、租约、心跳、过期清理依赖 Prisma/PostgreSQL；`processor.ts` 根据 job 数据转到六参考或单调用链。原视频生产路径调用 `hypit-runner.ts` 启动 Hypit CLI，直接交接该 runner 会保留 Hypit 依赖。runner 还有 Windows APPDATA 默认 CLI 探测和平台相关路径。macOS Harness 应保留自身账号、凭据、队列、费用、产物、FFmpeg 控制，并接入独立视频协议/媒体逻辑，不启动 Lampstage 桌面或复用 Hypit CLI。
- W1 入口 `lib/video/backends/{contracts,registry,runninghub-protocol,runninghub}.ts` 全部可单独复用，只有 Node 内置 crypto 与本目录类型；无 Next、Prisma、Hypit、AWS SDK 或默认 fetch。`createRunningHubBackend` 必须注入已核验应用映射、凭据、transport、持久化 submission gate；目前 `enabledModes=[]`，不能把它当已接通真实 AI 应用六参考/音轨/窗口能力。现有查询协议固定为 legacy outputs，backendId 包含映射/账号/协议摘要；更换协议不能无声复用旧 attempt。W1 README 明示尚未接入生产 worker。
- W2 `backend-runtime/collector.ts` 仅 Node crypto，候选下载、DNS 地址校验、媒体探测、不可覆盖存储均为注入端口；代码可复用，Harness 必须实现 HTTPS 地址固定、无重定向下载、媒体 probe、原子 create-only 存储和 readback。`runner.ts` 是显式 store/backend/collector 组合器，但实际运行离不开 `binding.ts` 和 `transitions.ts`；后两者导入 agent contracts/policy。`preparation.ts` 又导入视频参考与 agent policy。`preparer.ts`、`prisma-runtime.ts` 是 Agent core + Prisma 事务接入，不适合作为独立 Harness 的即插即用数据库层。W2 README 明示未注册到生产路由/worker，旧 worker 尚需隔离新 job。
- `video-calls/contract.ts` + `engine.ts` 是单调用输入、幂等身份、计费判定、提交/核对决策的可移植部分。`video-calls/processor.ts` 直接依赖 Hypit runner、Prisma、credits、permit、存储；`service.ts`、`assets.ts` 也依赖 Prisma/对象存储，`http.ts` 依赖公共 API、信用与资产错误类型。六个文件均列在 JSON；只有前三个在 `lib/video/**` 的严格静态闭包里。

## 第一方依赖分层

JSON 的 `groups` 给出视频目录 45 个 TS 文件逐项、互斥分类：

- `wave1Independent` 4：W1 协议和注册表，直接复制原路径即可供 Harness 编译；仍须按上段补外部端口。
- `wave2Runtime` 7：collector 独立；binding/transitions/runner/preparation 的核心语义可复用，但依赖 `lib/agent/{contracts,policy}` 或视频类型；preparer/prisma-runtime 强绑定 `lib/agent/{business-preparer,prisma-state,prisma-settlement}`、`lib/jobs/image-storage-port` 与 Prisma。照原路径保留可减少类型断裂，但不能把隔离测试当生产接入。
- `portableWithVideoTypes` 14：候选质量/审阅、consent/control、下载流、生命周期/错误、FFmpeg `media.ts` 与 `sixref-media.ts`、review token、upstream 只读协议、worker 单步策略。它们的运行时还会落到 `types.ts`、`reference-inputs.ts`、`six-reference-plan.ts`；后两者又通过 `characters/bindings.ts` 和 sharp 引入更多第一方/第三方代码。FFmpeg/FFprobe 由环境路径或 PATH 提供，不是 npm 包。
- `portableAfterFirstPartyAdapter` 5：`types.ts` 对 `video-calls/contract.ts` 有类型引用；`reference-inputs.ts`、`six-reference-plan.ts`、`template-recipe.ts`、`template-contracts.ts` 依赖角色绑定或其类型，可保留原路径/依赖，或在 Harness 中按现有契约做薄适配。不要误判它们是零依赖。
- `applicationBound` 14：`asset-hash,delivery-service,http,image-reference,job-management-http,job-quota,permits,processor,projects,repository,sixref-processor,storage,template-http,template-service`。分别绑定 Next/auth、Prisma 数据模型、账号 credit/permit、图片 provider、AWS S3/R2 与本地存储、旧 Hypit processor。交接时是行为参照和适配目标，不是独立业务包。
- `hypitCliBoundary` 1：`hypit-runner.ts`。仅用于定位替换边界；不得复制/重写 `@hypit/*` 实现。该文件是我方调用代码，但运行时强依赖外部 Hypit CLI 和 vendor package。原任务记录中的 build/receipt 语义不能直接解释成 W1 RunningHub taskId。

严格闭包外 39 个 TS 文件集中在 `lib/agent`（审批、预算、状态、Prisma settlement）、`lib/video-calls`、`lib/characters`、`lib/assets`、`lib/providers`、auth/db/storage/public-api/credits 等。逐项清单和导入边在 JSON。无需原站点的完整 UI/Next 路由才能跑 W1，但原账户、队列、价格、模板、交付接口的行为不能从 W1 自动恢复。

## 最小依赖与参考文件

`apps/web/package.json` + lockfile v3 的已解析版本：Node 运行时建议 ≥20（AWS SDK 已解析版本要求 ≥20）；`tsx 4.22.4`、`typescript 5.9.3`、`@types/node 20.19.42`。W1 单独运行只需 Node 内置模块和 TS 执行/构建工具；五份非 PostgreSQL 的 `agent-video-*` 测试按实际运行 import 需 `tsx 4.22.4`、`@prisma/client 6.19.3`、`sharp 0.34.5`；生成 Prisma client 需 `prisma 6.19.3`，typecheck 加 TypeScript/@types/node。collector 测试另需 FFmpeg/FFprobe。此为静态依赖核对，未执行安装或测试。完整旧应用还使用 `@aws-sdk/client-s3 3.1065.0`、`@aws-sdk/s3-request-presigner 3.1147.0`、Next 14.2.35、bcryptjs 3.0.3、resend 6.12.4；独立 Harness 不应因原闭包牵引就全装。

数据库参考（只读，不要求 Harness 原样迁移）：`apps/web/prisma/schema.prisma` 包含 VideoAsset/VideoJob/VideoWorker/VideoPermitAccount/VideoPermit/VideoTemplate/VideoTemplateVersion/VideoJobFeedback、Character 绑定、UploadedAsset/ImageContent、AgentRun/Approval/Step/Reservation/Slot。对应建表/调整迁移重点：`20261007120000_video_beta`、`20261015120000_video_permits`、`20261015150000_video_templates_delivery`、`20261016010000_character_library`、`20261016160000_agent_runtime`；基础 UploadedAsset/ImageContent 还需查看 `20260610093400_init` 与 `20261012120000_reconcile_schema_drift`。如需重建完整 PG，按 Prisma migrations 顺序整体应用，不能只挑这些迁移执行。Worker 参考 `scripts/video-worker.ts`、`scripts/video-preflight.ts`；W1/W2 接口说明在各自 README。HTTP 行为入口在 `app/api/v1/video-jobs/**`、`app/api/videos/**`、`app/api/v1/video-calls/**`，是 Next 层而非 Harness 必需运行文件。

## 授权边界

`THIRD_PARTY_NOTICES.md` 第 2 节和仓库 `AGENTS.md` 规定 Hypit 修改版 Apache-2.0 存在多租户及商业提供限制，禁止为复刻而读或搬 `vendor/hypit/node_modules/@hypit/**`、`vendor/hypit/packages/**` 源码。本审计未触碰该源码。独立复用我方 `lib/video/**` 调用/协议代码与引用官方 RunningHub API 应维持 clean-room 边界；是否构成衍生作品、能否商用仍需结合原版权和授权文件由法律专业人士判断。这里仅标识工程边界，不代替法律判断。
