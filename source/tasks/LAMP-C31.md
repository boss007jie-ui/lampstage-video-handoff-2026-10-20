[待执行]

# LAMP-C31 — 视频链路去 Hypit 化：依赖隔离 + HyperFrames / RunningHub 直连 PoC（不替换、不动生产）

工作根: `C:\Users\boss0\Desktop\05-项目文件夹\网站制作\lamp-saas-mvp`
应用根: `apps/web/`

> 本 SPEC 由 WorkBuddy 撰写（2026-10-16），发布给 Codex 执行。
> 上一编号为 LAMP-C30。**先读 §0，它改变了任务的性质。**

---

## 0. 结论先行：**"复刻 Hypit" 解决不了授权问题，不要按复刻做**

用户原话是"Hypit 授权没法谈，能不能根据它 GitHub 的开源资料复刻一个"。**答案是不能**，理由是实证的，不是推测：

### 0.1 GitHub 上的 Hypit 就是同一个受限授权

| 项 | 实测值 |
|---|---|
| 仓库 | `hypit-ai/hypit`（GitHub API 读取） |
| Star | 22,740 |
| 创建时间 | 2026-07-29 |
| 描述 | "Clone any viral video with AI agents…" |
| **GitHub 标记的授权** | **`NOASSERTION` / "Other"** —— 即非标准 OSI 协议，GitHub 无法归类 |
| LICENSE 原文 | 已拉取 `raw.githubusercontent.com/hypit-ai/hypit/main/LICENSE` 核对，**与本地 `vendor/hypit` 里那份逐字一致**：修改版 Apache-2.0 + 多租户禁令 |

### 0.2 该授权对"复刻"的直接规定（原文引用）

第 1(b) 条：

> **Forking, modifying, and publishing the source code of Hypit or a derivative work is permitted, provided the result is made available under the terms of this same license and is not supplied for commercial gain.**

拆开看：

- fork / 修改 / 发布 —— **允许**
- 但**结果必须以同一授权发布** —— 所以复刻品照样带着第 1(a) 条的多租户禁令
- 且**不得为商业获利而提供** —— Lampstage 是收费 SaaS，正落在这一条里

第 1(a) 条的多租户禁令在复刻品上**原样生效**，不会因为"自己重写了一遍"而消失。

### 0.3 更关键：读着源码"复刻"在法律上就是衍生作品

如果 Codex 打开 `vendor/hypit/node_modules/@hypit/**` 或 `vendor/hypit/packages/**`，照着它的实现写一份"自己的"版本——那是**衍生作品（derivative work）**，不是独立实现。第 1(b) 条那句 "or a derivative work of it" 就是专门覆盖这种情况的。

真正干净的 clean-room 重写需要"从没读过源码的人，只依据公开行为规格实现"。这个前提在你们这里**已经不成立**——`vendor/hypit/README.md` 自述该目录就是从 Hypit provider 包复制来的，团队已经读过了。

**所以：复刻这条路，无论技术上做得多干净，法律上都不解决用户想解决的问题。**

### 0.4 正确解法：不需要复刻，换地基

用户真正要的是"商品视频合成能力"，不是"Hypit 这个具体软件"。拆开看，Hypit 在这条链路里只占两件事：

| 链路环节 | Hypit 提供的部分 | 干净替代 |
|---|---|---|
| **生成式出片** | `@hypit/minimax-h3` 适配器 + `hypit.mjs` CLI 编排 | **直连 RunningHub 官方 API**（AI 应用 API）。RunningHub 是你们自己的账号，与 Hypit 无关 |
| **合成 / 拼装** | `@hypit/hyperframes` / `render-hyperframes` / `provider-hyperframes-local` | **HeyGen HyperFrames**（Apache-2.0，OSI 认证，明确无商用限制、无渲染收费） |

**HyperFrames 已核实**（GitHub API）：`heygen-com/hyperframes`，授权 `Apache-2.0`，star 64,908，描述 "Write HTML. Render video. Built for agents."。
技术栈与 Hypit 同构：**Puppeteer 无头 Chrome 逐帧 seek + FFmpeg 编码**，用 `data-start` / `data-duration` / `data-track-index` 描述时间轴，GSAP / Lottie / CSS / Three.js / WAAPI 均可（Frame Adapter 模式）。要求 Node ≥22 + FFmpeg —— **你们两样都有**。

附带好处：HyperFrames 有 `frame.md` 概念——**为"镜头"设计的品牌规范**，与 LAMP-C30 刚落地的 brand-kit 是同一思路，未来可直接对接。

**RunningHub 直连已核实可行**：官方文档 `runninghub.cn/runninghub-api-doc-cn` 提供三类 API——模型 API / **AI 应用 API** / 工作流 API，均为"提交任务返回 taskId → 轮询结果"。你们已有的 AI App `2102538614549868545` 正属于 AI 应用 API 范畴。

### 0.5 本 SPEC 因此不是"复刻 Hypit"

