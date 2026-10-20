# 商品视频路线评估：生成式 H3 vs 模板合成

- 评估日期：2026-10-16
- 评估对象：`apps/web/lib/video/` 现有实现 + 本地 vendored 的 `@hypit/hypit` 能力
- 关联文档：`docs/knowledge/2026-10-16-opendesign-reuse-and-license.md`、`THIRD_PARTY_NOTICES.md`

---

## 0. 结论摘要

1. **两条路线不是替代关系，是分工关系。** 生成式负责"商品在真实场景中被使用"的氛围/演示画面；模板合成负责"卖点图文、参数对比、字幕、转场、多 SKU 轮播"这类信息型内容。后者便宜、可复现、可批量，前者贵、不可控、但做不出替代品。
2. **本地已经具备模板合成能力**，不需要从 OpenDesign 引入：`@hypit/hypit` 里就有 `hyperframes` / `render-hyperframes` / `provider-hyperframes-local` / `browser-capture`。
3. **⚠️ 但两条路线当前都被同一个授权问题阻断**：现有 H3 适配器和 HyperFrames 渲染器**都来自 `@hypit/hypit`**，而它的授权禁止多租户 / SaaS 用途。**这不是"新路线的风险"，是"现有视频功能的风险"。** 详见第 3 节。
4. **成本数据目前无法从系统里算出来**：`ToolCallLog` 缺实际费用、完整 usage、价格版本与稳定任务归属（见 `docs/deployment/2026-10-14-video-input-support-matrix.md` 第 6 节自述缺口）。任何成本结论都还是估算。

---

## 1. 现状：生成式 H3（sixref-v1）

### 1.1 能力事实（读代码得出，非推测）

| 项目 | 值 | 来源 |
|---|---|---|
| Provider | RunningHub AI App `2102538614549868545`，提交工作流 `2102537586127491074` | `apps/web/vendor/hypit/README.md` |
| 生成模式 | `legacy_frames` / `direct_references` / **`six_references`** | `lib/video/types.ts` |
| 工作流 profile | `sixref-v1` | `lib/video/six-reference-plan.ts` |
| 每段参考图 | 1–6 张，按用途排序 | 同上 |
| 参考图用途（role） | `product` / `character` / `scene` / `product_detail` / `start_state` / `end_state` | 同上 |
| 分段数 | 1–8 段 | 同上 |
| 每段时长 | 4 / 5 / 6 / 8 秒 | 同上 |
| 源片窗口 | `start + source_duration ≤ 30.12s`，变速不得超过 15% | 同上 |
| 输出规格 | 720 × 1280 @ 30fps（竖版 9:16） | 同上 |
| 账号并发 | 3 | 同上 |
| 人工采用 | `candidate_review_required: true` | 同上 |
| 合成 | ffmpeg（`assembleVideo`，180s 超时） | `lib/video/media.ts` |
| 运行形态 | 持久化 Worker + permit 账号池（`VideoWorker` / `VideoPermitAccount` / `VideoPermit`） | `prisma/schema.prisma` |
| 状态机 | draft → queued → preparing → **review** → generating → assembling → completed，另有 failed / attention / cancelled | `lib/video/types.ts` |

### 1.2 这套设计的含义

- **是"参考视频复刻"，不是"文生视频"。** 必须给一段源片，系统按语义窗口把源片动作切成 1–8 段，逐段用参考图重新生成，再用 ffmpeg 拼回一条完整视频。适合"把别人的爆款视频换成我们的商品"。
- **强制人工采用**（`review` 状态）。这是成本结构里最重的一环：候选要人看，丢弃即重跑，**重跑成本直接叠加**。
- **成品长度受限**：单段最长 8 秒，源片窗口 ≤ 30.12 秒。所以一条 30 秒成片 ≈ 6 段 × 5 秒，也就是 **6 次生成调用**。

---

## 2. 第二条路线：模板合成（本地已具备）

### 2.1 事实

`apps/web/vendor/hypit/node_modules/@hypit/hypit`（v0.2.17）不只是 H3 适配器，它是一整套 **Hypit 视频创作框架**，相关包：

