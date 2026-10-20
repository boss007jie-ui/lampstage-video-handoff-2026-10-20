# 最终专项包工作流事实复审

复审日期：2026-10-20。包根：`output/video-handoff-2026-10-20/Lampstage-video-workflow-handoff-2026-10-20`。本报告路径位于原交接临时审计目录；未修改专项包。

复审范围：README、docs/01–05、contracts/protocol-examples.json、workflows 两份 JSON、examples/local-simulated-flow.ts；交叉阅读原自有视频/单调用/OpenLux适配源码及包内自有 processor。未运行测试、网络、数据库、Git、FFmpeg或任何生成；未读取 Hypit 受限实现、密钥或私有运行配置。主线程给出的 Windows 80/80、protocol typecheck exit 0、fresh 1/1/1、recovery 0/1/0、10+3 契约检查结果未在本复审重跑。

## 结论

未发现将假 App/节点/媒体冒充真实配置、将模拟成功冒充真实生成、允许未知付费提交自动补发、宣称供应商退款或把上传链接 TTL 当结果 TTL 的阻断问题。主要缺口均明确呈现：真实 App/节点/上传映射缺失、W1 enabledModes=[]、旧视频与 single_call 仍经 Hypit、W2 未接生产、macOS/干净安装未实跑。

建议修正下列三处文档精度问题后定稿；它们不要求修改运行代码或重跑全套测试。

## 可行动发现

### P2：direct_references 与 six_references 被合并为相同审阅/依赖流程

- 包 `docs/01-实际流程与接入.md:10` 将二者写在一行，统一列出“候选hash/媒体检查/审阅 → 可选前段末帧接下一段 → 合成”。
- 原 `apps/web/lib/video/processor.ts:77`、`:78` 仅 single_call/six_references 分流，direct_references 仍走普通 processor；`:326` 收取候选后，`:347` 直接 assemble，没有 `accepted` 与 candidate SHA256 的六参考审阅门。
- 六参考单独在 `apps/web/lib/video/sixref-processor.ts:134` 检查每段 accepted/candidateKey/candidateSha256，并在 `six-reference-plan.ts:82`、`:95` 执行已审阅前段末帧依赖。
- 建议拆为两行。direct 写“冻结三参考/切动作片→review消费→逐段生成→收取→合成”；sixref 保留显式候选审阅和依赖末帧说明。`docs/03:27` 若称“按原流程明确接受后才...最终合成”，宜注明这是六参考要求或 Harness 拟采用的更严格要求，避免暗示所有旧模式已具备同样人工门禁。

### P3：模拟文件命名表述过满

- 包 `docs/04-测试与样例.md:49` 称 generated 内容“全部以SIMULATED命名”。
- 只读文件名清单实际还含 `output.mp4`、`normalized-0.mp4`、`concat.txt`、`objects/<hash>.json`。它们由模拟工作目录/原 assembleVideo 中间步骤生成；不是发现了真实素材。
- 建议改为“generated 目录及输入/journal/结果报告明确标记模拟；内部 FFmpeg 中间文件和哈希对象文件可能无 SIMULATED 前缀”。这也便于接收方避免脱离目录单独传播 `output.mp4` 时误认成片来源。

### P3：正常轮询与错误重试的表述需要分开

- 包 `docs/03-Harness适配.md:24` 写“只有read_error.retryable允许对同一taskId有界退避”。
- 包 `docs/02:45` 正确写 queued/running 正常有界轮询；源码 `runninghub-protocol.ts:106`、`:107` 返回 running/queued，它们不是 read_error。
- 建议写“queued/running 可正常有界轮询；发生 read_error 时仅 retryable=true 允许自动退避重查原taskId”。避免接收方停止正常运行任务的轮询；不改变禁止补发 submit 的边界。

## 已核对的关键事实

| 核对项 | 结果与证据 |
|---|---|
| 真实供应商链是否完成 | README:5 明示不能还原已核验真实链；docs/05:30 明示尚不能验收，不夸大 |
| 假节点/假媒体 | 示例代码:1、:45–49、:76、:113–116 和 docs/04:59 均明确 fake；配置JSON webappId/bindings/modelVersions 为 null；无混淆 |
| W1模式关闭 | provider-configuration-status.json:22、README及docs 均有说明；原 runninghub.ts:38 为 enabledModes=[] |
| single_call依赖 | docs/01:11 与源码 video-calls/processor.ts:7、:79 一致，未声称新 HTTP 直连 |
| 旧参考图阶段 | docs/01:16、docs/02:35、协议JSON referenceImageStage 保留 OpenLux Nano Banana 2.1 阶段，无遗漏 |
| OpenLux端点/请求 | 原 providers/nano-banana.ts:2、image-requests.ts:4/:17、openlux-images.ts:78/:80 支持当前别名、v1beta URL、Bearer JSON；未写成App工作流 |
| 两张图顺序/格式 | image-io.ts:37–40 为 composition 源帧→product；:50–53 统一预处理PNG。协议JSON源帧/商品 inlineData 顺序正确 |
| 图片输出与未知失败 | image-reference.ts:42 输出720×1280 PNG；OpenLux adapter:77先标unknown、无自动重试。文档没有拿视频taskId恢复图片同步POST |
| submit幂等/unknown | docs/02:43–44/:52、docs/03:22–24 保留intent/占用/原taskId，不把本方intent当供应商幂等键 |
| 取消 | docs/02:16/:50 与 docs/03:46 区分官方接口存在、当前适配unsupported以及原任务责任；未承诺远端撤销或退款 |
| 费用 | docs/02:58 区分平台credits/maxCoins/video_second和RH实际账单；并发3为本地策略（docs/01:38）；无伪造费率 |
| 上传/结果TTL | docs/02:18 明确“一天”为官方上传链接说明，:31及配置JSON对生成结果TTL保留unknown；没有将上传返回fileName与任意URL混同 |
| Windows与macOS | README:52–54、docs/04:43–45 明确现有Windows依赖/junction、未干净npm ci、未Mac验证；不夸大80/80或类型检查范围 |
| 模拟恢复 | 示例:69–72 已有journal无taskId直接拒绝补发；:82只查询原taskId；:103 recover优先于下载；无网络实现，transport返回fake |
| 模拟持久化限制 | 文件journal并非事务/CAS生产门禁，但 docs/04:59 和示例:116 正确明示；未作为生产 exactly-once 保证 |

上传一天 TTL 属于主线程此次官方文档核对结果。本次禁止网络复核，仅确认文档把它限制在上传链接且保留生成结果未知。包内 `docs/official-doc-check.json` 保存页面链接、提取元数据、校验值，没有原文 TTL 摘录，因此本复审不另行宣称独立验证了该服务商事实。

## 验收建议

修正以上文字后，本包可按“自有代码、契约、离线模拟及真实配置缺口的专项交接”交付。真实 AppID/节点/上传映射、合法完整图、模型/custom node版本、账户权限/费用和真实输出仍须接收方核实；这些缺口不会因80项离线测试、本地媒体模拟或协议类型检查通过而消失。
