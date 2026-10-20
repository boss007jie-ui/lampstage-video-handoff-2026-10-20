# 视频后端 Wave 1

本目录是独立协议边界，尚未接入现有 processor、Worker、API、数据库或生产配置。只做显式依赖注入和离线验证。没有读取或复制 Hypit 上游实现，没有新增依赖。

## 接口与安全边界

- `contracts.ts`：`VideoGenerationBackend`、`VideoAttemptBinding`、`VideoSubmissionIntent`、`VideoSubmissionGate`、提交/状态/结果 DTO，以及 `publicVideoResults`、`cancelVideoTask`。
- `runninghub-protocol.ts`：`RunningHubApplication`、`RunningHubTransport`、请求构造与纯响应解析。构造出的请求含凭据，是服务端私有值，禁止日志、异常正文、事件或 API 返回。纯解析器不知道运行时凭据；后端包装层额外阻止凭据被反射为 taskId/下载链接。
- `runninghub.ts`：`createRunningHubBackend(options)`。不读环境，不导入 fetch，不进行上传；未注入凭据、已核对的应用映射、transport、gate 时不能提交。transport 必须单次请求、禁止重试付费 POST、禁止重定向、禁止记录私有请求；请求自带 `redirect: "error"` 和有界 AbortSignal。
- `registry.ts`：`VideoBackendRegistry`、`VideoJobBackendBinding`。新任务选择后固定 backendId；恢复只按 job/attempt 原绑定选择，缺失历史后端时明确失败。默认后端变化只影响新 job。

backendId 绑定供应商、账户逻辑 ID、应用 ID、映射版本、查询协议和配置 SHA-256。摘要包含节点映射，不包含凭据。即使配置维护者忘记提升映射版本，节点目标变化也不能复用旧 attempt。凭据轮换必须仍指向同一账户；本模块无法根据一个字符串证明账户身份。

`VideoSubmissionGate.claim` 是必须实现的持久化端口，测试中的 Set 仅证明端口调用语义。生产 gate 必须原子核对服务端身份、job/step/attempt、冻结输入摘要及配置摘要、有效审批、review_token、permit、租约/fencing，写入唯一 submitting intent 后才返回 `claimed`。门禁获取不到明确结果时不能请求供应商。已经 submitting/unknown 的记录优先返回 `already_claimed`，即使此后审批过期也不能当作明确未提交。网络调用始终在事务外。后端不负责账本或 intent 保存，也不声称外部 exactly-once。

| 提交结果 | 含义与恢复要求 |
| --- | --- |
| `definite_not_submitted` | 此次调用在发送前被阻止，或取得可识别的明确业务拒绝。是否发起新 attempt 仍须重新检查原记录与审批，不自动重试 |
| `accepted(taskId)` | 供应商已提供回执；立即以 CAS 持久化绑定，同一 taskId 查询，不表示生成成功 |
| `submission_unknown` | 断连、超时、HTTP 非成功、解析不明、冲突或门禁不明。保留预算/permit；如果附带 taskId 可查询原任务，没有 taskId 则停在 attention 等核对 |

未持久化回执即崩溃时，原 submitting intent 必须阻止再次提交。响应到达后的持久化失败不能转换为明确失败并释放预算。真正的跨进程恢复、CAS/fencing、预算与 permit 事务仍是下一批数据库适配工作。

只读查询每次调用最多发出一次请求。`read_error.retryable` 仅表示上层可对**同一 taskId**做有界退避查询，并不是生成重试授权。不认识的响应和 task-not-found 都不转换为任务完成、任务明确失败或未提交。

`results()` 的 `outputs.downloadUrl` 是服务端短期下载描述；`publicVideoResults()` 只保留安全状态、代码及数量。不透传 `msg`、traceback、原始响应、供应商费用字段。媒体下载与持久化由后续收取层完成：核对目标域名/地址、大小、编码、时长、音轨与内容，再存入我方对象存储，公开接口只签发我方资产 URL。这里的 completed 只表示供应商有结果，并不等于候选视频合格或用户已接受。

## 官方协议证据（2026-10-16 只读核对）

### 已确认的通用字段

