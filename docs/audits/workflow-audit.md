# 视频工作流专项只读审计（2026-10-20）

## 结论与审计边界

本报告依据仓库自有源码静态审计，不代表当前生产部署、账户可用性或真实生成质量验收。指定范围内可以交付业务流程、参考图语义、状态机和 RunningHub 适配契约；不能交付“已完成真实映射、可直接生成”的 RunningHub 工作流配置。

本次先读根 `AGENTS.md`，未读取、复制或改写 Hypit 受限源码；没有读取 `.env`、真实凭据、私有素材或运行时私密配置；没有运行任何测试、网络请求、数据库、上传、Worker、FFmpeg 或生成操作。只新建本报告。下述历史测试结果仅转述任务记录，不是本次复验。

代码定位均相对仓库根 `C:/Users/boss0/Desktop/05-项目文件夹/网站制作/lamp-saas-mvp`，冒号后为行号。

后续经主线程扩展授权，已补审 `apps/web/lib/video-calls/**` 六个自有文件及实际 provider imports。结论：现有单次 API 已接入业务处理器，但底层仍使用 `sixRefRunner`，没有通过该入口实现独立 RunningHub 直连。未核查生产部署或实际任务。

## 0. 当前单次调用入口（必须与旧多段流程、W1/W2分开）

实际代码路径为 `/api/v1/video-calls/preview` → `previewVideoCall`，`/api/v1/video-calls` → `createVideoCall` → 已有 VideoJob 队列 → `processVideoJob` 的 singleCall 分支 → `processSingleCall` → `sixRefRunner.submitH3`。证据：`apps/web/app/api/v1/video-calls/preview/route.ts:10`、`apps/web/app/api/v1/video-calls/route.ts:21`、`apps/web/lib/video/processor.ts:77`、`apps/web/lib/video-calls/processor.ts:7`、`:79`。Worker 自身识别名也已是 `video-single-call-v1-*`（`apps/web/scripts/video-worker.ts:10`），但启动和生产健康状况未验证。

该入口的实际流程与限制：

- 请求是 `motion_asset_id`、1–6 张 `reference_assets`、原始 `prompt`、请求 `duration=4|5|6|8`、`request_id`、`max_credits`（`video-calls/contract.ts:6`、`:37`）。reference role/label 可选且是文字标签，不强制六参考多段计划的 start_state 第1图规则。
- 免费 preview 校验素材归属、真实媒体/hash；动作视频要求音轨和 audioCodec，不能把空音频对象交给当前 H3 流程（`video-calls/assets.ts:11`、`:19`）。这是现有调用路径要求，仍不能证明新 RunningHub 应用上传/音频节点语义。
- 创建时冻结用户上传的原图原视频；代码没有在这里自动截动作窗口、静音补轨、自动生成首尾帧或拼接多段（`video-calls/assets.ts:26`–`:46`）。接收方须在自己的前置工作流准备符合约定的动作片。
- 冻结输入→事务内计费并受理→queued/render→下载并校验冻结 SHA256→占用账户 permit→授权复核→持久 submission intent→Hypit submit→查询原 build→收取原始输出→completed，文字标为“单次生成完成，等待本地审阅”（`video-calls/service.ts:58`、`:72`；`video-calls/processor.ts:48`–`:115`；`video-calls/engine.ts:35`–`:63`）。
- prompt 直接传入 `call.input.prompt`；参考文件按输入数组顺序传入（`video-calls/processor.ts:52`、`:79`）。不自动注入 `sixSegmentDirection`；角色标签不会在该处自动变成提示词。需要接收 Harness 在输入准备阶段自行构造完整提示词。
- 幂等键是 SHA256(userId, request_id)，相同键不同 inputDigest 返回 409；inputDigest 是完整解析后输入 JSON，包含 request_id/max_credits（`video-calls/contract.ts:59`–`:60`；`service.ts:54`、`:78`）。
- 此路径账单单位是平台积分，配置名为 `VIDEO_SINGLE_CALL_QUOTE_CREDITS`；标准模式无报价不能受理。内部免扣资格取服务器账户，免平台积分不表示供应商免费（`contract.ts:61`–`:75`）。平台积分不能塞进 RH coins：其 permit 明确 reservedCoins=null/maxCoins=0（`processor.ts:60`）。
- 供应商实际成本公开为 null/unknown（`service.ts:18`）。没有提交证据的失败、或已确认供应商终态失败会退平台积分；已有 intent/build 而未知则 attention、不重投、不退未知占用（`engine.ts:25`、`:49`、`:77`）。这不等于 RH 退款能力。
- completed 路径 `collectH3` 后做 probe/hash/storage；不会调用多段 assemble（`processor.ts:87`–`:96`）。处理轮次有 45 分钟 deadline、20 秒 lease heartbeat、10 秒查询间隔（`:26`、`:28`、`:116`）；这些本地时限不是供应商 URL TTL。

