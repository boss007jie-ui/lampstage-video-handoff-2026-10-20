# 第三方组件与授权声明 (THIRD PARTY NOTICES)

本文件登记 Lampstage（`lamp-saas-mvp`）引用、参考或依赖的第三方作品及其授权条款。
**每引入一个第三方模块，都要在这里追加一条。**

维护规则：

1. 只要**复制或修改了第三方源码**，必须登记，并在被修改的文件头部写明"本文件已修改"及改动内容。
2. 只**参考思路、独立实现**的，也要登记，但注明"仅参考，无代码复制"。
3. 必须保留第三方原始 `LICENSE` 全文（随分发物提供），不能只写在这里。
4. 有特殊限制条款（多租户、商用、商标）的，**必须在"限制"一栏写清楚**，不要只写授权名称。

---

## 1. OpenDesign

| 项目 | 内容 |
|---|---|
| 作品 | OpenDesign — Collaborative AI Design Agent Workspace |
| 来源 | https://github.com/nexu-io/open-design |
| 版权 | © OpenDesign contributors / nexu-io |
| 授权 | Apache License 2.0（仓库根 `LICENSE`，无 NOTICE 文件） |
| 我们如何使用 | **仅参考思路，无代码复制。** 参考其 `design-systems/` 平面的"以一份 DESIGN.md 为中心、可版本化、可校验的品牌包"设计，独立实现了 `apps/web/lib/brand-kit.ts` |
| 限制 | Apache-2.0 第 6 条不授予商标权：不得使用 "OpenDesign" 名称或 Logo，不得暗示官方背书 |

**引用位置**

| 文件 | 关系 |
|---|---|
| `apps/web/lib/brand-kit.ts` | 独立实现；文件头注明灵感来源 |
| `apps/web/brand-kits/*.md` | 自建内容，未复制其 `design-systems/` 任何文件 |
| `docs/knowledge/2026-10-16-opendesign-reuse-and-license.md` | 盘点与合规记录 |

**子目录授权提示**：该仓库另有 103 个独立 LICENSE 文件（100 个 MIT、3 个 Apache-2.0），分布在 `skills/<name>/`、`design-templates/<name>/`、`plugins/` 下。目前**我们未复制其中任何文件**。若将来复制，需逐个按各自授权履行署名义务（MIT 同样要求保留版权声明），并在此文件追加条目。

---

## 2. Hypit (`@hypit/hypit`)

| 项目 | 内容 |
|---|---|
| 作品 | Hypit — Hypit video authoring Distribution for AI agents |
| 版本 | 0.2.17 |
| 来源 | https://hypit.ai · https://github.com/hypit-ai/hypit |
| 版权 | © 2026 Hypit.AI |
| 授权 | **Hypit 修改版 Apache License 2.0**（"SEE LICENSE IN LICENSE"） |
| 我们如何使用 | 作为商品视频生成/渲染后端；本地 vendored 于 `apps/web/vendor/hypit`（含 `@hypit/hypit` 及其 `packages/` 全量源码） |
| 原始 LICENSE 位置 | `apps/web/vendor/hypit/node_modules/@hypit/hypit/LICENSE` |

### ⚠️ 限制条款（必须逐条遵守）

**1(a) 多租户服务 — 未获书面授权前不得用于多租户**

> 未经 Hypit.AI 书面明确授权，不得使用 Hypit 源码或其衍生作品运营多租户环境，也不得将 Hypit 的功能以托管、管理或 SaaS 形式提供给第三方。
>
> 租户定义：一个租户 = 一个 workspace。**只要有两个及以上我方组织之外的当事方各自持有独立 workspace，即构成多租户服务，无论是否收费。**

**影响**：Lampstage 的 `User` / `ApiKey` / `Session` / `CreditTransaction` / `RechargeOrder` 构成按商家隔离的 workspace，符合上述多租户定义；且条款明确"无论是否收费"，因此"内测不收费"不构成豁免。**在取得 Hypit.AI 书面授权前，视频功能不得向我方组织之外的商家开放。**

**1(b) 商业再分发**

> 未经书面授权，不得为商业获利而销售、收费许可或以其他方式提供 Hypit 或其衍生作品（无论独立提供，还是作为第三方产品的组件/捆绑件）。允许自行 fork、修改、发布源码，前提是结果以同一授权发布且不为商业获利而提供。

**1(c) LOGO 与版权信息**

> 不得移除或修改 Hypit 命令行界面、其生成的运行报告与 manifest、以及任何由此派生的用户可见界面中的名称、LOGO 或版权信息。

**3. 产出归属（对我方有利）**

> Hypit 不主张对用户产出内容的任何权利。通过 Hypit 生成的视频、音频、图像、manifest 等产出归用户所有，本授权不附加任何使用条件，包括商用。

### 待办

- [ ] **不要试图"复刻"Hypit 来规避授权** —— 已核实无效。GitHub 上的 `hypit-ai/hypit`（22,740 star，2026-07-29 创建）授权为同一份文本，GitHub API 标记为 `NOASSERTION`（非标准 OSI 协议）。该授权第 1(b) 条允许 fork/修改/发布，但要求**衍生作品必须以同一授权发布**且**不得为商业获利而提供** —— 因此复刻品照样受第 1(a) 条多租户禁令约束。且照源码改写属"衍生作品"，不是独立实现。
- [ ] 向 Hypit.AI 取得书面授权/商业许可，明确多租户 SaaS 场景是否被覆盖
- [ ] 确认对外界面未移除 Hypit 名称 / LOGO / 版权信息
- [ ] **走换地基路线**：已立项 `tasks/LAMP-C31.md`。Hypit 在这条链路里只占两件事，各自有干净替代：
      - 生成式出片 → 直连 RunningHub 官方 API（自有账号，与 Hypit 无关）
      - 合成/拼装 → **HeyGen HyperFrames**（`heygen-com/hyperframes`，Apache-2.0，OSI 认证，无商用限制、无渲染收费；Puppeteer 无头 Chrome 逐帧 seek + FFmpeg）
