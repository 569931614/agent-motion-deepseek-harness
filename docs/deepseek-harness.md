# DeepSeek Harness 插件

Agent Motion 1.6.0 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的原生 Cordis bundle。它提供 DSH Web 侧栏“动效工坊”、`/agent-motion/` 制作页，以及 `agent-motion`、`motion-craft`、`srt-reference-to-three` 三个 Skill。支持科技感、教育风或营销风，制作可编辑的 Three.js 口播影片。

页面输入为人物 MP4、文案、音色来源、风格与画幅。默认复刻视频中声音，也可填写绑定 CosyVoice-v3.5-plus 的已有音色 ID；随后生成配音，再通过 MuseTalk 生成数字人口播。制作会话用 `scripts/prepare-avatar.mjs` 强制混入新配音，生成 `voiced-avatar.mp4` 并重新对齐字幕。之后按原 Skill 完成 CPU 人物抠像、简体中文排版、Three.js 合成、音频混合与 H.264 MP4 导出。SRT 导入使用正文配音，原时间轴不用于新成片。模板是制作起点，智能体继续按原始 Skill 完善构图、动作和视听检查。

## 安装到 DSH Web

适配基线是 `@deepseek-ai/dsh@0.2.0-rc.2`、同版本技能接口及 Cordis `~4.0.4`。需要 Node.js 22.x 或 24.x、pnpm，以及已配置模型服务的 Harness。安装器不配置模型账号。

先初始化官方完整 Web profile，再安装 1.6.0 发布包；替换下面 tarball 的实际路径：

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 web --dump-config
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "/absolute/path/to/agent-motion-1.6.0.tgz"
npx @deepseek-ai/dsh@0.2.0-rc.2 --profile web --dump-config
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

配置输出应包含 `agent-motion` bundle 和同名插件行。Web 默认地址是 `http://127.0.0.1:3080`。若已有 Web 进程，安装或升级后重启。Windows 路径可写为 `C:/packages/agent-motion-1.6.0.tgz`；PowerShell 中若自定义 npm/npx 包装器影响参数，使用对应 `.cmd` 启动器，或直接执行已安装 Harness 的 Node CLI。

源码构建、GitHub 安装、移除、平台依赖和云服务配置见 [部署说明](deployment.md)。在 Harness“设置 → 动效工坊”中填写阿里百炼北京区域 DashScope、MuseTalk 服务与腾讯云 COS 配置并保存，制作页自动更新配置状态，无需环境文件或重启；配置就绪后才能执行收费制作。COS 使用私有存储桶的完整 `name-APPID` 名称与 SecretId / SecretKey，可选 STS SessionToken；Endpoint 默认 `https://cos.ap-beijing.myqcloud.com`，区域由地址推导，权限限定为所需对象的 `PutObject` / `GetObject`。密钥存于服务器，设置页只回显是否已配置；输入留空保留，勾选“清除”才删除，保存后输入清空，不写入 prompt 或浏览器存储。正常使用见 [使用手册](user-manual.md)。

## 在制作页开始

先通过 Harness 首页完成现有登录，点击左侧“动效工坊”，右侧即显示制作页；也可直接打开同地址 `/agent-motion/`。页面复用宿主 token/cookie 认证。检查配置就绪后，上传不超过 1 GB 的人物 MP4，填写配音与字幕文案或导入 UTF-8 SRT/TXT。默认“使用视频音色”无需手填 ID；视频开头最多 20 秒须包含至少 5 秒清晰单人说话音轨。片头静音时先截取合适说话片段上传，无声视频无法复刻音色。也可选择“使用已有音色 ID”并填写模型绑定 ID；服务器的可选 `COSYVOICE_VOICE_ID` 只预填此模式，不改变默认视频选项。选择风格、尺寸，可填写中文标题，然后点击“开始制作”。