| 包 | 作用 |
|---|---|
| `hyperframes` / `render-hyperframes` | HTML 是视频唯一真源：HTML + `data-*` 时间轴属性 + GSAP + CSS → **确定性 MP4** |
| `provider-hyperframes-local` | 本地渲染 provider（`renderBrowser`） |
| `browser-capture` | 无头浏览器逐帧捕获（依赖 puppeteer-core） |
| `caption` / `caption-fine` / `typography-track` | 字幕与排版轨 |
| `sound` / `speech` / `elevenlabs-speech` / `fishaudio-speech` / `whisperx` | 音频、TTS、语音对齐 |
| `image-compose` / `background-removal` / `volcengine-matting` | 图像合成与抠图 |
| `nano-banana` / `gpt-image` / `seedream` | 生图 provider |
| `minimax-h3` / `seedance` / `wan` / `pixverse` / `grok-imagine` | 生成式视频 provider |
| `estimate` / `validation` / `artifact` | 成本估算、校验、产物管理 |

也就是说：**模板合成所需的能力（HTML 渲染 + 字幕 + 音频 + ffmpeg 编码）你本地全都有，而且已经装好了。**

### 2.2 与 OpenDesign 的 HyperFrames 是同一思路

OpenDesign 的 `design-templates/hyperframes/`（Apache-2.0）描述的是同一件事：HTML + GSAP → 确定性 MP4，支持字幕对齐、TTS 旁白、音频响应动画、场景转场。它甚至明确写了"不要从零写 HTML，用确定性脚手架只改 prompt 实际改动的部分"。

**两者的差别只在授权**：OpenDesign 那份是 Apache-2.0，可以自由用；你本地这份是 Hypit 修改版授权，多租户受限。

---

## 3. ⚠️ 前置阻断：授权

**现有 H3 适配器本身就来自 Hypit。** `apps/web/vendor/hypit/README.md` 原文：

> This directory contains only the generic RunningHub three-image + one-video adapter. **The unchanged source was copied from the user's existing Hypit provider package.**

而 `@hypit/hypit` 的授权第 1(a) 条禁止在多租户环境下使用，第 1(b) 条禁止商业再分发。Lampstage 是按商家隔离 workspace 的多租户 SaaS（`User` / `ApiKey` / `Session` / `CreditTransaction` / `RechargeOrder`），条款还明确写了 **"whether or not a fee is charged"**。

完整条款与建议动作见 `THIRD_PARTY_NOTICES.md` 第 2 节。

**对本次评估的影响**：路线选择是次要问题，授权是主要问题。在取得 Hypit.AI 书面授权之前，讨论"哪条路线更便宜"意义有限——两条路都在同一个授权范围内。

### 3.1 后续核实（同日追加）：复刻 Hypit 不解决问题

用户提出"授权谈不下来，能否照 GitHub 开源资料复刻一个"。已核实——**不能**：

| 项 | 实测值 |
|---|---|
| GitHub 仓库 | `hypit-ai/hypit`，22,740 star，创建 2026-07-29 |
| GitHub 标记授权 | `NOASSERTION` / "Other" —— 非标准 OSI 协议 |
| LICENSE 原文 | 已拉取核对，与本地 `vendor/hypit` 那份**逐字一致**（修改版 Apache-2.0 + 多租户禁令） |

授权第 1(b) 条原文：

> Forking, modifying, and publishing the source code of Hypit or a derivative work is permitted, **provided the result is made available under the terms of this same license** and is not supplied for commercial gain.

所以：允许 fork/修改/发布，但**衍生作品必须以同一授权发布**，多租户禁令（1(a)）原样继承；且**不得为商业获利而提供**，Lampstage 是收费 SaaS，正落此条。

更关键的是：**照源码改写属"衍生作品"，不是独立实现**。1(b) 那句 "or a derivative work of it" 正是覆盖这种情况。clean-room 重写的前提（实现者从未读过源码）在你们这里已不成立——`vendor/hypit/README.md` 自述该目录就是从 Hypit provider 包复制来的。

