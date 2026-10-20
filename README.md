# Lampstage 视频生成工作流专项交接

本包用于把**实际存在的自有视频代码和协议**接入接收方现有 macOS Codex Harness。用户所写的“hardness”在本包按既有本地编排宿主处理；本包不假定其内部 API，也不附带 Lampstage 桌面程序。

**当前不能还原一条已核验的真实供应商生成链。** 原仓库有业务流程、单次调用和 W1/W2 后端代码，但新直连缺真实 App/节点映射、可导入工作流 JSON、模型/自定义节点版本及应用运行权限；旧实际处理器仍依赖未随包交付的 Hypit。详见[缺口清单](docs/05-缺口与验收矩阵.md)。本包的自造视频仅用于离线验证，不能替代真实生成证据。

## 先看这些资料

- [实际流程与复用入口](docs/01-实际流程与接入.md)：分清旧多段、单次调用、W1/W2。
- [供应商协议与参数](docs/02-接口与参数.md)：上传、提交、查询、取消、异常及当前官方协议依据。
- [宿主适配顺序](docs/03-Harness适配.md)：提交阶段、保存远端身份、恢复查询、收取、下一阶段。
- [测试、样例与版本](docs/04-测试与样例.md)：实际运行结果、依赖、macOS 操作说明。
- [缺口与验收矩阵](docs/05-缺口与验收矩阵.md)：未实现/无法交付/未核实项逐条列出。
- `docs/audits/`：对原代码逐文件审计与依赖导入边；审计中的“未运行”指子代理静态审计，主线程实跑结果见 `evidence/current/`。

## 目录与入口

```text
source/apps/web/lib/video/          原视频源码：types、backends、backend-runtime等
source/apps/web/lib/video-calls/    新单次调用：契约/engine可复用，业务processor仍依赖Hypit
source/apps/web/lib/...            实际第一方依赖；数据库/账号/存储参考，不要求整体运行
source/apps/web/scripts/           原worker、测试、helper与只读核对脚本
source/apps/web/prisma/            schema和迁移结构参考，无任何数据库数据
source/tasks/                     W1/W2及相关实际规格原件
workflows/                        业务流程和配置缺口JSON；不是虚构的供应商节点图
contracts/                        脱敏协议样例与状态/字段含义
examples/                         本地模拟代码及明确标记的合成输入、中间视频和最终视频
evidence/                         本次真实测试日志与少量明确标注的历史记录
provenance/source-manifest.json    原路径、SHA256、来源HEAD与未提交工作树说明
FILE-MANIFEST.json                本交接全部载荷文件的大小与SHA256
```

推荐入口是 `source/apps/web/lib/video/backends/runninghub.ts` 的 `createRunningHubBackend()` 和 `backend-runtime/collector.ts` 的 `createCandidateCollector()`。前者不内置网络、上传或密钥读取；后者不内置网络/存储实现。`video-calls/contract.ts` 和 `engine.ts` 可参考其单次操作决策。不要直接启动原 `video-worker.ts`、`processor.ts` 或 `npm run video:test`。

接收方已有的账号、凭据保存、队列、租约、费用预留、产物存储、FFmpeg 和后期仍由接收方接管。W2 的 `PrismaVideoRuntimeStore`、原 ActorContext/Agent core、平台积分系统是 Lampstage 参考实现，不能强加到已有 Harness。不得为满足 DTO 伪造真实用户/审批或启动第二个 AgentLoop。

## 无密钥本地验证

要求 Node 22.20+（22系）或24+、npm，以及 PATH 上的 FFmpeg/ffprobe；原生依赖需匹配 macOS 芯片。运行环境准备：

```sh
npm ci
npm run client:generate
npm test
npm run test:media
npm run typecheck:protocol
npm run example:local -- --run my-first-check
# 同一名字再运行：从原记录查询，不重新提交
npm run example:local -- --run my-first-check
```

`client:generate` 只为原 W2 preparation 测试的 Prisma 模块加载生成客户端，不连接数据库，不执行迁移；Harness 的 W1 协议适配本身不需要 Prisma。不要设置生产 DATABASE_URL。`npm ci`/macOS 新机器安装本次未实跑：本次 Windows 验证使用现有同版本依赖，通过临时 junction 引用，junction/node_modules 不进入 ZIP 或 Git。

本次实际：7份本地测试文件 **80/80通过**；W1四个协议文件严格类型检查退出0；自造4秒视频链及同记录恢复实跑成功。首次模拟提交/查询/下载为1/1/1，恢复为0/1/0，最终720×1280 H.264/AAC。没有真实供应商调用、桌面、PG或付费生成。不能将这些结果称为macOS实测或真实工作流出片。

## 来源和授权

原仓库 HEAD：`d1200f16d35816ef2e5a5eef42f221d1586898c4`。这不是全部交接源码的提交：原工作树有未提交改动，以 `provenance/source-manifest.json` 逐文件 SHA 为实际依据。交接自身另有 Git 提交。

保留[原第三方告知](source/THIRD_PARTY_NOTICES.md)和 `LICENSES/`。没有为复刻目的读取或转交 Hypit 受限实现，也没有为自有代码擅自补上开源许可证；私有资料交接不等于授予第三方代码的再分发权。未附真实密钥、凭据配置、会话、用户私有素材、node_modules、构建缓存、业务数据库或 Electron/Windows 凭据模块。

此次仅整理、测试及上传专项交接资料；原项目功能开发和自动跟进仍暂停，未部署生产服务。

`source/tasks/`和原方案保留历史授权、计划及测试陈述，不能据此在接收方环境执行付费生成或生产操作。本批授权以本README范围为准。文件清单列出载荷文件，不对清单自身作递归自校验；完整ZIP另附SHA256。
