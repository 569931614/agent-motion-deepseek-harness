# 部署说明

本说明部署 Agent Motion 1.6.0 的 TypeScript Cordis 插件、Web 制作页及独立视频制作工程。页面流程为人物 MP4 与文案 → 默认复刻视频音色（也可使用已有音色 ID）→ CosyVoice-v3.5-plus 配音 → MuseTalk 数字人口播 → 原 Agent Motion Skill 制作。宿主适配基线为 `@deepseek-ai/dsh@0.2.0-rc.2`；插件入口是 `deepseek/lib/index.js`，源文件位于 `deepseek/src/`。

## 准备与构建

需要 Node.js 22.x 或 24.x、npm、可下载依赖的网络；Harness 的插件管理另需要 PATH 中可用的 pnpm。模型服务由 Harness 自行配置。克隆或完整解压项目，在项目根运行：

```sh
npm ci
npm run build
npm test
npm run test:plugin
npm run package:check
npm pack
```

构建使用 TypeScript 5.9.3、ES2022 模块和严格类型检查，产物位于 `deepseek/lib/`，可由 Node 直接加载。`test:plugin` 运行插件与管线检查。打包前的 `prepack` 自动构建，生成 `agent-motion-1.6.0.tgz`；包里保留原 Skills、三种模板、制作页静态文件、字幕对齐工具、字体与编译输出。无需消费者在安装时运行 Git `prepare`。

发布 GitHub 源码时同时提交更新的 `deepseek/lib/`，才能直接从 GitHub 安装。不要提交 `node_modules/`、`.runtime/`、`.venv/`、用户输入或制作历史。发布前检查实际 `npm pack` 文件列表及 [第三方许可](../THIRD_PARTY_NOTICES.md)。

Windows 的 PowerShell 包装脚本可能吞掉 npm 命令中的 `--` 参数。因此携带业务参数的安装、诊断、抠像和生产命令统一直接执行 `node` 脚本；上述无业务参数的 npm 构建命令也可使用 `npm.cmd`。

## 安装到 Harness Web

先生成官方完整 Web profile；随后安装 tarball 并确认 bundle 层：

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 web --dump-config
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "/absolute/path/to/agent-motion-1.6.0.tgz"
npx @deepseek-ai/dsh@0.2.0-rc.2 --profile web --dump-config
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

Windows 可将包路径替换为 `C:/packages/agent-motion-1.6.0.tgz`。配置输出应出现 `# == agent-motion`、`id: agent-motion` 和 `name: agent-motion`，profile bundle 列表应保留官方 base、web-app 及 agent-motion。Web 默认监听 `http://127.0.0.1:3080`；模型凭据和路由继续在 Harness 配置。安装或替换包后重启既有 Web 进程。