因此“现役独立单调用 API”已经有业务实现；“独立 RunningHub HTTP 后端用于该 API”仍没有接入。真实 AppID/nodeId/fieldName/upload fieldValue 的 unknown 结论不变。

## 1. 指定范围内实际已有的业务阶段

| 流程 | 自有代码已表达的行为 | 源码证据 |
|---|---|---|
| 通用阶段 | draft、queued、preparing、review、generating、assembling、completed、failed、attention、cancelled；prepare / prepare_references / prepare_sixref / render / reconcile / assemble | `apps/web/lib/video/types.ts:5` |
| `legacy_frames` | 校验原视频；切动作片；抽首尾帧；用产品图与首尾帧生成参考图；人工 review；按片段调用视频；收取并合成 | `apps/web/lib/video/processor.ts:157`、`:186`、`:197`、`:208`、`:216`、`:301`、`:347` |
| `direct_references` | 产品图加另外两张带用途的参考图，固定共三张；冻结归属、图像字节/hash；只切动作片，不生成首尾参考图；review 后渲染 | `apps/web/lib/video/reference-inputs.ts:25`、`:38`、`:49`、`:75`；`processor.ts:165`、`:190` |
| `six_references` | 1–6 张逐段参考图；语义动作窗口；请求时长 4/5/6/8 秒；参考快照；准备动作视频；review；候选收取/末帧；逐段审阅通过后独立 assemble | `apps/web/lib/video/six-reference-plan.ts:8`、`:44`；`sixref-processor.ts:100`、`:123`、`:129`、`:133`、`:209` |
| 六参考时序依赖 | 第 1 张必须是唯一 start_state；前段审阅通过并有 tailKey/tailSha256 后，才可将前段真实末帧替换下一段第 1 张参考 | `apps/web/lib/video/six-reference-plan.ts:36`、`:82`、`:95` |
| 恢复 | 有提交意图或 buildId 时恢复/查询原任务，不能当作未提交重新生成 | `apps/web/lib/video/processor.ts:25`、`:220`；`sixref-processor.ts:160` |

源片总时长代码上限为 4–30 秒、150 MiB（`types.ts:144`），不是上游单次可生成 30 秒。旧普通分段用 4/5 秒并记录重叠 trimStart（`media.ts:85`）；六参考窗口相对生成时长变速不得超过 15%（`six-reference-plan.ts:51`）。

六参考提示词版本为 `target-appearance-v2`（`six-reference-plan.ts:6`、`:106`），明确各图用途、第 1 图动作开始场景、视频仅提供本段动作/接触/时间，生成音频在合成时丢弃。这是自有业务语义，不证明供应商节点映射支持同样语义。

媒体处理可转为接收方现有 FFmpeg 的任务规格：普通动作片 720×1280/30fps，无音频（`media.ts:99`）；六参考动作片按语义窗口重定时、补单声道静音 AAC 并校验（`sixref-media.ts:84`）；成片 H.264/AAC、720×1280，按选择恢复原片音频（`media.ts:118`、`:144`；`sixref-media.ts:145`）。六参考 assemble 还要求所有候选 accepted、SHA256 一致并检查实际 30fps（`sixref-processor.ts:134`、`:140`、`:146`）。

## 2. 旧 Hypit 与新 RunningHub 的实际区别