- [ ] 复核 `@hypit/*` 下其余包（`hyperframes`、`render-hyperframes`、`provider-hyperframes-local`、`browser-capture` 等）是否同为该授权（当前均标注 `SEE LICENSE IN LICENSE`）

**声明**：以上为对 LICENSE 文本的阅读理解，不构成法律意见。请以 Hypit.AI 的书面答复和执业律师意见为准。

---

## 3. HyperFrames（拟采用，非当前依赖）

| 项目 | 内容 |
|---|---|
| 作品 | HyperFrames — Write HTML. Render video. Built for agents. |
| 来源 | https://github.com/heygen-com/hyperframes · 文档 https://hyperframes.heygen.com |
| 版权 | © HeyGen |
| 授权 | **Apache-2.0**（GitHub API 确认 `spdx_id: Apache-2.0`，OSI 认证） |
| 我们如何使用 | **拟采用**（尚未引入）。作为 `@hypit/hyperframes` / `render-hyperframes` / `provider-hyperframes-local` 的授权干净替代 |
| 限制 | 无商用限制、无渲染收费。需保留归属声明，无担保 |
| 技术栈 | Node ≥22 + Puppeteer（无头 Chrome 逐帧 seek）+ FFmpeg 编码；`data-start`/`data-duration`/`data-track-index` 描述时间轴；GSAP / Lottie / CSS / Three.js / WAAPI（Frame Adapter 模式） |
| 立项 | `tasks/LAMP-C31.md` |

**安全注意**：无头浏览器渲染不可信的 HTML/CSS/JS 属于攻击面。当前模板由我方自写，风险较低；**若将来开放商家自定义视频模板，必须做沙箱与输入校验**。

**引入后需补做**：`npm ls --all` 扫描传递依赖的授权，确认无非 Apache-2.0 混入（已写入 LAMP-C31 §3 第 5 点）。

---

## 4. 其他运行时依赖

`apps/web/package.json` 中的 npm 依赖（Next.js、React、Prisma、AWS SDK、sharp、Resend、qrcode.react 等）沿用各自上游授权，按常规 `node_modules` 分发方式处理，不在此逐条登记。

若将来新增**非 npm 方式引入**（vendored、源码复制、GitHub 直取）的第三方组件，必须在本文件追加条目。

---

## 5. 追加条目的模板

```markdown
## N. <组件名>

| 项目 | 内容 |
|---|---|
| 作品 | |
| 版本 | |
| 来源 | |
| 版权 | |
| 授权 | |
| 我们如何使用 | 代码复制 / 仅参考思路（选一，并说明范围） |
| 原始 LICENSE 位置 | |
| 限制 | 商标 / 多租户 / 商用 / 再分发 / 无 |

**引用位置**

| 文件 | 关系 |
|---|---|

**待办**

- [ ]
```

---

## 6. DeepSeek Harness（D1本地桌面开发，尚未分发）

| 项目 | 内容 |
|---|---|
| 作品 | DeepSeek Harness |
| 研究版本 | `687f282e8625c6b8d11ff58211a90524be2e4317`，2026-10-17 |
| 来源 | https://github.com/deepseek-ai/deepseek-harness |
| 版权 | Copyright (c) 2026 DeepSeek |
| 根授权 | MIT；[固定版本原文](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/LICENSE) |
| 我们如何使用 | 固定官方源码复制到独立产品目录，修改宿主与自有插件，执行本地离线D1验证；不作为已发行商家安装包 |
| 引用位置 | `apps/desktop-harness/**`；具体补丁记录 `apps/desktop-harness/LAMPSTAGE-DESKTOP.md`；只读原始基线在 `.codex-tmp/commerce-agent/desktop/d1a/` |
| 引入前要求 | 明确采用版本及范围，核对实际使用的子模块与传递依赖许可；如复制/修改源码，登记引用位置、修改说明并保留完整原始LICENSE及版权 |
| 发行边界 | 使用Lampstage自有品牌，不暗示DeepSeek官方产品或背书；根MIT不能替代依赖和发行验收。当前没有可分发的Harness衍生安装包 |

原始根MIT、9个vendor MIT及native BSD-3-Clause LICENSE完整保留；原始详细依赖声明位于产品副本的THIRD_PARTY_NOTICES.md。D1排除subagent-claude-code包及其单独许可SDK的安装和构建。

固定开发工具pnpm11.28.5、Electron44.7.0、Koffi3.1.1均为MIT；保留其随包版权文件。libreoffice-kit0.1.5为MPL-2.0，D1不下载/使用Office运行资产，但官方编译依赖仍安装其npm包；lightningcss为MPL-2.0、eslint-plugin-sonarjs为仅开发使用LGPL-3.0-only。禁止把这些声明改写为MIT；若未来分发须依据实际产物闭包保留适用版权、许可与对应源码义务。

D1已保存 `.codex-tmp/commerce-agent/desktop/d1b/installed-license-inventory.json`：1393个已安装包/版本的package.json声明，含4个未声明项与2个要求查看LICENSE的条目；这不是发行许可放行或安装包SBOM。根、vendor和native LICENSE逐文件核对与固定基线一致。独立包名核对确认未安装 `@anthropic-ai/claude-agent-sdk`；已有 `@anthropic-ai/sdk@0.129.0` 是声明MIT的通用API客户端，两者不得混淆。源码差异清单位于同目录 `source-patch-inventory.json`。

---

最后更新：2026-10-17