Cordis 插件会在现有 Harness Web 服务上注册 `/agent-motion/` 制作页及侧栏“动效工坊”。先通过 Harness 首页登录；页面、任务接口、工程下载和预览文件复用宿主 token/cookie 认证。页面接收 MP4、文案、音色来源、风格和尺寸；默认从视频声音复刻音色，也可输入模型绑定的已有 ID。生成配音与数字人后执行实际 `agent-motion` Skill 会话，回显中间素材、MP4、可编辑工程 ZIP 与 HTML 预览。操作见 [使用手册](user-manual.md#页面快速开始)。

已构建的本地 checkout 可从其根目录安装：

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add .
```

本插件源码仓库为 [569931614/agent-motion-deepseek-harness](https://github.com/569931614/agent-motion-deepseek-harness)。仓库默认私有，需要已获访问权限的 GitHub 账号；可用已认证的 Git 克隆，再从本地安装：

```sh
git clone https://github.com/569931614/agent-motion-deepseek-harness.git
cd agent-motion-deepseek-harness
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add .
```

已配置包管理器 GitHub 访问凭据时，也可安装包含编译输出的固定提交：

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "github:569931614/agent-motion-deepseek-harness#<commit-sha>"
```

卸载只移除插件，不删除制作工作区：

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web remove agent-motion
```

## 服务端配音、数字人与 COS 配置

在 Harness 首页打开“设置 → 动效工坊”，填写阿里百炼北京区域 DashScope、MuseTalk 与腾讯云 COS 配置，点击“保存设置”。无需编辑 `.env` 或重启 Web，保存后即用于后续制作；保存和读取配置不会调用收费服务。制作页也提供“设置 → 动效工坊”入口，独立设置页为同地址 `/agent-motion/settings.html`，复用宿主登录认证。

密钥和 COS SecretId 只显示“已配置 / 尚未配置”，不回显真实值，也不写入浏览器 localStorage。密钥输入留空会保留已有配置；需要删除时勾选对应“清除”再保存。保存后所有密钥输入框清空。普通字段可编辑，留空可清除；当前服务无法写入时页面显示只读状态。设置存于服务器，勿将其写入制作文案、Skill prompt 或版本库。DashScope 使用北京区域；视频复刻绑定 `cosyvoice-v3.5-plus`，已有音色模式也须提供绑定该模型的有效 ID，系统音色名称不适用。

v3.5-plus 没有系统预置音色。默认“使用视频音色”按阿里官方的 [声音复刻接口](https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api)，提取视频开头最多 20 秒后云端复刻并用于配音，无需预先手填 ID。视频须有至少 5 秒清晰单人说话音轨；片头静音请先截取合适说话片段上传，无声视频无法复刻音色。选择“使用已有音色 ID”时，可使用已按官方 [声音设计](https://help.aliyun.com/zh/model-studio/voice-design-api-references) 或复刻接口创建的 ID，此模式不重新创建音色。`COSYVOICE_VOICE_ID` 仅作为已有 ID 模式的可选预填值，不改变页面默认视频选项。

| 页面设置字段 | 配置 | CLI 兼容字段 |
| --- | --- | --- |
| DashScope API Key | 阿里百炼北京区域 API Key。 | `DASHSCOPE_API_KEY` |
| 默认音色 ID | 可选，用于“使用已有音色 ID”模式的预填值；默认视频复刻模式无需填写。 | `COSYVOICE_VOICE_ID` |
| MuseTalk API Key | MuseTalk 数字人服务的 API Key。 | `YIDEVS_API_KEY` |
| COS Endpoint | 默认 `https://cos.ap-beijing.myqcloud.com`；使用存储桶所在区域的地址，区域由地址推导，无需另填。 | `MOTION_OSS_ENDPOINT` |
| COS Bucket | 私有存储桶的完整 `name-APPID` 名称，例如 `motion-assets-1250000000`。 | `MOTION_OSS_BUCKET` |
| COS SecretId | 腾讯云 SecretId，权限范围限定到所需素材对象。 | `MOTION_OSS_ACCESS_KEY_ID` |
| COS SecretKey | 对应的腾讯云 SecretKey。 | `MOTION_OSS_ACCESS_KEY_SECRET` |
| COS SessionToken | 可选，使用腾讯云 STS 临时凭据时填写。 | `MOTION_OSS_SECURITY_TOKEN` |

使用腾讯云 COS 私有读写存储桶，只为所需素材对象授予 `PutObject`、`GetObject` 权限。复刻用声音样本、人物视频和生成音频上传至该存储桶，服务端签发三小时有效的 HTTPS 素材链接。阿里官方 [音色复刻接口](https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api) 接收公网可访问的音频 URL；插件提供私有对象的 COS 签名链接供其读取，数字人服务同样读取签名素材链接，无需公开存储桶。所选 COS 区域的地址和签名链接须可由云服务通过公网访问。使用 STS 时，临时凭据有效期也须覆盖素材读取时间。

生成产物下载至本地工作区，由已认证的 Harness 文件接口向浏览器提供；不将云服务凭据或签名素材链接作为制作提示词。COS 替换素材存储，音色复刻与配音仍使用阿里百炼北京区域 CosyVoice。

设置页通过已认证的 `GET /api/agent-motion/settings` 读取普通字段、密钥是否已配置及可写状态，`POST` 保存明确提交的变更；接口不回显密钥。制作页通过 `GET /api/agent-motion/config` 读取就绪状态和可选默认音色。在 Harness 设置中保存后，制作页会自动更新配置状态；独立设置页或需要手动核对时可点“重新检查配置”。每次制作执行会调用收费配音与数字人服务，视频模式还会调用音色复刻；停止本地不保证取消上游已创建任务。提交结果不确定时保留现有任务并查询，不自动重提收费请求。

环境变量保留为独立供应商脚本的 CLI 兼容方式，可使用表中的兼容字段；`MOTION_OSS_*` 内部名称保留，实际填写腾讯云 COS 地址、完整 Bucket、SecretId、SecretKey 和可选 SessionToken。源码 `.env.example` 可作为本机参考，需由独立脚本的进程显式加载，文件不会自动加载。`.env` 已从 Git 排除。Harness 制作页直接读取上述服务器设置存储，使用“设置 → 动效工坊”配置。

新服务适配的构建、模拟测试和本地渲染检查不能证明真实收费 API 已完成端到端验收；上线前应使用获授权的短样片核对语音、口型与计费记录。

## 准备独立制作工程

制作页的专用工程位于实际 Harness home 的 `agent-motion/production/`，不在插件安装包内；设置 `DSH_HOME` 时以 Web 进程的该值为准，未设置时使用 Harness 解析的默认 home。视频音色模式缺少 FFmpeg 或 FFprobe 时会自动在此工程运行 `scripts/bootstrap.mjs`，再检查两项媒体工具，通过后才调用付费 API。首次准备需要联网，可能耗时较长；部署建议预先完成 bootstrap。已有音色 ID 模式直接生成配音，后续制作环境沿用原 Skill 安装步骤。预先准备时，若专用工程尚不存在，先创建其父目录并初始化；已存在时直接进入工程，勿再次运行初始化脚本：

```sh
node -e "require('node:fs').mkdirSync(process.argv[1], { recursive: true })" "/resolved/dsh-home/agent-motion"
node "/absolute/path/to/plugin/deepseek/create-workspace.mjs" "/resolved/dsh-home/agent-motion/production"
cd "/resolved/dsh-home/agent-motion/production"
node scripts/bootstrap.mjs
node scripts/doctor.mjs --matting --json
```

替换为实际 Web 进程的 home 和插件路径。环境完成一次后供后续页面任务共享；每个任务的素材与产物仍分开保存。脚本自动处理 FFmpeg、Chromium 与隔离 Python，无需在页面配置这些路径。

在安装包外创建一个新目录，父目录须已存在。插件入口 Skill 会解析安装包的资源路径，也可手动执行：

```sh
node "/absolute/path/to/plugin/deepseek/create-workspace.mjs" "/absolute/path/to/projects/my-film"
cd "/absolute/path/to/projects/my-film"
node scripts/bootstrap.mjs
node scripts/doctor.mjs --matting --json
```

初始化会复制已编译生产 CLI、`scene.mjs`、全部模板、原始制作 Skills、脚本和字体，创建 `work/`，并生成匹配的生产锁文件。工程不需要 Harness 或 TypeScript 开发依赖，也不运行 `build`/`prepack`。已有目录和符号链接会被拒绝；部分失败工程保留供诊断，修复后换新目录，勿覆盖素材。

制作页把 `agent-motion/production/.agents/skills/` 注册为可编辑 Skill 来源，优先于插件包里的同名 Skill，并监视文件更新。制作要求、排版、字体和效果在其中的 `motion-craft`、`srt-reference-to-three` 及引用资料中维护；编辑后新任务直接生效，无需重启。`agent-motion` 入口默认使用安装包版本，也可把完整入口目录复制到生产工程的同名目录后覆盖。升级插件不覆盖这些生产规则；要采用上游新规则时，请比较后手动合并。

每个新任务首次执行会先将生产工程的 `AGENTS.md`、三套制作 Skill 及引用资料完整快照到 `inputs/studio/<任务编号>/rules/`，记录 `revision.json`，再调用收费服务。制作会话按该快照制作，避免制作过程中编辑规则改变当前任务；同一任务重试仍复用已有完整快照，旧任务不会自动重制。部署时需要备份生产规则与任务快照，只有插件 tarball 不包含已有用户自定义规则。具体修改方式见 [使用手册](user-manual.md#修改制作-skill)。

`bootstrap.mjs` 准备工程内 Node 依赖、隔离 Python、Chromium、FFmpeg/ffprobe 和 RVM 模型，再做环境与短片抠像检查。下载和缓存保存在 `.runtime/`、`.venv/`；模型、浏览器和运行环境不随 tarball 打包。首次安装需要联网，CPU 抠像不要求独立显卡，但速度取决于视频长度、分辨率和机器。

制作页会准备插件安装目录外的专用制作工程。视频模式在媒体工具可用后提取声音并复刻音色，缺失时按上述行为自动准备；已有 ID 模式直接生成配音，后续由原 Skill 检查并安装制作环境。文案用于新配音和字幕，SRT 导入只取正文，时间按生成配音重新对齐。本地 CPU faster-whisper 首次使用下载识别模型。原声素材 CLI 仍可直接使用既有视频与 SRT，不调用音色复刻、配音或数字人服务。模型下载失败时保留素材和错误；上游收费提交不确定时先查现有记录，不以重试安装替代重新核对任务。

Linux 缺少 Chromium 系统库时，从制作工程根执行：

```sh
node scripts/setup.mjs --with-deps
```

该步骤可能调用发行版系统包管理器并需要管理员权限。不能承诺无 root 自动完成。网络下载失败时保留错误、恢复相应官方下载源的访问，再执行同一安装命令；不要关闭校验或用来源不明的二进制替换下载。

## 平台与验证范围

| 项目 | 当前说明 |
| --- | --- |
| Windows x64 / Node 22 | 本轮完成本地安装、环境诊断及 CPU 真人片段处理；三种风格管线的实测结果以本次交付记录为准。 |
| macOS 13+ / Intel 或 Apple 芯片 | 安装目标平台；本轮尚未重新完成端到端实测。 |
| glibc Linux / x64 或 arm64 | 安装目标平台；系统浏览器依赖可能需要管理员安装，本轮尚未重新完成端到端实测。 |
| Node 24 | 支持目标版本；本轮本地实测使用 Node 22。 |
| Windows ARM64 | 固定 ONNX Runtime 后端不支持原生 ARM64 安装；使用受支持的 x64 Node 环境。 |

原 CI 矩阵包含六个平台/Node 组合，新代码应继续由该矩阵验证；已有 CI 配置不等于本次矩阵已经通过。编码、环境、插件测试也不代表每段人物边缘、连续动作和声音已验收。具体操作及结果文件见 [使用手册](user-manual.md)。

## 公司或服务部署

项目使用自定义 Motion Craft Community License 1.0，商业视频制作、客户付费服务、收费产品或托管生产服务须事先取得作者书面授权，范围以授权协议为准。[商业授权说明](../COMMERCIAL-LICENSE.md) 不是授权书。

RVM 保留 GPL-3.0，FFmpeg 构建、Chromium、运行依赖及字体保留各自许可；项目授权不替换这些许可。分发安装环境或完整工程时保留相应许可证与声明，组合打包需另外核对适用条款。见 [项目许可](../LICENSE) 和 [第三方说明](../THIRD_PARTY_NOTICES.md)。

制作页的工程下载接口会按需生成当前任务的 ZIP，保留 `work/<任务编号>/` 及所需人物层、素材、字体、Three.js、Playwright 代码和独立渲染脚本。新任务带上本次规则快照；不包含凭据、其他任务、逐帧 PNG、Python 环境或浏览器二进制。解压后 `node serve.mjs` 可在本机预览；重渲染需准备 FFmpeg/FFprobe 和 Chromium，可使用 PATH、`FFMPEG_PATH` / `FFPROBE_PATH` 及 `BROWSER_EXECUTABLE` / `BROWSER_CHANNEL` 指定。具体命令见 [页面工程 ZIP](user-manual.md#页面工程-zip)。导出与本地重渲染不再次提交云端配音或数字人任务。

原声素材 CLI 工程归档时仍须保存完整工程根及依赖、字体、素材和人物层；单独复制 `work/my-film/` 不足以重新渲染。迁移到另一平台时保留工程与锁文件，在目标机器重新准备平台运行环境。公司服务自身迁移还需备份生产工程、用户规则与 Harness 设置；单个任务 ZIP 不是服务器配置备份。