### 3.2 正确解法：换地基，而不是复刻

用户真正要的是"商品视频合成能力"，不是"Hypit 这个软件"。Hypit 在链路里只占两件事，各有干净替代：

| 链路环节 | Hypit 提供的部分 | 干净替代 | 授权 |
|---|---|---|---|
| 生成式出片 | `@hypit/minimax-h3` + `hypit.mjs` CLI 编排 | **直连 RunningHub 官方 API**（AI 应用 API）。RunningHub 是你们自己的账号，与 Hypit 无关 | RunningHub 服务条款 |
| 合成 / 拼装 | `@hypit/hyperframes` / `render-hyperframes` / `provider-hyperframes-local` | **HeyGen HyperFrames** | **Apache-2.0**（GitHub API 确认，64,908 star） |

**HyperFrames 已核实**：`heygen-com/hyperframes`，"Write HTML. Render video. Built for agents."，Apache-2.0，OSI 认证，**无商用限制、无渲染收费**。技术栈与 Hypit 同构——Puppeteer 无头 Chrome 逐帧 seek + FFmpeg 编码，`data-start`/`data-duration`/`data-track-index` 描述时间轴，GSAP / Lottie / CSS / Three.js / WAAPI 均可。要求 Node ≥22 + FFmpeg，**你们两样都有**。另有 `frame.md` 概念（为"镜头"设计的品牌规范），与刚落地的 brand-kit 同思路，未来可对接。

**RunningHub 直连已核实可行**：官方文档 `runninghub.cn/runninghub-api-doc-cn` 提供模型 API / AI 应用 API / 工作流 API 三类，均为"提交返回 taskId → 轮询结果"。现有 AI App `2102538614549868545` 属 AI 应用 API 范畴。

**结构上的好消息**：`lib/video/hypit-runner.ts` 并不 `import` Hypit 作为库，而是用 `execFile` 拉起 `hypit.mjs` CLI 并生成 SVML markup 文件。边界是"CLI + markup DSL"，**比深度库耦合薄得多**，隔离与替换可行性较高。

已立项 `tasks/LAMP-C31.md`（依赖隔离 + HyperFrames / RunningHub 直连 PoC），**不替换、不删 vendor、不动生产**，先验证再拍板。

### 3.3 能力边界提醒

HyperFrames 是**模板合成**，**做不出生成式的"商品在真实场景中被使用"画面**。它与 H3 生成式是**分工关系，不是替代关系**（见第 5 节）。换地基解决的是"合成层"的授权，**生成层要靠 RunningHub 直连解决**。两部分都要动，缺一不可。

---

## 4. 成本结构对比

### 4.1 生成式 H3

**成本公式**

```
单条成本 = 输出秒数 × 每秒单价 × (1 + 重试率)
```

- **输出秒数** = Σ 各段时长。30 秒成片 ≈ 6 段 × 5 秒 = 30 秒
- **每秒单价**：公开报道 H3 RH Enhanced 为 **0.1 元/秒**（智源社区 2026-09-30 报道，`hub.baai.ac.cn/view/58377`）。⚠️ 这是媒体口径，**必须按 RunningHub 账号实际结算核实**，且可能随会员等级和促销变动
- **重试率**：因为 `candidate_review_required: true`，每段要人工采用，丢弃候选即重跑。这是最大的不确定项

**试算（30 秒成片）**

| 场景 | 输出秒数 | 单价 | 重试率 | 单条成本 |
|---|---:|---:|---:|---:|
| 理想（一次通过） | 30 | 0.1 元/秒 | 0% | **3.0 元** |
| 一般（每段丢一次） | 30 | 0.1 元/秒 | 100% | **6.0 元** |
| 较差（部分段丢两次） | 30 | 0.1 元/秒 | 150% | **7.5 元** |

**另外两项隐性成本**：
- **人工审片工时**：`review` 状态是强制的。6 段 × 每段人工判断，这部分工时没有计入上表
- **源片获取**：sixref 必须给源片。如果没有可用的源片（版权、找不到合适的），这条路走不通