1. [AI 应用提交 api-425749010](https://www.runninghub.cn/runninghub-api-doc-cn/api-425749010)：POST `/task/openapi/ai-app/run`；JSON `webappId`、`apiKey`、`nodeInfoList`；每项 `nodeId`、`fieldName`、`fieldValue`。示例带 Bearer 及 JSON Content-Type。大整数 ID 一律按字符串保留，避免 JavaScript 精度损失。应用调用示例中也使用字符串 webappId。
2. [AI 应用完整接入示例](https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287339)：成功信封 `code: 0`，`data.taskId`；该示例注明旧 `/task/openapi/status` 已停止维护。`promptTips` 不是本模块的成功/失败权威，不透传其中节点细节。
3. [结果 api-425749004](https://www.runninghub.cn/runninghub-api-doc-cn/api-425749004)：POST `/task/openapi/outputs`，请求含 `apiKey` 和 `taskId`，成功是 `code: 0` 与 `data` 数组，条目使用 `fileUrl`、`fileType`（页面另列耗时、节点及费用字段，本模块不采集账单）。
4. [高阶接入示例](https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287340)及[错误码表](https://www.runninghub.cn/runninghub-api-doc-cn/doc-8287338)：旧 outputs 中 804 运行中、813 排队、805 异常/失败；成功码 0 且有非空结果才按 completed 处理。未知状态保守拒绝解析。
5. 同一错误码表中，参数、应用不存在、鉴权、节点匹配、创建余额不足等含义用于明确业务拒绝白名单；500/未知码、忙碌、超时及 804/813 不表示未创建。HTTP 非成功即使含拒绝字样也按 unknown；拒绝码与 `data.taskId` 字段同时出现按冲突处理，只有安全字符串 ID 可保留。数值 ID 可能丢失精度，非法字符串或显式空值也不能证明未创建：均返回不含原始 ID 的 unknown。只有该字段完全缺失时才可继续判定明确拒绝。文档并没有给出所有故障的幂等/无副作用保证，本模块不将所有非零码一概视为明确拒绝。
6. [开始页](https://www.runninghub.cn/runninghub-api-doc-cn/)区分 AI 应用 API 与模型 API 的 Key 类别。未读取或验证当前账户 Key；本模块不能用接口类型猜测实际权限。

### 新旧查询协议决策

| 接口 | 已核实格式 | 本批选择 |
| --- | --- | --- |
| [旧 status](https://www.runninghub.cn/runninghub-api-doc-cn/api-425749003) | `apiKey + taskId` 请求；页面标将废弃，接入示例称已停止维护 | 不调用。`status()` 从 outputs 查询归一化状态 |
| [旧 outputs](https://www.runninghub.cn/runninghub-api-doc-cn/api-425749004) | `code/msg/data[]`，`fileUrl/fileType`；也标将废弃 | 保留官方 AI 应用示例可证明的轮询协议，backendId 明确带 `legacy-outputs-v1` |
| [V2 query](https://www.runninghub.cn/runninghub-api-doc-cn/api-425767306) | POST `/openapi/v2/query`；Bearer；body 只有 taskId；成功示例是顶层 `taskId/status/errorCode/errorMessage/results[]`，结果项 `url/outputType` | 已核对替代协议。现有证据未明确保证接收 AI 应用旧提交生成的 taskId、各 Key 类别兼容性及完整状态枚举，因此本批不静默替换，也不接受 V2 响应为旧协议成功 |

V2 是正式查询文档，但“有新文档”尚不能证明当前 AI 应用迁移完成。后续补足官方兼容说明或已授权只读查询证据后，可新增带新协议身份的 adapter；既有 job 保留原 backend。不能因为旧接口废弃而偷偷重交付费任务。

### 当前应用尚未验证

具体 webappId、允许修改的节点/字段、参考素材上传表示、六参考角色及顺序、源视频窗口、生成时长、分辨率、音频、模型参数和输出质量均未通过此直连实现验证。代码里没有真实应用 nodeId 配置。`mappingEvidence` 是可信服务端配置来源引用，运行时结构检查不能替代真实应用语义核对。

因此即使显式注入协议测试映射，也只打开低层 submit 接口供受门禁控制的调用；`enabledModes` 始终为空，`sixReferences/sourceWindow/audio` 为 unknown 且 disabled。注册表不会给新业务 job 分派此后端。取消、退款、实际账单能力均未实现。

官方文档没有确认结果 URL 的有效期，也没有保证重复查询一定刷新 URL。离线测试模拟旧 URL 返回 403 后再次查询原 taskId 得到新 URL；只证明后端不缓存链接、不重新生成。`expiresAt` 始终 null。真实链接更新与任务保留时长需后续验证。

### 后续真实验证需另行授权

应用字段/权限可优先用明确授权的只读查询核对；密钥由站外安全配置提供，不输入对话。任何真实生成、上传计费或付费样本测试都须后续单独授权，并记录预算/次数。Wave 1 没有做这些操作。

## 下一批串行接入顺序

1. 由统筹冻结持久化接口，将 job/attempt/backendId、intentId、配置/输入摘要和 fencing 存入现有任务/新 adapter。ActorContext 提供 userId。事务检查审批/预算/permit 后建立唯一意图；接管者只核对原意图。
2. prepare 继续生成不可变素材快照和 review_token；render 之前再次验证 token 与选定片段、参考、价格及审批一致。`gate.claim` 最后一次核对 permit/执行权，网络调用不放进事务。
3. 将 accepted 回执保存为 providerTaskId；unknown 保持占用并进入 attention。reconcile 只查询原 backend/taskId；无 taskId 的未知提交需要外部核对，不回到 submit。旧 Hypit job 按原标识由旧链路识别，不能解释为新的 RunningHub task。
4. 输出下载后走现有 candidate 媒体检查/hash/对象存储，保留 candidate 审阅和版本选择。协议成功不是候选验收。
5. 只有已选且通过检查的候选进入现有 `assembleVideo()`/FFmpeg，再沿用交付链。保持既有音轨、裁切、窗口和片段顺序规则，不引入 HyperFrames。

## 离线测试

在 `apps/web` 使用已安装的本地 tsx，不安装依赖：

```powershell
.\node_modules\.bin\tsx.cmd --test scripts/tests/agent-video-backend-registry.test.ts scripts/tests/agent-video-backend-runninghub.test.ts
```

只注入 fake transport、fake gate 和假凭据；不使用数据库、不启动 Worker、不调用 Hypit CLI。全局 typecheck 与既有视频回归由统筹串行运行。实际交付结果见任务单及 `.codex-tmp/commerce-agent/video/`。
