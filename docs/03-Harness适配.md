# 接到已有macOS Harness：只接能力，不搬平台

先阅读 `source/apps/web/lib/video/backends/contracts.ts`。宿主接口未知，因此下列是接入契约，不是声称已编写了接收方adapter。

## 交给宿主的职责

| 已有能力 | 必须承担的语义 |
|---|---|
| 账号/凭据保存 | 真实当前用户与供应商逻辑账户；密钥只在私有transport配置注入，不经模型/聊天/公开事件 |
| 队列/任务记录 | job/stage/attempt的持久身份、不可变输入摘要、历史backend/config、原提交intent和taskId |
| 租约/事务 | 原子gate、一次发送权、fencing、CAS回执保存；事务外执行网络；旧拥有者不能晚写 |
| 费用预留 | 明确报价/批准、未知提交保留预留、已核实终态结算；本地上限不是供应商账单硬封顶 |
| 产物管理 | 真实上传引用、媒体hash、私有下载URL、不可覆盖本地对象、完整readback后的receipt |
| FFmpeg/后期 | 切片/音轨要求、实际时长分辨率探测、候选审阅、合成与最终资产发布 |

不要部署旧Lampstage Worker或复制整套User/credit/Agent表。`PrismaVideoRuntimeStore`、`prepareVideoBusinessJob`需要原Agent审批/预算/数据结构，仅作参考。Harness的GenerateOptions不是Lampstage旧run/turn/step API；不能伪造actor/审批来填DTO。应以宿主真实可信身份和持久操作记录实现适配；如果无法合法满足`VideoAttemptBinding`，先只复用纯build/parse函数，待宿主接口设计后再接gate/runner。不要启动第二个AgentLoop。

## 一阶段的调用顺序

1. **准备输入**：由宿主选择实际阶段与获权App，检查图/音视频，冻结素材hash、参考图顺序、prompt、时长/分辨率及真实映射版本。上传由宿主端口负责；按核实节点选择fileName或URL，不能把本地文件路径发给云节点。
2. **保存配置与批准**：持久化供应商逻辑账户、AppID、完整映射、查询协议、configurationDigest、输入摘要、价格版本和批准。既有任务以后只能按这份历史配置恢复，不能跟随默认App变化。
3. **提交阶段**：`createRunningHubBackend({ application, apiKey, transport, gate })`。transport只做一次请求、禁止重定向/内部重试付费POST/记录请求。gate在同一事务核对真实身份、原任务输入、批准、预留/permit、fence，落盘唯一submitting intent后才返回claimed。
4. **保存远端身份**：`accepted(taskId)`后立刻CAS保存到原stage/attempt。若发送后崩溃、回执保存失败、超时或结果不明，保留submitting/unknown，不能释放后重新提交。有taskId只查原任务，无taskId转人工/供应商核对。
5. **恢复查询**：从自己的受归属校验记录读取backendId与taskId，解析原历史backend，调用status/results（内部是只读POST outputs）。queued/running可继续正常有界轮询；遇到read_error时，只有retryable=true才允许自动退避重试同一taskId。404/余额变化/缺配置都不能证明未提交。
6. **取回结果**：先`collector.recover(identity)`核对已保存receipt。没有则查询原结果，用严格HTTPS允许域名、DNS/连接地址钉扎、无重定向、大小和时限控制下载；以真实FFprobe检查时长/尺寸，原子create-only存储，再完整readback/hash校验，最后发布receipt。
7. **下一阶段输入**：读取receipt的本方不可变产物及hash；如云端下阶段要求上传，重新经宿主上传端口生成该账户有效的引用。不要沿用短期签名URL作为永久资产，也不要把本方storageKey误当RunningHub fileName。
8. **审阅与合成**：候选完成不等于质量合格；六参考原流程须明确接受后才作后继参考或合成。普通legacy/direct处理器会直接合成，没有同一accepted门禁；接收方可另加审阅，但不能称其原本已具备。W2只到候选review，且不支持选中依赖片段自动继承末帧；接收方需要独立准备这条经审阅的依赖流程。

## 最小持久化记录建议

```text
host真实用户/账户/任务/阶段/attempt
历史backendId + provider/accountId/AppID/mappingVersion/configurationDigest/queryProtocol
inputDigest + 具体冻结输入和素材hash + 批准/价格版本 + 本地预留
intentId + state(submitting/accepted/unknown/terminal/collected) + fence
providerTaskId(可空；为空unknown时不能补发)
上传引用(type、fileName或download_url、账户/素材hash、有效期证据)
receipt(key、sha256、sizeBytes、duration、width、height、identityDigest)
真实供应商账单字段(未核实则null，不能用预留/估算冒充)
```

这是字段语义清单，不是要求新建Lampstage数据库。具体类型见contracts和collector。外部taskId与旧Hypit buildId不能互换；`intentId`未传给RunningHub当幂等键，也不保证供应商exactly-once。

## 取消、换账号和故障窗口

收到取消或换账号后，宿主停止尚未提交阶段，并使旧lease失效；旧任务回执只归原账户。gate提交前可阻止发送，gate提交后到网络返回间无法保证远端取消。W1取消明确unsupported；保留unknown的原任务身份和预留，继续只读核对。下载失败可恢复原产物或查原链接，不能重新生成。不得以另一个账号/新App/新attempt绕过未知账。

真实适配验收应覆盖：同阶段重复触发、提交前取消、提交后丢回执、保存taskId失败、查询404/超时、URL过期、落存储后丢响应、旧fence晚回、换账号、后继阶段仅使用已接受产物。本包现有模拟测试覆盖其中的状态语义；接收方自身存储/队列/网络实现仍须单独验证。