视频音色模式缺少 FFmpeg 或 FFprobe 时，会自动在专用工程运行 `node scripts/bootstrap.mjs`，检查两项媒体工具后才调用付费 API。首次准备可能耗时较长，部署建议按 [部署说明](deployment.md#准备独立制作工程) 预先完成；已有音色 ID 模式的后续环境沿用原 Skill 安装步骤。插件完成复刻、配音与数字人后创建真实 Harness 会话并加载 `agent-motion` Skill。页面显示上传原片、复刻音色、生成配音、数字人口播、字幕对齐、人像抠图、场景合成、渲染输出八个阶段；已有音色模式跳过复刻。可折叠预览生成音频和数字人视频、查看会话或停止任务。完成后显示 MP4 播放与下载、可编辑 Three.js 工程 ZIP 下载及 HTML 预览。ZIP 保留当前任务所需素材、字体和代码，解压后用 `node serve.mjs` 本地预览；重渲染另需本机媒体工具与浏览器。详见 [页面工程 ZIP](user-manual.md#页面工程-zip)。刷新会恢复文案、音色来源、标题、风格、画幅和状态；视频模式在已生成音色 ID 后仍保持原选项。若提示 401，回到 Harness 首页登录后查询当前任务。

每次执行调用收费配音和数字人服务，视频模式还会调用云端音色复刻；本地停止不保证撤销上游已创建的收费任务。声音样本、视频和生成音频上传至腾讯云 COS 私有存储，通过三小时有效的签名链接交给生成服务；浏览器播放宿主提供的本地产物。提交结果不确定时查询原任务，不重复提交。此版本的本地检查不代表真实收费 API 已完成验收。完整操作见 [页面快速开始](user-manual.md#页面快速开始)。

## 制作规则联动

工坊监视实际 Harness home 下 `agent-motion/production/.agents/skills/` 的制作规则。修改其中的 `motion-craft`、`srt-reference-to-three` 及引用资料后，新任务的制作要求、排版、字体和效果随之变化，无需重启。`agent-motion` 入口默认来自安装包，可在生产工程的同名目录放置完整入口以覆盖。

每个新任务首次执行时冻结本次规则，制作会话按快照完善模板初版，再渲染。执行中的任务、重试同一任务和旧视频保留原规则；需要应用新规则时新建任务。Skill 不负责修改上传表单或 API 配置。实际路径和修改方法见 [修改制作 Skill](user-manual.md#修改制作-skill)。

## 原声素材：用自然语言开始

在 Harness 中打开用于保存素材和工程的工作区，发送：

> 使用 agent-motion，在当前工作区新建 my-film 工程。输入是我提供的原视频和完整 SRT。风格：科技感；标题：让 AI 帮你完成重复工作；画幅：1920×1080，30 fps。先保存 brief、检查输入和准备同步人物层，再生成并改进 Three.js 影片。保留原口播顺序、声音和时间，交付 MP4、可编辑工程和实际检查记录。

把“科技感”换成“教育风”或“营销风”即可。智能体先通过 [初始化脚本](../deepseek/create-workspace.mjs) 创建独立制作工程，再运行工程内安装器和生产 CLI。原视频、字幕及 brief 保存在工程 `inputs/`，各轮影片保存在 `work/<任务>/`。已有工程直接续作；不在插件安装目录制作或覆盖旧成片。

此原声素材工作流直接使用已有录音与 SRT。英文字幕须先翻译为中文并保留时间轴，繁体字幕和标题转为简体；缺少 SRT 时可用对应录音的原文进行本地 CPU 对齐。页面则使用文案生成的新配音和新字幕时间，不需要文案对应原片口播。

可选使用 aa.com.cn 豆包接口生成本地背景素材；支持文字生图、参考图和异步任务续查，重渲染复用已保存图片。Key 配置和命令见 [豆包生图说明](image-generation.md)。

## 插件实现与维护

[TypeScript 入口](../deepseek/src/index.ts) 构建为 `deepseek/lib/index.js`，通过官方 `dsh-skill-filesystem` 子插件发现打包的三套 Skills，并在卸载时清理注册。Web 适配层注册制作页和任务接口，通过宿主会话控制器执行 Skill。激活层是 [cordis.patch.yml](../cordis.patch.yml)。文件、bash/pwsh、图片、浏览器及交付能力复用宿主；生产 CLI 和浏览器渲染使用工程自带工具链。

```sh
npm ci
npm run build
npm test
npm run test:plugin
npm run package:check
npm pack
```

`npm pack` 的 `prepack` 会构建 TypeScript。发布包包含编译输出，消费者安装时不运行 `prepare`；GitHub 分发也必须包含当前 `deepseek/lib/`。插件测试验证真实 Cordis 技能加载、完整正文、资源路径、卸载及独立工程，管线测试另验证输入和产物。升级 Harness 前重跑适配检查；渲染与环境检查不能替代视听验收。

检查图像和视频帧先用缩略图、低分辨率拼图或局部裁切，必要时才看原图。缺少图片输入路由、连续观看或试听能力时，交付记录应保留待检查项；详见 [使用手册的验收步骤](user-manual.md#验收与归档)。

商业视频制作、客户服务或收费产品集成须取得作者事先书面授权；[项目许可](../LICENSE)、[商业授权说明](../COMMERCIAL-LICENSE.md) 和 [第三方说明](../THIRD_PARTY_NOTICES.md) 分别约束对应材料。
