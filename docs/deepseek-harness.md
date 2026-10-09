# DeepSeek Harness 插件

Agent Motion 1.2.0 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的原生 Cordis bundle。它在 DSH Web 中提供 `agent-motion`、`motion-craft`、`srt-reference-to-three` 三个 Skill，用自然语言选择科技感、教育风或营销风，制作可编辑的 Three.js 真人口播影片。

原片、完整 SRT 和制作要求是输入。实际流程包括 CPU 人物抠像、简体中文字幕、Three.js 模板编排、逐帧渲染、原声混入和 H.264 MP4 导出。模板是制作起点，智能体继续按两个原始 Skill 修改构图和动作，并完成实际画面与声音检查。

## 安装到 DSH Web

适配基线是 `@deepseek-ai/dsh@0.2.0-rc.2`、同版本技能接口及 Cordis `~4.0.4`。需要 Node.js 22+、pnpm，以及已配置模型服务的 Harness。安装器不配置模型账号。

先初始化官方完整 Web profile，再安装 1.2.0 发布包；替换下面 tarball 的实际路径：

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 web --dump-config
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "/absolute/path/to/agent-motion-1.2.0.tgz"
npx @deepseek-ai/dsh@0.2.0-rc.2 --profile web --dump-config
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

配置输出应包含 `agent-motion` bundle 和同名插件行。Web 默认地址是 `http://127.0.0.1:3080`。若已有 Web 进程，安装或升级后重启。Windows 路径可写为 `C:/packages/agent-motion-1.2.0.tgz`；PowerShell 中若自定义 npm/npx 包装器影响参数，使用对应 `.cmd` 启动器，或直接执行已安装 Harness 的 Node CLI。

源码构建、GitHub 安装、移除和平台依赖见 [部署说明](deployment.md)。正常使用见 [使用手册](user-manual.md)。

## 用自然语言开始

在 Harness 中打开用于保存素材和工程的工作区，发送：

> 使用 agent-motion，在当前工作区新建 my-film 工程。输入是我提供的原视频和完整 SRT。风格：科技感；标题：让 AI 帮你完成重复工作；画幅：1920×1080，30 fps。先保存 brief、检查输入和准备同步人物层，再生成并改进 Three.js 影片。保留原口播顺序、声音和时间，交付 MP4、可编辑工程和实际检查记录。

把“科技感”换成“教育风”或“营销风”即可。智能体先通过 [初始化脚本](../deepseek/create-workspace.mjs) 创建独立制作工程，再运行工程内安装器和生产 CLI。原视频、字幕及 brief 保存在工程 `inputs/`，各轮影片保存在 `work/<任务>/`。已有工程直接续作；不在插件安装目录制作或覆盖旧成片。

英文字幕须先由 Harness 模型翻译为中文并保留原时间轴；繁体字幕和标题在生产时转为简体。没有字幕时，先准备并核对 SRT；插件没有新增 ASR 或 TTS 服务。

可选使用 aa.com.cn 豆包接口生成本地背景素材；支持文字生图、参考图和异步任务续查，重渲染复用已保存图片。Key 配置和命令见 [豆包生图说明](image-generation.md)。

## 插件实现与维护

[TypeScript 入口](../deepseek/src/index.ts) 构建为 `deepseek/lib/index.js`，通过官方 `dsh-skill-filesystem` 子插件发现打包的三套 Skills，并在卸载时清理注册。激活层是 [cordis.patch.yml](../cordis.patch.yml)。文件、bash/pwsh、图片、浏览器及交付能力复用宿主；生产 CLI 和浏览器渲染使用工程自带工具链。

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