| 项目 | 旧 Hypit 调用边界（自有代码） | 新 RunningHub W1/W2 |
|---|---|---|
| 业务接线 | `processor.ts:13`、`sixref-processor.ts:10` 导入 Hypit runner | `backend-runtime/README.md:3` 明确未注册；本次在 lib/video、app/api、scripts 的非测试 TS 引用检索未找到生产构造调用方 |
| 服务商 | 我方 provider 名为 `hypit-provider-runninghub-product-v6` / `hypit-provider-runninghub-sixref`，端点 `runninghub.account01` | RunningHub AI 应用 HTTP adapter，backendId 包含账户、webappId、映射版本、`legacy-outputs-v1`、配置 SHA256 |
| 模型/能力标识 | `@hypit/minimax-h3@1#minimax-h3` 是契约/能力标识；不能据此确认供应商模型精确版本 | 真实模型、应用语义和模式均未验证 |
| 输入 | 自有代码生成 SVML：图片路径、动作视频路径、prompt、duration、`768P`、`9:16`，交给 CLI | `values[inputKey]` 通过显式 bindings 转成 `nodeInfoList`；不负责上传、读环境或默认 fetch |
| 提交与收据 | CLI check→plan→保存 intent→build，保存本地 buildId；再查询原 build 获取 taskId/结果 | 持久 gate→一次 POST→accepted(taskId)/definite_not_submitted/submission_unknown；已有 taskId 只读查询 |
| 默认开放度 | 受配置、readiness、付费开关和 permit 限制；本次不核对真实运行状态 | `enabledModes=[]`；sixReferences/sourceWindow/audio disabled+unknown；cancel/billing=false |

主要证据：`hypit-runner.ts:9`、`:146`、`:187`、`:193`、`:201`；`backends/runninghub.ts:22`、`:31`、`:37`；`backend-runtime/runner.ts:42`。

`scripts/configure-video-runtime.ts` 是旧 Hypit 配置器，不是 RunningHub 直连映射配置器。它绑定 account 01、Hypit provider 和 credential 引用，legacy instanceType=ultra、sixref=default，sixref 还有 firstPassMegapixels=0.4096/upscaleFactor=1.5，轮询 5 秒、超时 30 分钟（`:19`、`:29`–`:40`）。这些是我方旧适配器配置字段，不足以推导新 API 节点。脚本还依赖 Hypit packageRoot 存在，不能作为接收方无 Hypit Harness 的接入方法。

## 3. 服务商、接口版本与配置真值表

以下接口是源码当前采用值；本次禁止网络访问，未重新核对 2026-10-20 官方接口状态。

| 字段/能力 | 审计结果 | 证据或缺口 |
|---|---|---|
| 新提交 URL | `https://www.runninghub.cn/task/openapi/ai-app/run` | `backends/runninghub-protocol.ts:4` |
| 新提交协议 | POST，Bearer + JSON apiKey/webappId/nodeInfoList；每项 nodeId/fieldName/fieldValue；ID 保持字符串 | `runninghub-protocol.ts:47`、`:51` |
| 新查询 URL | `https://www.runninghub.cn/task/openapi/outputs`，status/results 都走该端点 | `runninghub-protocol.ts:5`、`:60` |
| 查询版本 | `legacy-outputs-v1`；code/data[].fileUrl/fileType | `runninghub.ts:32`；`runninghub-protocol.ts:88` |
| V2 | `/openapi/v2/query` 未实现；历史资料没有证明旧 AI 应用 taskId/Key 兼容，不得静默混用顶层 status/results[].url 协议 | `backends/README.md:43`–`:45` |
| 真实 AI AppID/webappId | **unknown** | 结构接口有字段，没有可核实生产配置；`backends/README.md:51` |
| 真实 nodeId/fieldName | **unknown** | `RunningHubApplication.bindings` 只定义注入契约，不能拿测试值当真实映射；`runninghub-protocol.ts:6` |
| inputKey 对应语义 | **unknown** | 可信应用配置需给出业务输入到节点的映射；字符串结构通过不等于语义核实 |
| 上传接口与 fieldValue 类型 | **unknown** | 新 adapter 不上传；尚不知图片/视频应传文件名、对象 ID、URL 或其他票据；`runninghub.ts:22` |
| 真实凭据配置/权限 | **unknown（未检查）** | 未读取/验证接收方或本地凭据；只提供原生 secret 注入接口需求 |
| 六参考/动作窗口/音频/分辨率/时长 | 新直连均未验收 | `runninghub.ts:36`–`:38`；旧业务契约不能当新应用能力证据 |
| 供应商取消、退款、实际账单 | 未实现/未知 | `runninghub.ts:38`；`backends/contracts.ts:98` |
| 结果 URL TTL、任务保留期、重查必定换链接 | **unknown** | 结果 `expiresAt:null`；`runninghub-protocol.ts:97`；`backends/README.md:55` |

`apps/web/lib/video/upstream.ts:14` 的 `DEFAULT_WORKFLOW_ID="2102537586127491074"` 只是只读 `/api/openapi/getJsonApiFormat` 查询默认 ID。脚本允许 `VIDEO_H3_WORKFLOW_ID` 覆盖（`apps/web/scripts/video-upstream-check.ts:23`），本次未读取该运行环境。它不能被认定为 AI 应用 webappId、当前账户真实目标或经验证节点图。

