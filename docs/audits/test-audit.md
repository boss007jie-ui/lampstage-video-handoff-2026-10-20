# 视频独立交接包：测试与素材静态审计（2026-10-20）

本次只读审计，未运行测试、PostgreSQL、FFmpeg、Git 或网络，也未核验历史日志。未读 `.env`、私有媒体或 Hypit 受限 vendor 源码。下列“可运行”表示从代码推导的条件，不是本机或 macOS 实测通过。

## 五个非 PostgreSQL Agent 视频测试

从 `apps/web` 执行；五文件直接依赖及相对 import 的静态闭包见 `test-files.json`。代码闭包为 5 个测试文件加 34 个本方 TS 模块；外部 npm 包涉及 `@prisma/client`、`sharp`，工具为 `tsx`。`runtime-preparation` 的 `runtimeJobData` 导入会加载 `prisma-runtime` → `prisma-state`，后者在模块顶层导入 Prisma；这是**模块加载依赖**，测试本身并未创建 PrismaClient 或访问 DB。`reference-inputs` 顶层导入 `sharp`。跨机器装包后需有该平台可加载的 Prisma generated client 和 sharp 安装；不需要 PostgreSQL 服务或真实密钥。

| 文件 | 测试性质 | 直接本方依赖 | 外部进程/网络/DB |
|---|---|---|---|
| `agent-video-backend-runninghub.test.ts` | 假 key、假应用映射、注入 transport/gate；协议、unknown、URL 安全 | `backends/{runninghub,runninghub-protocol,contracts}` | 无；没有真实 HTTP |
| `agent-video-backend-registry.test.ts` | 内存 registry 与假 backend | `backends/{registry,runninghub,contracts}` | 无 |
| `agent-video-runtime-state.test.ts` | 内存事务/后端/collector、状态与 fence；真实 RunningHub adapter 也仅注入假 transport | `agent/{contracts,policy,settlement}`、`backend-runtime/{binding,collector,prisma-runtime(type),runner,transitions}`、`backends/{contracts,runninghub}` | 无；`prisma-runtime` 是 type-only import |
| `agent-video-runtime-preparation.test.ts` | 内存已准备 job、timeline、摘要与 legacy 拒绝 | `agent/policy`、`video/{media,types}`、`backend-runtime/{binding,preparation,prisma-runtime}` | 无 FFmpeg 调用；有 Prisma 模块加载依赖 |
| `agent-video-runtime-collector.test.ts` | 假 DNS/下载/内存存储，临时真实纯色 MP4 和损坏字节探测 | `video/media`、`backend-runtime/collector` | **需 FFmpeg 与 ffprobe**；无 HTTP/DB |

推荐 macOS 无桌面、无真实 key 验证顺序（包安装/Prisma client 生成由主线程在独立副本安排；以下命令本次未执行）：

```sh
cd apps/web
./node_modules/.bin/tsx --test scripts/tests/agent-video-backend-runninghub.test.ts scripts/tests/agent-video-backend-registry.test.ts scripts/tests/agent-video-runtime-state.test.ts scripts/tests/agent-video-runtime-preparation.test.ts
VIDEO_FFMPEG_PATH="$(command -v ffmpeg)" VIDEO_FFPROBE_PATH="$(command -v ffprobe)" ./node_modules/.bin/tsx --test scripts/tests/agent-video-runtime-collector.test.ts
```

第二条必须能在 PATH 找到两个工具，或设置这两个路径。collector 在 `os.tmpdir()` 的 `lamp-candidate-*` 目录调用 `ffmpeg -f lavfi -i color=... -c:v mpeg4 -pix_fmt yuv420p` 自造蓝/红/绿 64×64、10 fps、2 秒视频，`probeMedia` 再调用 ffprobe；还用内存中的 `not a video` 检验损坏媒体。视频字节只经过注入的模拟下载端口与内存存储。无摄像头、浏览器、桌面或用户素材需求。测试结束清理临时目录。测试的 `video.example.test` 和 `203.0.113.7` 是假 URL/IP，代码中的 transport 不发真实网络请求。

`scripts/tests/agent-video-runtime-postgres.test.ts` **不要纳入 macOS 模拟命令**：它新建两个 PrismaClient、读取并执行 `prisma/migrations/*/migration.sql`，通过 `scripts/tests/helpers/isolated-agent-postgres.ts` 启动临时 PostgreSQL。helper 明确 `require.resolve("@embedded-postgres/windows-x64")`，拼 `.exe`，因此当前实现为 Windows 专用；需要相应 native 包、ASCII 临时路径和回环端口。`video-call-postgres.test.ts` 也以 `RUN_VIDEO_CALL_DATABASE_TESTS=1 && process.platform === "win32"` 门控，属于另一组测试。`npm run video:test` 另包含既有视频测试及 vendor 测试，不能当作此五文件的无 DB、无受限源码交接入口。

## 单调用与媒体素材边界

现有 `video-call-{acceptance,contract,engine,ledger,motion}.test.ts` 采用内存 fixture/端口；`video-call-postgres.test.ts` 为上述 Windows 隔离 DB 测试。它们测 `lib/video-calls/**` 单调用路径，并非 W1/W2 Agent backend/runtime 的依赖；如交接包要展示单调用业务行为，可另列为可选组，先静态检查其完整依赖再在目标环境运行。`video-call-motion` 以构造的媒体信息校验音轨、时长、画幅，不提供真实成片。`apps/web/scripts/tests` 中没有现成 `.mp4`/`.mov` fixture；当前可合法交接的媒体生成方法是 collector 测试自造的纯色 lavfi 命令及代码，临时产物不应视作用户视频或 provider 输出。不要复制私有原片或历史测试媒体进包。

## 证据判定

W1 文档记录 27/27 离线 fake 测试，W2 文档记录 38/38 纯/本地媒体及 18/18 Windows 隔离 PG，并明确真实 RunningHub mode 仍 `enabledModes=[]`、没有供应商调用、真实素材上传或对象存储。这里未复验这些历史结果；它们不能证明 macOS 可执行或真实 provider 出片。`tasks/2026-10-18-video-workflow-recovery-spec.md` 的真实生成/历史媒体叙述属于另一条既有试验，不是本 Agent 模拟交接包的真实 provider 出片证据。当前审计范围内**没有 Agent W1/W2 经真实 provider 生成视频的证据**。实际 macOS 运行、Prisma/sharp 原生装包、FFmpeg/ffprobe 可用性均待主线程验证。

依据：`tasks/LAMP-AGENT-VIDEO-W1.md`、`tasks/LAMP-AGENT-VIDEO-W2.md`、`tasks/LAMP-AGENT-CONTROL.md`、`docs/knowledge/2026-10-16-video-route-evaluation.md` 与上述测试/导入模块。知识文档的历史路线陈述不替代当前能力或真实账单证明。用于复刻目的触碰 Hypit 受限源码：否。