本 SPEC 要做的是**去 Hypit 化（de-Hypit-ification）**：把 Hypit 依赖**隔离**出来、用**授权干净**的技术验证替代路径、评估切换工作量。

**本 SPEC 不替换、不删除、不改生产。** 现有视频功能继续跑在 Hypit 上，直到替代路径被验证并且用户拍板切换。

---

## 背景

`THIRD_PARTY_NOTICES.md` 第 2 节记录了 `@hypit/hypit` 的授权问题：多租户禁令与 Lampstage 的按商家隔离 workspace 冲突，且条款明确"无论是否收费"。

已实测的依赖面（`grep -rln "hypit"` 排除 `node_modules` / `.next` / `.codex-tmp` / 运行时产物后）：

| 类别 | 文件 |
|---|---|
| 核心适配器 | `apps/web/lib/video/hypit-runner.ts` |
| 处理器 | `apps/web/lib/video/processor.ts`、`lib/video/sixref-processor.ts` |
| 路由 | `apps/web/app/api/v1/video-jobs/[id]/render/route.ts` |
| Worker / 脚本 | `apps/web/scripts/video-worker.ts`、`scripts/local-profile.ts`、`scripts/video-input-dryrun.ts` |
| 测试 | `apps/web/scripts/tests/video-controls.test.ts`、`video-sixref-processor.test.ts` |
| 依赖声明 | `apps/web/package.json` |
| vendored 源码 | `apps/web/vendor/hypit/**`（含 `hypit-provider-runninghub-sixref`、`hypit-provider-runninghub-product-v6`） |

**关键结构事实**：`lib/video/hypit-runner.ts` 并不 `import` Hypit 作为库，而是：

1. 用 `execFile` 拉起 `hypit.mjs` CLI（路径由 `VIDEO_HYPIT_CLI` 覆盖，否则探测全局 npm 安装路径）；
2. 生成 **SVML markup** 文件（`@hypit/markup@1` / `@hypit/media@1` / `@hypit/text@1` / `@hypit/minimax-h3@1` / `@hypit/run-markup@1`）；
3. 交给 CLI 执行，读回 JSON。

**这意味着边界比想象中薄**：是"CLI + markup DSL"边界，不是深度库耦合。隔离与替换的可行性因此较高。

---

## 任务

### 1. Preflight（只读盘点，不改任何文件）

1. `git status --short` 记录基线。工作区有大量未提交改动，**必须原样保留**。
2. 精确列出 Hypit 使用点：每个文件引用 Hypit 的**具体行号与用途**，区分"真在用"与"仅注释/字符串提及"。
3. 列出 `hypit-runner.ts` 实际调用的 CLI 子命令与参数全集（从**我方代码**读，不要读 Hypit 源码）。
4. 列出 `vendor/hypit/**` 里哪些是**我方自写**的 provider（`hypit-provider-runninghub-sixref` 等），哪些是 Hypit 原版分发。
5. 环境确认：`node --version`（需 ≥22）、`ffmpeg -version`、`VIDEO_FFMPEG_PATH` 是否设置。
6. 产物写到 `.codex-tmp/video-dehypit-20261016/preflight.json`。

### 2. 依赖隔离（**本 SPEC 的强制交付物**）

目标：把 Hypit 依赖收拢到**一层薄适配器**后面，使其余代码不再直接知道 Hypit 的存在。**不改变任何现有行为。**

- 定义一个我方拥有的接口（例如 `VideoRenderBackend`），把"提交生成任务 / 查询状态 / 取回产物"抽象出来。
- 现有 Hypit 路径实现为其中一个 backend（行为逐字节不变）。
- 让 `processor.ts` / `sixref-processor.ts` / worker 依赖接口，而不是直接依赖 `hypit-runner.ts` 的 Hypit 细节。
- **验收标准**：切换 backend 只需改一处配置；现有视频测试全部与改动前一致。

**若发现隔离成本远超预期（例如 SVML 语义渗漏到上层多处），停下报告，不要硬做。** 隔离方案本身的价值评估比完成它更重要。

### 3. HyperFrames PoC（合成路径，授权干净）

在 `.codex-tmp/video-dehypit-20261016/hyperframes-poc/` 下做，**不进入 `apps/web` 的产品代码**。

1. 按官方文档安装：`npx hyperframes init`，或按仓库 README（`github.com/heygen-com/hyperframes`）操作。
2. 做一个最小合成：一张商品图 + 一段文案 + 一个 GSAP 入场动画 + 一个转场，`data-start` / `data-duration` 控制时间轴。
3. 渲染出 MP4，记录：实际命令、渲染耗时、输出分辨率/帧率/体积、CPU 占用。
4. 验证**确定性**：同一份 HTML 渲染两次，比对产物 sha256。
5. 记录 HyperFrames 版本号与依赖树里是否有非 Apache-2.0 的传递依赖（`npm ls --all` 扫一遍，重点看 license 字段）。

**报告要回答**：HyperFrames 能不能替代 `@hypit/hyperframes` 那一层？渲染耗时对 720×1280@30fps 的 30 秒成片大概什么量级？