### 4.2 模板合成

**成本公式**

```
单条成本 = 渲染机时成本 + 存储/带宽
```

- **渲染机时**：无头浏览器逐帧捕获 + ffmpeg 编码。一条 30 秒 720×1280@30fps 视频 = 900 帧
- 按云主机 0.5 元/小时粗估，单条渲染若耗 60 秒 CPU → 约 **0.008 元**。**基本可忽略**
- **没有按次计费**，同一份 HTML 渲染 N 次成本几乎不变（这是"确定性"带来的直接好处）
- **真实成本是自研投入**：写渲染管线（HTML → 帧 → MP4）、模板库、参数化（把商品图/文案/配色注入模板）

**关键限制**：模板合成**做不出"商品在真实房间里被使用"的画面**。它只能做图文、动效、字幕、转场。这是能力边界，不是成本问题。

### 4.3 成本结论

- **量级差 2–3 个数量级**：生成式约 3–7.5 元/条，模板合成约 0.01 元/条（不含自研投入）
- **但两者不重叠**：便宜的做不了贵的能做的
- **正确策略是分工**，而不是二选一

---

## 5. 四维对比

| 维度 | 生成式 H3（sixref） | 模板合成（HTML→MP4） |
|---|---|---|
| **单条成本** | 3–7.5 元（30 秒，含重试） | ≈ 0.01 元（不含自研投入） |
| **成本可预测性** | 差。重试率不可控，人工采用结果不确定 | 好。同一份 HTML 成本恒定 |
| **可控性** | 低。每次生成结果不同，商品保真度不稳定（`DECISIONS.md` 明确"不承诺商品保真成功率"） | 高。画面完全由模板决定，商品图就是原图 |
| **交付速度** | 慢。分段生成 + 人工采用 + 合成，且账号并发只有 3 | 快。纯本地渲染，可并发，无人工环节 |
| **内容类型** | 商品使用演示、动作复刻、氛围片 | 卖点图文、参数对比、多 SKU 轮播、字幕、品牌片头片尾、转场 |
| **输入要求** | 必须有源片 + 1–6 张参考图 | 只需要商品图 + 文案 + 品牌档案 |
| **输出规格** | 固定 720×1280@30fps 竖版 | 任意尺寸，任意时长 |
| **单条时长上限** | 单段 8 秒，源片窗口 ≤ 30.12 秒 | 无硬上限 |
| **可复现性** | 不可复现 | 完全可复现（同 HTML 同输出） |
| **授权** | ⚠️ Hypit 修改版 Apache-2.0，多租户受限 | 同上（本地这份）；OpenDesign 那份是 Apache-2.0 |

---

## 6. 建议

### 6.1 顺序

1. **先解决授权**（`THIRD_PARTY_NOTICES.md` 第 2 节）。这一步不完成，下面都是空谈。
2. **授权解决后**，按内容类型分工，不要用一条路线打所有需求。
3. **补齐成本采集**，否则永远只能估算。

### 6.2 如果授权谈不下来：换地基（推荐，已立项 LAMP-C31）

**不用从零自研。** 你要的那层能力有现成的 Apache-2.0 实现：**HeyGen HyperFrames**（`heygen-com/hyperframes`，64,908 star，GitHub API 确认 `Apache-2.0`）。它就是"Puppeteer 无头 Chrome 逐帧 seek + FFmpeg 编码"，无商用限制、无渲染收费。

拆开看，Hypit 在链路里只占两件事，各有干净替代：

| 链路环节 | Hypit 提供 | 干净替代 |
|---|---|---|
| 生成式出片 | `@hypit/minimax-h3` + `hypit.mjs` 编排 | 直连 RunningHub 官方 AI 应用 API（自有账号） |
| 合成 / 拼装 | `@hypit/hyperframes` 等 | HeyGen HyperFrames（Apache-2.0） |

你已有的可用件（降低切换成本）：