## 4. 是否实际存在可导出的工作流 JSON

结论：**指定审计范围内未找到可交付的真实 RunningHub/ComfyUI 节点图 JSON；仓库外及被排除的私有运行时内是否存在，unknown。**

依据：

1. `upstream.ts:32` 解析 API 响应的 `data.prompt` JSON，但返回的是 nodeCount/modelFiles/inputsSeen 摘要；不是节点图导出器。
2. `video-upstream-check.ts:59` 获取工作流，`:62`–`:76` 只打印诊断摘要，不保存完整图。
3. `configure-video-runtime.ts:29`–`:40` 生成的是 Hypit profile 和账户引用 JSON，不是供应商工作流 JSON。
4. 本次只列举自有 lib/video、scripts、tasks、docs 下 JSON 文件名，排除 tests/vendor/node_modules/runtime/credential/secret；可见主要为测试/交付/部署记录，没有通过内容审计确认的节点图。未阅读其中运行日志、账户记录或私密状态，不用文件名推定其可交付性。
5. W1 的 `RunningHubApplication` 也是输入映射配置，非完整节点拓扑。即使后续填写映射 JSON，也必须明确叫“调用映射”，不能包装成供应商可导入工作流。

可交付的是自有业务工作流定义与接口 schema；真实应用配置需从接收方所选应用的合法 API 配置/官方导出取得并验收，不通过 Hypit 实现逆向推导。

## 5. 失败、unknown、幂等、取消和结果恢复

| 场景 | 已有逻辑 | 接收 Harness 必须保留的边界 |
|---|---|---|
| 付费 POST 超时/断连/非成功 HTTP/畸形响应 | submission_unknown；没有自动重试 | 不能把超时当未提交；无 taskId 不能补发 |
| 非零明确业务拒绝 | 仅白名单且响应完全没有 taskId 字段才 definite_not_submitted | 字段存在但数值/非法/空值也是 unknown；不可因 ID 不可用而释放占用 |
| 同 intent 重入 | gate already_claimed，返回 unknown | 不使用新的 attempt/backend/account 绕过未知状态 |
| 查询 404/不可见/未知状态 | read_error，仍未决 | 只对持久 taskId 有界查询，不能生成替代任务 |
| 取消竞争 | gate 提交前禁止新发送；gate 提交后保留已可能发送的提交责任 | 数据库取消与网络 POST 不原子；不删除 intent 或释放 unknown |
| 终态失败 | 可信已受理失败释放并发 permit、消费请求秒数额度 | 不能声称 RH 币退款 |
| 供应商已完成但收取失败 | provider_completed；可释放供应商并发，仍需收取 | 从原任务重查结果或本方存储恢复，不能重新生成 |
| 签名 URL 过期 | 每次 results 查询原任务；无 URL 缓存 | 重查一定刷新没有供应商保证，继续可恢复/人工处理 |
| 候选写入与回包丢失 | 固定身份 key，putIfAbsent/readback，SHA256/尺寸/时长校验后发布 receipt | 同字节幂等复用，不同内容冲突，不允许覆盖 |
| 租约失效/释放 | unresolved active→unknown，保留 taskId | 重新领取不自动恢复为可新提交状态；旧 fence 不可写回 |

代码：`backends/runninghub-protocol.ts:72`–`:84`、`:99`；`backends/runninghub.ts:75`；`backend-runtime/transitions.ts:58`、`:80`、`:95`、`:123`、`:129`；`backend-runtime/runner.ts:27`、`:57`；`backend-runtime/collector.ts:55`、`:127`。

候选收取需要 Harness 实现 HTTPS 主机 allowlist、请求前 DNS/地址检查和连接地址钉扎、禁止重定向、大小/时间上限（`collector.ts:48`、`:66`）。媒体时长误差最多 0.5 秒，不能把任意 HTTP 200 字节视为视频（`collector.ts:4`、`:122`）。

旧链路另有 draft cancellation 与关闭已暂停任务的限制：draft 必须没有租约或 permit；关闭 review/attention 要求所有 permit released 且没有未决生成（`job-lifecycle.ts:61`、`:71`）。这些不等于供应商取消 API。

## 6. 费用、并发与权限

