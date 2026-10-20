# 六图视频切换实施记录

2026-10-15。根据用户“确定换六图工作流”的确认，以及[本地生成经验原文](../knowledge/video-replication/sources/2026-10-15-infant-sixref-original.md)实施。目标方案和历史问题见[联合修正方案](2026-10-14-video-replication-corrective-plan.md)。

## 已实现

- 新建视频默认 `six_references`，使用独立的六图 provider/runtime；旧任务按原模式恢复回执，不改写已有输入。
- 每段提交 1–6 张完整、有序、带用途的参考图；可按段覆盖整组参考。产品图不固定第一张，不自动丢弃、重复或填充已有参考。普通参考图中的 start/end state 是语义提示，不是专用首尾帧端口。
- 必须提供覆盖完整原片的动作窗口、生成时长、前态、局部操作和后态。当前适配器允许 4/5/6/8 秒生成请求；这是本版本经过合同验证的支持范围，不是模型全局时长极限。动作窗口轻微变速适配请求，两个方向均不得超过 15%；不会用尾部不足的短余量代替完整动作。
- 准备阶段只校验原片、冻结参考快照和提取动作片，生成 48 kHz 单声道静音 AAC 引导，不发起图片或视频生成。状态参考图需要先制作、审阅并上传，当前没有自动多参考合成状态图接口。
- 独立片段最多三路并行；数据库账户锁统一约束本平台新旧模式、多个任务和 worker。提交意图、回执、候选等整块任务写入串行并检查 revision/lease。未知结果保留槽位并停止新付费，已提交的其他片段继续收取。
- 依赖前段的片段只有在前段候选审阅通过后才开放，以其实际最后解码帧替换本段指定 start_state。客户端预览与实际提交使用同一有效参考。
- 每段保留原生成视频、SHA-256、实际尺寸/帧率/帧数/时长和实际末帧。按候选哈希接受或对指定片段重试；重试保留旧回执、增加 attempt 并撤销旧费用确认。明确的提交前失败也需显式重试。
- 可以审阅后裁掉明确重复的开头，仍受完整动作与 15% 变速约束。所有候选接受后才合成 720×1280、30fps 成片，并恢复原视频音频、完整解码验证和保存成片哈希。文件校验不能代替正常速度播放和画面验收。
- `reconcile` 只核对原回执。只有带有效 task ID 的明确上游失败才释放失败槽位；超时、传输错误、本地 Hypit 失败或不明确输出保持 unknown。部分本地失败且上游结果未知的回执仍需人工核查，不能保证自动恢复。
- Expert 0.4.0 包含语义分段、参考用途、审片/重试/接续、原片完整播放要求；stdio 桥接新增绝对路径本地文件上传，走既有认证 multipart 接口。远程 MCP 仍接收 URL。

## 验证证据

完整 `video:test`：149 项通过，0 失败；另有 1 项 POSIX 子进程取消测试因 Windows `TerminateProcess` 语义而跳过。该项随后在部署后的 Linux 容器设置 `RUN_VIDEO_MEDIA_TESTS=1` 单独补跑通过，合计 150 项已验证。Windows 全套启用了 `RUN_VIDEO_MEDIA_TESTS=1` 和 `RUN_VIDEO_DATABASE_TESTS=1`。

覆盖真实隔离 PostgreSQL 的 4 客户端/20 次抢占、最多 3 槽、未知回执跨重启保留、过期租约隔离、历史任务迁移及 adoption；真实 FFmpeg 的 16.3 秒语义窗口、静音 AAC、实际末帧和裁重复；真实处理器配合模拟上游的四段并发、未知任务停止第四次提交、其余候选收齐、原任务核对、16 秒合成得到 720×1280/30fps/480 帧，以及候选文件被改后拒绝合成。没有生成费用。

TypeScript 检查、Next 生产构建、`git diff --check` 通过。真实 Hypit CLI 对假参考素材执行 check/plan，成功解析一条六图请求；没有执行付费 build。代码复查中发现的失败分类、先查询再恢复、时长边界、旧路由最终 permit 检查、失败重试入口和旧任务迁移问题均已修复并复核。

Expert 0.4.0 共 16 个条目，CRC 和源文件逐字节比对通过；SHA-256 为 `95CFEB0E1C450EC018A175B6ECAC7942821B2A2D591985E977E8D592F7A80D59`。见[包校验记录](../knowledge/video-replication/PACKAGE_CHECK_0.4.0_2026-10-15.json)。原始经验归档与来源的哈希相同，原文中的费用和案例文件没有装入客户包。

## 部署记录

**已于北京时间 2026-10-15 07:31 完成上线核查。** 上线前生产基线为 `69070f88950f0242872e54f118f1f98ccb3f7daf`；排队/执行中的视频任务为 0，未收齐候选的提交意图或 build 为 0。先备份并停止旧 web/worker，再完成 `20261015120000_video_permits` 迁移、创建独立六图 runtime，并启动维护状态服务进行检查；之后恢复原有 `VIDEO_WORKER_PAUSED=false`、`VIDEO_PAID_GENERATION_ENABLED=true`。没有新增付费确认或生成请求。

代码部署包共 44 个文件，SHA-256 为 `B295D6B8003CB8E0CDA758AB5ACA3A738AAD2935C20F5AD60B5803170B870B14`。服务器逐文件哈希核对通过，旧源码、数据库备份、私有配置、web/worker 镜像回滚标签保存在服务器私有目录 `/srv/lampstage/releases/sixref-20261015-01`；部署流程见[运行环境说明](../deployment/2026-10-15-sixref-runtime.md)。两容器实际镜像均为 `sha256:f098d00b77122bb5add39bc0dae3d2f97cb4eb7465a6db05901f4588130836be`。

公网 [capabilities](https://lampstage.com/api/v1/capabilities) 返回 `available`、`default_mode=six_references`、最多6张、账户并发3、720×1280/30fps，以及 review/assemble/reconcile 端点。[health](https://lampstage.com/api/v1/health) 返回 ready。新 worker 最新心跳中 image/video/sixref 均 ready；容器内旧/新 runnerReadiness 均通过。上线后视频项目仍为原来的 3 attention、1 completed、1 draft、1 review；新增 permit 为0，排队/执行中为0。

主项目已同步与部署包一致的源码、测试和文档，原有无关工作区改动保留。未执行 Git commit/push。Expert 0.4.0 安装包已生成并校验，需要在 WorkBuddy 重新导入后使用；旧版本不会自动同步。已有三图 review 项目保留原模式，新建项目才默认六图。

本次不重新调用付费视频生成。用户提供的历史成片验收是本次接入依据，仍存在原文记载的袖口/手镯偏差；新版本部署或合同测试通过不等于任意新素材的成片质量已通过。