| 需要的能力 | 现有可用件 |
|---|---|
| 无头浏览器 | `puppeteer`（`browser-capture` 用的就是 puppeteer-core） |
| 帧编码 / 拼接 / 音频合成 | ffmpeg（`lib/video/media.ts` 已在用 `VIDEO_FFMPEG_PATH`） |
| 字幕 / TTS | 可自接（火山、MiniMax、ElevenLabs 均有独立 API） |
| 模板管理 | 参照 `VideoTemplate` / `VideoTemplateVersion` 现有设计 |
| 品牌规范 | HyperFrames 的 `frame.md` ↔ 刚落地的 brand-kit |

**结构上的好消息**：`lib/video/hypit-runner.ts` 不 `import` Hypit 作为库，而是 `execFile` 拉起 CLI + 生成 SVML markup。边界是"CLI + markup DSL"，**比深度库耦合薄得多**，隔离可行性较高。

**已立项 `tasks/LAMP-C31.md`**：依赖隔离 + 两条 PoC + 工作量评估，**不替换、不删 vendor、不动生产**。

**唯一硬约束（红线 A）**：新实现**禁止复制或参考 `@hypit/**` 源码**。照源码改写属衍生作品，限制照样跟着——这正是"复刻"路线失败的原因（见 §3.1）。

### 6.3 不要做的事

- **不要"复刻 Hypit"** —— 已核实无效。GitHub 上 `hypit-ai/hypit` 是同一份受限授权（`NOASSERTION`），1(b) 条要求衍生作品以同一授权发布且不得为商业获利提供；照源码改写属衍生作品，多租户禁令原样继承。详见 §3.1。
- **不要**把 `@hypit/render-hyperframes` 当成自研基础——它同样是 Hypit 的包，改个名字不改变授权性质。
- **不要**在没有书面授权的情况下把视频功能开放给我方组织之外的商家，包括免费内测（条款明确"whether or not a fee is charged"）。
- **不要**移除 Hypit CLI / 运行报告 / manifest 里的名称与 LOGO（1(c) 条）。
- **不要**指望 HyperFrames 替代生成式出片——它做不出"商品在真实场景中被使用"的画面，两者是分工（见 §3.3）。

---

## 7. 成本数据缺口（需要先补）

`docs/deployment/2026-10-14-video-input-support-matrix.md` 第 6 节已自述，`ToolCallLog` 当前缺：

- 实际费用（只有调用记录，没有金额）
- 完整 usage
- 价格版本（单价变了之后无法回溯历史成本）
- 稳定任务归属（无法把一次生成可靠地归到某个 job）

**这三项不补，上表的"重试率"永远只能靠人工统计。** 建议优先级：价格版本 > 任务归属 > 完整 usage。

---

## 8. 待核实项

| 项 | 为什么待核实 | 怎么核实 |
|---|---|---|
| H3 实际单价 | 0.1 元/秒是媒体口径 | 查 RunningHub 账号后台实际结算单 |
| 实际重试率 | 决定成本的关键变量 | 需要先补成本采集，或人工统计历史 `review` 记录 |
| 人工审片工时 | 未计入成本 | 产品侧统计 |
| Hypit 多租户授权 | 阻断项 | 联系 Hypit.AI 取得书面答复 |
| 模板合成的真实自研工时 | 决定值不值得自研 | 需要一次技术方案评审 |

---

## 9. 复核方式

本文所有代码事实都可用以下命令复现（在 `apps/web` 目录下）：

```bash
# sixref 能力矩阵
grep -A3 "SIX_REFERENCE_CAPABILITY" lib/video/six-reference-plan.ts

# 分段与时长约束
grep -n "segment_plan\|segment_durations\|30.12" lib/video/six-reference-plan.ts

# H3 provider 来源与账号
cat vendor/hypit/README.md

# 本地已具备的模板合成能力
ls vendor/hypit/node_modules/@hypit/hypit/packages | tr '\n' ' '

# Hypit 授权
cat vendor/hypit/node_modules/@hypit/hypit/LICENSE
```
