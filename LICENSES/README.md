# 本次交付的许可资料

自有源码原仓库未见统一的根开源LICENSE；本包以私有开发资料交接，未擅自为原代码赋予MIT/Apache等开源授权。`package.json`的UNLICENSED仅表示不声明公开开源许可。

原第三方告知完整保留在`source/THIRD_PARTY_NOTICES.md`。没有交付任何Hypit vendor源码、SDK、CLI或安装包，也未为复刻读取其实现；自有`hypit-runner.ts`仅用于说明待替换边界，不能在缺少外部实现时声称可运行。

本目录保留测试所用六个直接npm依赖的现有许可/告知文本与元数据，见`direct-dependency-notices.json`。精简锁的传递依赖版本/integrity和可获得的license元数据在`provenance/minimal-lock-packages.json`；本包不含这些第三方代码或二进制，接收方安装后应保留随包许可证。FFmpeg/ffprobe由接收方自行提供，未分发；本地版本记录在测试结果，实际所用二进制构建的许可由其发行方提供。

`examples/generated/`全部媒体由本批FFmpeg颜色源、正弦音与自造PPM像素生成，无用户影像、声音、商标或私有素材，可随此交接用于验证。它们是测试资产，不是供应商生成结果。没有转交无法确认权利的历史真实视频或参考素材。