### 4. RunningHub 直连 PoC（生成路径，绕开 Hypit CLI）

在 `.codex-tmp/video-dehypit-20261016/runninghub-poc/` 下做。

1. 读官方文档 `runninghub.cn/runninghub-api-doc-cn`，确认 **AI 应用 API** 的提交与轮询接口形态。
2. 用现有 AI App `2102538614549868545`（提交工作流 `2102537586127491074`）做一次**最小真实调用**：单张参考图 + 最短时长，拿回一个视频产物。
3. 记录：端点、请求体结构、轮询间隔与超时、返回字段、实际耗时、**本次调用产生的费用**。
4. 对比现有 Hypit 路径：同样的输入，Hypit 链路与直连链路的产物差异（分辨率、时长、画质）。
5. **凭据纪律**：`RUNNINGHUB_API_KEY_01` 只从环境变量读，**不得写入任何文件、日志、报告或 git**。报告里只写"已配置/未配置"。

**这一步会产生真实费用**，属于付费调用。若用户未在本 SPEC 上批注授权，**只做到"确认接口形态 + dry-run"为止**，把真实调用留到用户确认后。

### 5. 切换方案与工作量评估（交用户拍板，不要自行实施）

产出 `.codex-tmp/video-dehypit-20261016/migration-assessment.md`，包含：

- 隔离后的 backend 接口定义（代码片段）
- HyperFrames backend 与 RunningHub 直连 backend 的实现要点
- **工作量评估**：分几步、每步改哪些文件、每步怎么验收
- **风险清单**：能力差异（HyperFrames 是模板合成，**做不出生成式的"商品在真实场景中被使用"画面**，两者是分工不是替代）、渲染资源需求、并发与队列、回退方式
- **成本对比**：直连 RunningHub 的价格 vs 经 Hypit 的现状
- **明确列出"哪些能力会丢"** —— 这是用户拍板最需要的信息

---

## 红线

### 红线 A：授权纪律（**最重要，违反即任务失败**）

- **禁止把 `vendor/hypit/node_modules/@hypit/**` 或 `vendor/hypit/packages/**` 下的任何代码复制进新实现。** 包括逐行改写、改名重写、摘取片段。
- **禁止为"复刻 Hypit 功能"而阅读上述 Hypit 源码。** 新实现只能依据：① HyperFrames 官方文档与仓库 ② RunningHub 官方 API 文档 ③ 我方自己的 `lib/video/types.ts` 契约 ④ 我方自己的 `lib/video/*.ts` 调用代码。
- 允许阅读：`lib/video/**`（我方代码）、`vendor/hypit/README.md`（我方说明文档）、`lib/video/types.ts`。
- 若发现必须参考 Hypit 源码才能继续，**停下报告**，不要为了推进而破坏 clean-room 边界。

### 红线 B：不改动范围

- **不替换、不删除 `vendor/hypit/`，不改生产视频链路的行为。** 本 SPEC 只做隔离 + PoC + 评估。
- **不改 Prisma schema，不跑迁移。**
- **不动 `apps/web/prisma/`、`.git/`、`.vercel/`、`apps/web/.env.local`、生产部署设置、生产数据。**
- **不 commit / push / 部署。** `git status` 必须保持基线不被污染。
- PoC 产物一律放 `.codex-tmp/` 下，**不得进入 `apps/web` 产品代码树**。
- **不读取、打印、复制任何密钥值。**
- 未经用户批注，**不做会产生真实费用的 RunningHub 调用**（§4 第 5 点）。
- 不为通过测试而改测试。既有测试断言失效时如实报告。

---

## 完成后回报

在本 SPEC 末尾追加 `## 执行记录`：

1. Preflight 盘点结果（Hypit 使用点清单 + 环境确认）。
2. 隔离方案：接口定义、改了哪些文件、**现有视频测试是否逐项一致**。
3. HyperFrames PoC：命令、耗时、产物规格、确定性 sha256 比对、依赖授权扫描结果。
4. RunningHub PoC：接口形态确认结果；真实调用做了还是停在 dry-run，为什么。
5. 工作量评估与风险清单（含"哪些能力会丢"）。
6. **明确声明**：本次是否触碰了 Hypit 源码（用于复刻目的）——应为"否"。这是红线 A 的自证。
7. 未做与限制：未替换、未删除 vendor、未迁移、未 commit、未部署。
8. 需要用户拍板的问题清单。
9. 状态改为 `[待验收]`。

---

## 附：与 LAMP-C30 的关系

两条 SPEC **完全独立**，可并行：C30 是图片品牌体系接 API/MCP，C31 是视频链路去 Hypit 化，文件与模块不重叠。

若只能先做一条，**C31 优先级更高** —— 它对应的是正在生效的法律风险，而 C30 是能力增强。

`docs/knowledge/2026-10-16-video-route-evaluation.md` 第 3 节记录了该授权风险的完整分析。