- 当前代码每账户最多 3 个 active permit；任意 unknown 阻止新的付费提交（`backend-runtime/transitions.ts:88`，旧 `permits.ts:130`–`:137`）。
- `maxCoins` 是本地消费批准/预算门，不传给供应商，不能承诺上游账单硬封顶。没有单段报价时只登记 `unpriced_technical_cap`；旧验证接受 1–1,000,000 的整数上限（`consent.ts:24`–`:37`）。
- 单段报价来自 `VIDEO_H3_SEGMENT_QUOTE_COINS` / `VIDEO_SIXREF_SEGMENT_QUOTE_COINS`，本次没有读取值；代码注释明确是保守报价（`types.ts:154`）。
- W2 `video_second` 是请求时长份额，非实际币账单或美元换算。确定未提交释放；成功/已受理终态失败消费；unknown 保留占用（`backend-runtime/transitions.ts:20`、`:123`；`backend-runtime/README.md:41`）。
- 准备/消费审阅摘要必须绑定账户、backend、configurationDigest、素材身份/hash、窗口、输入值和报价版本，旧 backend-agnostic token 不能复用（`backend-runtime/README.md:19`；`binding.ts:45`、`:93`）。
- 接收方已有账号、密钥、队列和费用系统，应映射上述语义到其既有端口，避免复制本仓库整套账户、Prisma 表和队列。`PrismaVideoRuntimeStore` 与本库 Agent core 强耦合，不是直接可安装到 Harness 的通用服务。

## 7. W1/W2交付状态与可交付范围

W1/W2 文件首行均为 `[待验收]`。W1 记录 27 项离线 fake 测试通过（`tasks/LAMP-AGENT-VIDEO-W1.md:125`）；W2 记录 56/56，含纯状态/本地媒体/隔离 PostgreSQL（`tasks/LAMP-AGENT-VIDEO-W2.md:109`）。这些历史记录不能证明真实供应商能力、线上接线或本次静态快照仍通过。

建议向 macOS Codex Harness 移交：

1. 自有业务输入契约：模式、逐段窗口、参考角色顺序、前后状态、依赖末帧、提示词构造、候选审阅与合成要求。
2. 可审查的 RunningHub 请求/响应适配代码、三类提交结果、固定 backend/configurationDigest 和原任务恢复规则。
3. Harness 端口契约：可信准备/消费批准、一次性持久 gate、历史配置解析、单次 HTTP transport、上传值准备、候选下载/媒体探测/不可覆盖存储、状态通知。
4. 对其现有 FFmpeg 的参数/校验要求，不安装桌面、不迁移本仓库前端、账户 UI、整套 Worker/队列或 Hypit runtime。
5. 缺失配置清单与真实验收矩阵；所有未证实字段保持 unknown。

### 阻塞真实直连的逐项缺口

| 优先级 | 缺口 | 完成证据要求 |
|---|---|---|
| P0 | 真实 AppID、节点/字段与输入顺序缺失 | 应用所有者提供合法 API 配置/导出；记录映射来源/版本/摘要 |
| P0 | 素材上传协议和返回值到 fieldValue 的链路缺失 | 官方协议 + 接收方受支持上传端口，说明图片/视频值类型和有效期 |
| P0 | 新直连全部 mode 关闭 | 每个拟启用 mode 的实际受控验收；不可只改 enabledModes 数组 |
| P0 | 生产 dispatcher/准备记录/历史配置/存储端口未接线 | 由接收方现有 Harness 实现并验证；不接入旧共享 Worker |
| P1 | legacy outputs 文档历史记载为将废弃，V2 兼容未知 | 当前官方证据或有授权的原任务只读验证，明确协议版本 |
| P1 | 无 taskId 的 unknown 处理操作规程不足 | 明确人工/供应商核对路径，保持禁止补发，不凭超时释放 |
| P1 | 结果 TTL/任务保留期及实际账单缺乏证据 | 供应商文档/账户授权只读证据；不编造时间或费率 |
| P1 | W2 不支持选中依赖片段 startFromSegment | 可信且已审阅前段末帧准备服务；`tasks/LAMP-AGENT-VIDEO-W2.md:99` |
| P1 | W2 产物只到候选 review/render，尚非成片 | 接收方接候选审阅/FFmpeg/产物发布；`backend-runtime/README.md:45` |
| P2 | macOS 运行适配未执行 | 接收方 Node/路径/FFmpeg/存储真实验证；不能以 Windows 历史结果替代 |

总剩余接线已在 `tasks/LAMP-AGENT-VIDEO-W2.md:117` 明列。本报告的交付结论是“自有流程与安全契约可移交，真实供应商配置待核实”，不宣称已完成生产去 Hypit 化。
