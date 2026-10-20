# 原视频＋角色参考图：实现、验收与上线交接

2026-10-14。本地代码与 Expert 0.3.0 已完成；本轮未部署、未触碰线上任务／开关、未生成付费视频，也未替换用户已安装的专家。历史依据见[实际生成方式核对](../knowledge/video-replication/DIRECT_REFERENCE_EVIDENCE_2026-10-14.md)，设计见[实现计划](../superpowers/plans/2026-10-14-direct-reference-video.md)。

## 新任务的实际行为

`create_video_job` 使用 `generation_mode: direct_references`；产品图固定为 Picture 1，另外两张参考图按数组顺序成为 Picture 2、3。两项均需要 asset_id、role（character/scene/product_detail）、label。三张图必须不同且归当前用户所有。没有隐式填充、拼图、丢弃第四图或退回首尾图流程。

```json
{
  "source_asset_id": "SOURCE_ASSET_ID",
  "product_asset_id": "PRODUCT_ASSET_ID",
  "generation_mode": "direct_references",
  "reference_assets": [
    { "asset_id": "BABY_ASSET_ID", "role": "character", "label": "宝宝" },
    { "asset_id": "MOTHER_ASSET_ID", "role": "character", "label": "妈妈" }
  ],
  "instructions": "按已确认的产品结构保留原视频动作与顺序，分别使用宝宝与妈妈参考。",
  "preserve_audio": true
}
```

prepare 校验源片、读取并归一化三张图、保存私有快照和 SHA-256，切出视频片段。没有首尾帧提取或图片生成调用。当前限制仍是 4–30 秒、9:16，片段为 4–5 秒的自动时间窗口，不代表动作语义分段已实现。

`get_job` 返回 generation_mode、完整三图 reference_assets、references_ready、source_duration、片段源视频链接／trim_start／keep_duration，以及渲染前就可查询的当前报价。用户确认参考图与预算后才进入 render；授权绑定图片、顺序、角色、标签与快照摘要，实际下载的字节还需再次核对 SHA-256。H3 使用三个普通 ReferenceImage＋原视频，继续保留现有付费意图、回执、租约、revision 和不自动重复提交规则。

图片服务未配置不再阻断 direct prepare/render；已有视频回执的 reconcile 也不依赖图片服务。全局维护／付费开关仍控制队列开放，本次没有放松运维开关。没有切换模型、provider 或新六图应用。

## 验证记录

- `npm run typecheck`：通过。
- `npm run build`：通过编译、lint、类型检查及 44 个静态页面构建。
- `RUN_VIDEO_MEDIA_TESTS=1 npm run video:test`：本轮首次全量 84 项，83 通过，1 项因 Windows 的进程信号行为不同而跳过。包含真实 FFmpeg 16.3/30 秒时间线与音轨检查、direct prepare 的零端点图片生成、归属校验、参考摘要变化失效、只提交一次与租约丢失保护。
- `node --test scripts/tests/video-expert-bridge.test.mjs`：6 项通过；仅临时本地 HTTP 服务与假 token，覆盖能力缺失／维护时禁止 direct POST、引用顺序、数量、重复输入和旧任务行为。这 6 项已纳入后续 `video:test` 命令。
- `npx tsx --test scripts/tests/mcp.test.ts`：4 项通过。既有测试的异步审计日志因未设置 DATABASE_URL 输出非阻断提示；该测试没有验证真实数据库日志写入。
- 独立审查修复了 reconcile 仍要求 image_ready 的遗漏；增量复审未发现阻塞问题。
- Expert 0.3.0 为 16 个文件、35,893 字节；ZIP CRC、文件集合、隐藏 `.mcp.json` 和逐文件源字节一致。SHA-256：`E1041B755D23C3733B3BDE9BDF998A6F79AA9DCBCFF5E8F9242692A4E7868143`。明细见[包校验记录](../knowledge/video-replication/PACKAGE_CHECK_0.3.0_2026-10-14.json)。

这些验证证明本地通路与保护逻辑，不代替真实 H3 画面质量、双人物身份一致性、动作完整性或成功率测试。

## 上线顺序与旧任务

