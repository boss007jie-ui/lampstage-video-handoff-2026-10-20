# 专项交接包最终测试入口静态复审（2026-10-20）

复审对象：`output/video-handoff-2026-10-20/Lampstage-video-workflow-handoff-2026-10-20/`。只读检查包根 `package.json`/锁、`scripts/*`、`README.md`、`docs/04-测试与样例.md`、`examples/local-simulated-flow.ts`、`evidence/current/results.json` 及其相对源码清单。没有运行测试、安装、数据库、FFmpeg、网络或 Git；未打开私有素材、凭据、Hypit 受限 vendor 代码。以下是**交接包当前快照的静态判定**，不是 macOS 实测。

## 需在最终交付前处理

1. **README 的全载荷清单链接缺失。** `README.md` 目录表承诺 `FILE-MANIFEST.json` 含本交接全部载荷的大小与 SHA256，但包根 `Test-Path` 为 false。这会让接收方无法按承诺核对复制完整性，并降低 `node_modules` junction 未进入最终载荷的可证明性。应生成该清单并按最终实际载荷复核；若不提供，删除该承诺并明确替代校验方式。清单应排除包内临时 junction/安装目录，同时覆盖将要交付的媒体和文档。
2. **不能把精简锁视作已验证安装。** 根 `package.json` 固定 `@prisma/client 6.19.3`、`prisma 6.19.3`、`sharp 0.34.5`、`tsx 4.22.4`、`typescript 5.9.3`，根锁为 v3，含 darwin arm64/x64 的 esbuild/sharp 可选包；包内现有 `node_modules` 是指向原 `apps/web/node_modules` 的 Windows junction，`.gitignore` 排除它。`README`/`docs/04` 已诚实写明锁仅补元数据、没有干净 `npm ci`、没有 macOS 验证。保留这一限制；最终 ZIP/提交要实际排除 junction，接收方需要自己 `npm ci`，原 Windows 80/80 不能保证传递依赖、原生包或 Prisma engine 在 Mac 安装成功。
3. **Prisma 生成的适用范围要始终精确。** `npm run client:generate` 指向 `source/apps/web/prisma/schema.prisma`；schema 数据源含 `DATABASE_URL`/`DIRECT_URL` 字段，但此命令是生成原测试所需客户端，不是启动 DB/迁移。默认 core 组的 `agent-video-runtime-preparation.test.ts` 经 `prisma-runtime.ts` → `prisma-state.ts` 在模块加载时使用 `@prisma/client`；不要写成全部 W1/七文件运行都要求真实 PostgreSQL。生成步骤本次未在交接根的干净安装上执行，macOS 接收方仍需验证。W1 协议适配本身不需要 Prisma。现有 README/docs/04 基本表达正确，后续摘要和发布说明须沿用此限定。
4. **默认测试要与 Windows 数据库 helper 分离。** `scripts/run-tests.mjs` 只列六个 core 文件和一个 collector 媒体文件，没有 `agent-video-runtime-postgres.test.ts` 或 `video-call-postgres.test.ts`；后者的 helper/门控是 Windows 专用。`npm test` 纯/内存组，`npm run test:media` 需要 FFmpeg/ffprobe，`npm run test:all-local` 为重叠合集。README/docs/04 的说明与脚本一致。不要把已打包的 PG 测试源码解释为 macOS 默认可跑或 80/80 含数据库事务。若接收方需要本地 PG 回归，应另移植 helper；不是当前模拟交付的验收条件。

## 已核对且可交付的模拟边界

- 静态遍历默认七个测试、`examples/local-simulated-flow.ts`、`scripts/check-contract-samples.ts` 的相对 `import`/`export` 闭包：**45 个本方文件，缺失相对导入 0**。外部模块导入只有 `@prisma/client` 与 `sharp`；执行还需 `tsx`，媒体操作另需系统 FFmpeg/ffprobe。此为源码完整性检查，不证明安装或运行。原 `docs/audits/test-files.json` 仅记录五个 Agent 非 PG 测试闭包，不能当这七文件+样例的完整索引；需要机器可读的全入口清单时应更新/新增，或在说明中标注其范围。
- `scripts/run-tests.mjs`/`run-example.mjs` 清除常见生产 provider、对象存储和 DB 环境变量，并预加载 `offline-guard.cjs` 拦截 `fetch`/HTTP/HTTPS/Socket/TLS/UDP。它是本次 Node 进程的防误连措施，不是正式安全沙箱。默认七测试没有真实 provider/DB 入口；`check-contract-samples.ts` 使用假应用与假 key，并校验 10 个合成协议案例和 3 项额外场景。`evidence/current/results.json` 的 80/80、strict 0、首次 1/1/1 与恢复 0/1/0 都标为 Windows 本地记录，且 `cleanInstallTested=false`、`macOSTested=false`、`providerCalls=0`。数值与 README/docs/04 一致，不能推论 Mac 已通过。
- 样例的蓝色 4 秒动作片和 440 Hz 音轨、橙色 PPM、绿色候选均由代码自造；候选不是供应商生成。`createRunningHubBackend` 使用假配置和注入 transport，collector 用假 DNS/下载和本地 create-only/readback，最后 FFmpeg 合成 720×1280 H.264/AAC。`--run <safe-name>` 新建独立目录，同名复用 journal、查询原假任务，不重新 submit；样例明确不提供生产并发锁/审批/真实上传。接收方需 PATH 上 FFmpeg/ffprobe，且 FFmpeg 构建支持 lavfi、libx264、mpeg4、AAC；无桌面、真实密钥或用户视频需求。
- `examples/generated/` 已有合成媒体；其中 `output.mp4`、`normalized-0.mp4`、`concat.txt` 文件名未带 `SIMULATED`。`docs/04` 称“全部以 SIMULATED 命名”不完全准确。建议把句子改为“输入、journal、receipt 与最终交付视频明确以 SIMULATED 标记；FFmpeg 临时中间文件也在该目录”，或在最终清单中逐一标明三项是模拟过程产物，防止被误当供应商 output。

结论：无桌面、无真实密钥的模拟路径在源码和入口上自洽，默认测试不触发 Windows PG helper；**尚不能宣称 macOS 干净安装或运行通过**。最终交付前最明确的文档/校验缺口是缺失的 `FILE-MANIFEST.json`，其次是确认 junction 物理排除并校正“全部 SIMULATED 命名”的描述。真实供应商节点映射、上传和出片证据仍未交付，不能以合成 MP4 或离线 80/80 代替。
