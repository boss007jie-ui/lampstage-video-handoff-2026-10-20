# AGENTS.md — Lampstage 仓库执行须知

本文件给所有自动化执行者（Codex / WorkBuddy / 其他 agent）读。**动手前先读完本文件。**

## 1. 坐标

| 项 | 值 |
|---|---|
| 工作根 | `C:\Users\boss0\Desktop\05-项目文件夹\网站制作\lamp-saas-mvp` |
| 应用根 | `apps/web/`（Next.js 14 App Router + TypeScript + Prisma/PostgreSQL） |
| 任务区 | `tasks/`（SPEC 规格，见 `tasks/README.md`） |
| 临时产物 | `.codex-tmp/`（PoC、preflight、报告一律放这里） |

## 2. 权威文档优先级

读到时冲突，按此顺序取值，**低优先级不得覆盖高优先级**：

1. `PROJECT_CARD.md` 顶部「当前产品定义」— 最新，定义当前产品
2. `HANDOFF.md` 顶部章节 — 次新
3. `DECISIONS.md` — 决策记录
4. `README.md`
5. 各文件标注为「历史快照 / 历史记录」的段落 — **仅追溯用，不代表现状**

`PROJECT_CARD.md` 与 `HANDOFF.md` 下半部分都是历史快照。不要用旧定位（"灯具场景图工具"）限制当前产品。

## 3. 工作流

```
Hermes/用户 写 SPEC  →  执行者读 SPEC 并执行  →  在 SPEC 末尾追加 `## 执行记录`  →  用户/Hermes 验收
```

- SPEC 状态标在文件首行：`[待执行]` / `[执行中]` / `[待验收]` / `[已完成]`。完成后改为 `[待验收]`，**不要自己标 `[已完成]`**。
- 执行记录必须包含：做了什么 / 改了哪些文件 / 验证结果 / 未做与限制 / 需要用户拍板的问题。
- SPEC 未明确授权的动作，不做。

## 4. 授权红线（最高优先级，违反即任务失败）

### 4.1 Hypit —— clean-room 边界

`vendor/hypit/**` 里的 `@hypit/*` 代码受**修改版 Apache-2.0** 约束，含多租户禁令，条款明确"无论是否收费"。

- **禁止**把 `vendor/hypit/node_modules/@hypit/**` 或 `vendor/hypit/packages/**` 的任何代码复制进新实现（含逐行改写、改名重写、摘取片段）。
- **禁止为"复刻 Hypit 功能"而阅读上述源码。** 需要实现同类能力时，只能依据：
  1. 替代方案的官方文档与仓库（如 HeyGen HyperFrames、RunningHub 官方 API）
  2. 我方自己的契约：`apps/web/lib/video/types.ts`
  3. 我方自己的调用代码：`apps/web/lib/video/*.ts`
- **允许**阅读：`apps/web/lib/video/**`（我方代码）、`vendor/hypit/README.md`（我方说明）。
- 若发现必须参考 Hypit 源码才能继续 —— **停下报告，不要为推进而破坏 clean-room 边界。**
- 在 SPEC 执行记录里**显式声明**本次是否触碰了 Hypit 源码（用于复刻目的），应为「否」。

背景与完整分析：`THIRD_PARTY_NOTICES.md` 第 2 节、`docs/knowledge/2026-10-16-video-route-evaluation.md` 第 3 节、`tasks/LAMP-C31.md` 第 0 节。

### 4.2 第三方组件

新增任何第三方依赖前，先查 `THIRD_PARTY_NOTICES.md`。新增依赖后按第 5 节模板追加条目（组件名 / 版本 / 授权 / 用途 / 义务）。**优先选 OSI 认证的宽松授权（MIT / Apache-2.0）**；遇到自定义协议先停下报告，不要自行判断可用。

## 5. 通用红线

- **不 commit、不 push、不部署。** 工作区长期存在大量未提交改动，`git status` 基线**必须原样保留**，不得污染。
- **不改 Prisma schema、不跑 migrate**，除非 SPEC 明确授权。
- **不动** `apps/web/prisma/`、`.git/`、`.vercel/`、`apps/web/.env.local`、生产部署设置、生产数据。
- **不读取、不打印、不复制任何密钥值**（含 `RUNNINGHUB_API_KEY_*` 等）。报告里只写「已配置 / 未配置」。
- **不为通过测试而改测试。** 既有断言失效时如实报告。
- **不产生真实费用的外部调用**，除非 SPEC 或用户明确批注授权。未授权时做到 dry-run 为止。
- 不删除、不覆盖他人未提交的工作。

## 6. 验证要求

改完代码至少跑：

```bash
cd apps/web
npm run typecheck                        # tsc --noEmit，必须 0 错误
npx tsx --test scripts/tests/<相关>.test.ts   # 相关单测
npm run video:test                       # 动了视频链路时
```

- 验证结果要贴**实际输出**，不要写"应该通过"。
- 没跑过的验证不得声称通过。区分「代码/离线验证通过」与「真实付费链路验收通过」——这是两个层次，不能互相替代。
- 既有测试数量若变化，说明原因。

## 7. 代码约定

- TypeScript 严格模式；标识符英文，**注释与文档用中文**。
- 改动保持最小增量，不做无关重构、不顺手改格式。
- 失败要**降级而非抛出**，并 `console.warn` 留痕（参考 `apps/web/lib/generation.ts` 的 `safeBrandBlock`）。
- 不把文件 IO 放进数据库事务里。

## 8. 品牌体系约束（图片链路）

`apps/web/lib/brand-kit.ts` 提供品牌档案注入。**关键约束**：

- 品牌档案里**不得出现 lamp 类词**（灯具/灯/light/lamp 等）。`prompt-planner.ts` 的自检要求 lamp 词在最终句中**恰好出现一次**；品牌段落混入 lamp 词会导致**整个镜头被拒**。`buildBrandPromptBlock` 会抛 `brand_kit_lamp_word_leak`。
- 品牌只治理**场景（SETTING）**，永不治理产品。
- 品牌未启用时必须与启用前**逐字节一致**（零行为变更）。

## 9. 不要做的事

- 不要凭 `PROJECT_CARD.md` 下半部分的历史快照判断当前产品定位。
- 不要把「已部署 / 接口返回 200」当作「功能已验收」。
- 不要用估算数字当实际账单。`ToolCallLog` 目前缺费用字段，所有成本数字都是估算。
- 不要把计划中的能力当作已上线能力。
- 不要为了推进任务而绕过本文件任何一条红线。做不到就停下报告。