### 2026-10-14 后续审查：正式开放付费前需补审阅绑定

用户转来 WorkBuddy 对 Expert 0.3.0 安装、逐文件一致性与注册成功的反馈；这是安装方核验结果。本轮没有再次检查其安装目录，也没有修改 0.3.0 源包或产物。新六图迁移按用户决定等待 hypit 项目正在执行的线下测试。

代码复核确认：stdio 和远端 MCP 的 `render_video_job` 都只收 job_id/max_coins，桥接两个确认布尔值。两条服务端 render 路由在 POST 时重新读取配置报价、计算当前参考摘要，未要求回传 GET 展示时的报价或审阅标识。因此缺口发生在展示与提交之间；已保存 renderConsent 后，worker 会拒绝高于已确认单段报价的配置价格。

本地无网络纯函数复现：展示价 100、提交价 120、maxCoins=200 时，当前 validateRenderConsent 接受并记录 120；随后 worker 检查报价 130 会拒绝。该复现没有创建真实任务或执行生成。`max_coins` 未传入 RunningHub，也不按实际扣费扣减，因此是平台预估预算门，不是上游账单硬封顶。参考摘要绑定的是 POST 当时内容，尚不证明与先前展示内容相同；正常快照冻结且无常规修改入口，参考变化概率较低，但合同仍应绑定。

建议的上线前修正：GET 生成 `review_token`，绑定任务／模式、参考快照、动作窗口、待生成片段和展示报价；两种 MCP 与两条 render 路由要求回传同一个 token，缺失或与当前状态不符即停止，状态变更返回 `409 review_changed`，重新展示并确认。桥接不能临提交自动获取新 token 后继续生成。显式暴露确认布尔值可改善合同，但不能单独解决版本绑定，更不能证明真人曾确认。

至少补充“展示后涨价但仍低于预算”“展示后参考或片段变化”两类拒绝用例，继续保留入队后涨价、租约、回执及不重复提交保护。现有 API 测试中的 `binds that exact review` 仅覆盖展示和提交之间数据不变的路径。此项尚未实施，不把本轮评估记为已修复；安装验证与独立六图测试可继续。

### 部署步骤

1. 在当前大量未提交内容中按本次文件范围审查并保存变更，不使用全量 stage/reset。无需 Prisma schema 迁移；新模式与快照保存在已有 JSON 字段中。
2. 协调停止旧视频 worker 领取任务，确认已有付费回执并妥善保留当前任务；部署同一份 web 与 worker 代码。不要混用旧 worker。新 direct prepare 使用 `prepare_references` 阶段，旧 worker 会拒绝该阶段而不生成首尾图；这是防误付费措施，不保证混跑可用。
3. 检查 web 与 worker 实际进程的开关一致，不只检查磁盘 env 文件。先前发现的 web/worker 配置不一致见[卡点报告](../deployment/2026-10-14-kids-replica-blockers.md)。本次没有把该线上问题标为已修复。
4. 检查远端 `capabilities[]` 中 `id=video.replicate` 的项目包含 `modes.direct_references`，并检查真实 worker 状态。维护状态应继续展示维护，不能靠安装新版专家绕过。
5. 导入[专家 0.3.0](../../workbuddy-expert/releases/lampstage-creative-expert-0.3.0.zip)。旧安装不会自动同步。新专家发现服务端不支持新模式时会停止，不静默回退。
6. 当前已有的 v1/v2/v3 任务仍是旧模式，不能直接把其 prepare 当作新流程。若继续当前童装案例，应复用已入库的源片、产品、宝宝和妈妈资产，创建明确标注 direct_references 的新任务。不要复写旧任务或清除已有回执。
7. 新任务准备完成后审阅全部参考、动作窗口及报价；只有具备针对该任务的预算授权才开始正式渲染。已完成本地模拟测试不构成新的付费授权。

## 尚未覆盖

第四张独立场景图、自定义动作分段、选定单段先渲染、独立口播混音与局部改色均未在本次实现。六图应用的接入和质量对比需要单独验证，不能由槽位数量推断质量提升。历史案例中的场景图整理仍可作为用户主动选择的制作手段，不再作为固定首尾帧前置流程。
