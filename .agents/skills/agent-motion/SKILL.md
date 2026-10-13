---
name: agent-motion
description: 在 DeepSeek Harness 中制作数字人口播、Three.js 动效视频及真人口播包装；页面默认复刻视频音色或使用已有音色 ID，以文案生成配音与数字人，再进入原 Motion Craft 管线，也支持既有原片与 SRT。
---

# Agent Motion · DeepSeek Harness

本 Skill 是插件入口。制作规则以本项目的 Motion Craft 和 SRT 与参考驱动制作 Skill 为准；沿用宿主的文件、bash/pwsh、图片及浏览器能力。

## 视频制作页面

DSH Web 左侧“动效工坊”及 `/agent-motion/` 页面接受人物 MP4、配音与字幕文案、音色来源、风格和画幅。默认“使用视频音色”：从视频开头最多 20 秒提取至少 5 秒清晰单人说话音轨，按 [官方接口](https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api) 在北京区域复刻绑定 `cosyvoice-v3.5-plus` 的音色；片头静音时先截取合适片段上传，无声视频无法复刻。也可选“使用已有音色 ID”，使用已绑定该模型的 ID。服务端随后生成配音，再使用 MuseTalk 生成数字人口播，之后创建实际 Harness 制作会话。视频模式缺 FFmpeg 或 FFprobe 时会自动在专用工程运行 bootstrap，媒体工具检查通过后才调用付费 API；首次可能耗时较长，部署建议预先准备。已有 ID 模式的后续环境沿用下文原 Skill 安装步骤。页面任务的当前工程已初始化；直接使用指令给出的独立任务路径，不重复创建工程，不重新调用云端付费生成服务。

页面 SRT 输入只取正文作为配音文案，纯文本也同时用作配音和字幕。原片无需与新文案口播相同；原 SRT 时间不能沿用于新配音。页面会话先按指令调用 `node scripts/prepare-avatar.mjs`，将本任务云端 `avatar.mp4` 与 `voice.wav` 生成 `voiced-avatar.mp4`，强制以新配音作为后续成品音轨；不可依赖上游数字人视频的原音轨。随后对该视频和 `narration.txt` 运行 `node scripts/align-subtitles.mjs --video <voiced-avatar.mp4> --text <narration.txt> --output <新的对齐目录>`，使用新配音重新对齐字幕。完整参数和目标路径以本次会话给出的命令为准，不覆盖已有素材。

CPU faster-whisper 首次使用下载模型，输出对齐目录中的 `source.srt` 与 `alignment.json`。以实际新配音核对时间与原文；内容明显不匹配、没有音轨或下载失败时停止并报告，不按时长均分、不擅自改写文案。将 `voiced-avatar.mp4` 与新 `source.srt` 交给原两个 Skill，先抠像再排版合成，保留新配音的完整声音与时间。页面折叠预览中的数字人视频是上游原产物，最终影片音轨则使用强制混入的新配音。

用户在 Harness“设置 → 动效工坊”填写阿里百炼北京区域 DashScope API Key、MuseTalk API Key，以及腾讯云 COS Endpoint、完整 `name-APPID` Bucket、SecretId、SecretKey 和可选 STS SessionToken。COS Endpoint 默认 `https://cos.ap-beijing.myqcloud.com`，区域从地址推导，不增加区域字段；只授予所需私有素材对象的 `PutObject` / `GetObject` 权限。保存后立即生效，制作页自动更新配置状态，无需环境文件或重启。设置页只显示密钥是否已配置，留空保留、明确勾选“清除”才删除，保存后密钥输入清空。默认视频模式无需手填音色；可选默认音色 ID 只为已有 ID 模式提供预填值，不改变视频默认选项。凭据存于服务器，禁止读取、输出或复制进 prompt、浏览器存储、文案和工程交付文件；环境变量只保留 CLI 兼容，内部 `MOTION_OSS_*` 字段分别存储上述 COS 配置。云端素材存于腾讯云 COS 私有存储，以三小时有效且公网可访问的签名链接交给阿里音色复刻及数字人服务，存储桶保持私有；制作只使用已下载的本地资产。

每次页面执行调用收费服务，视频模式还会调用音色复刻。本地停止不保证取消上游已创建的付费任务；提交不确定时查询已有任务，不重复提交音色复刻、配音或数字人生成。页面完成后验证真实 MP4 并显示成片和工程预览；构建、模拟测试或本地渲染成功不等于真实云端 API 与视听验收完成。

原声素材 CLI 工作流仍可直接使用已有视频和 SRT，保留原录音与输入时间轴。此分支的纯文本必须对应原片口播，可运行 `node scripts/align-subtitles.mjs --video <原片> --text <字幕.txt> --output <新的对齐目录>`，目录父级须存在、目标须不存在。脚本基于识别词级时间匹配原文，不按时长均分、不用识别稿替换用户文案。原声 CLI 不自行调用配音或数字人服务。

## 准备独立工程

本 Skill 的资源目录是安装包中的 `.agents/skills/agent-motion/`；由此向上三级是插件根目录。解析资源目录提供的绝对路径，得到 `<插件根>/deepseek/create-workspace.mjs`。用宿主 shell 执行这个脚本，将新工程创建在用户工作区内、插件安装目录外：

```text
node "<插件根的绝对路径>/deepseek/create-workspace.mjs" "<用户工作区内的新目录>"
```

目标的父目录必须存在，目标目录必须尚不存在。初始化只复制生产资源，不下载依赖；已有目录和符号链接会被拒绝。复制出错后保留部分文件供诊断，应修复原因后换一个新目录，不能删除用户素材。已有 Agent Motion 工程直接续作，不重新初始化或覆盖。

后续命令都从工程根目录运行；每次 bash/pwsh 调用显式指定该目录。完整读取工程副本中的 `AGENTS.md`、`docs/getting-started.md`、`docs/compatibility.md`，再运行：

```sh
node scripts/bootstrap.mjs
```

安装准备项目内 Python、Chromium、FFmpeg / ffprobe 和人物抠像模型，并执行环境与抠像检查。通过宿主既有权限机制处理实际阻止安装或渲染的错误，不修改全局权限。

## 进入制作

将用户提供的原片与完整 SRT 放入工程的 `inputs/`。完整读取该工程中的 `.agents/skills/srt-reference-to-three/SKILL.md` 和 `.agents/skills/motion-craft/SKILL.md`，按输入适用分支推进。纯动画只需 Motion Craft。始终使用工程副本的规则、脚本、字体与引用路径，不在插件安装目录写成片或安装运行环境。

插件目录里的原始技能便于发现制作能力；实际执行以工程副本为准。工程在父 Git 仓库的子目录时，宿主可能只扫描父仓库技能，仍须通过文件工具完整读取上述工程本地文件。阶段正文按 `node scripts/read-stage.mjs` 分页读取，每次只输出一页，看到完整结束标记后再继续。

真人或数字人口播必须先完成同步人物层与实际检查，保留当前制作输入的完整口播顺序、声音和时间：页面使用 `voiced-avatar.mp4` 的新配音；原声 CLI 使用原片录音。按原规则完成素材、构图、连续动画、声音、复查，交付 MP4 与可编辑工程。

## 三套中文模板与生产命令

支持简报中的 `科技感`、`教育风`、`营销风`；未指定时默认科技感。出现多个风格名时，让用户用 `风格：教育风` 这样的单独字段明确选择。工程中的 `templates/catalog.json` 记录各模板的配色、字体、人物布局与动作参数；`templates/designs/index.html` 提供三套可切换的视觉设计稿。

接收用户自然语言制作指令后，将要求保存为 UTF-8 的 `inputs/brief.txt`。简报可包含 `风格：营销风`、`标题：把好产品讲清楚`、`要点：讲清价值／真实示例／行动建议`；三个要点各不超过十八字，必须忠于原片与用户事实。没有要点时，脚本从原字幕取三处摘录作为可编辑初稿。标题最多三十六字，不制造原片没有的主张。

完成原 SRT Skill 全文分析与素材准备后，从工程根运行：

```sh
node deepseek/lib/produce.js --video inputs/source.mp4 --srt inputs/source.srt --brief inputs/brief.txt --output work/my-film
```

该 TypeScript 编译入口执行字幕解析、简体转换、原 CPU 人像抠图、模板 Three.js 合成、原声混合、H.264 / AAC 输出。可用 `--style 教育风` 明确覆盖简报，`--preview-only` 先做抠像及可编辑预览、暂缓成片编码；参数详见工程内 `docs/user-manual.md`。有权使用的背景音乐通过 `--music inputs/music.wav --music-volume 0.08` 低音量混入，仍须检查人声清晰。人物偏心或有多人时校准 `--person-x`、`--person-y` 与 `--person-scale`；默认遮罩上半身质心只是取景启发，不能代替画面检查。

简体转换保留字幕时码，不自动翻译英文。英文字幕须先由宿主可用模型翻译成中文并核对时序；实际可见文案全部使用简体中文，品牌缩写按用户要求处理。

输出在新任务目录：`final.mp4`、`index.html`、可编辑 `scene.mjs` 和 `film.json`、人物层、原素材、简报与检查记录。继续按 Motion Craft 阶段规则完善构图、动画、声音并进行实际视听检查；模板是连续创作的起点，不以默认排版代替内容判断。修改后运行任务目录内 `render.mjs` 重渲染，已有成片先重命名保留。交付/归档保留完整制作工程根目录，包括原本所需的字体、依赖、工具与任务资产。

## 可选豆包生图与背景素材

需要生成背景或图生图素材时，先读工程的 `docs/image-generation.md`，使用 aa.com.cn 的豆包 Seedream 接口。由用户在制作工程本地 `.env` 填入 `AA_API_KEY`，不要要求在聊天中粘贴 Key，不读取或输出 Key 的内容。生图使用该平台额度，沿用当前用户授权范围，不自行批量提交或将重渲染变成重复生图。

将无字背景提示词写入 UTF-8 `inputs/image-prompt.txt`，明确科技感、教育风或营销风的配色，以及标题、信息区和人物的留白。提示词要求无文字、无字母、无标志；视频内简体中文、数字和要点通过 Three.js 独立排版。

```sh
node --env-file=.env deepseek/lib/image.js --prompt inputs/image-prompt.txt --output inputs/generated/hero
```

输出须为新目录，父目录须存在；默认模型 `doubao-seedream-4-0-250828`、尺寸 `2848x1600`、最多一张。只有用户明确授权上传的本地 PNG/JPEG/WebP 才作为 `--reference`，最多 14 张；不自动上传原视频、人物层或私人素材。异步任务等待超时保存 `task.json` 后，用 `--resume --output inputs/generated/hero` 续查，只查询原任务，不重新提交付费生成。

先检查已下载图片的缩略图，再将实际路径传给生产命令，例如 `--background-image inputs/generated/hero/image-1.png`。图片复制为影片的 `background.*` 本地资产；按实际后缀引用，保持简体文字与人物独立合成。工程重渲染复用本地资产，不调用生图接口。完整参数、异步处理及两份官方接口文档见 `docs/image-generation.md`。

## 预览与检查

在工程根执行 `npm run serve`，打开当前工程在 `work/<任务>/` 下的实际预览页面。本地抠像与渲染复用项目 Python、Playwright 和 FFmpeg；重渲染复用已有配音、数字人与背景资产，不再次提交付费生成。

检查图片和视频时先生成缩略图、低分辨率代表帧拼图或局部裁切；只有小字、脸部或细节无法判断时才打开对应原图。宿主的 `read_image` 需要支持图片输入的模型路由；交互浏览器使用已安装且可用的浏览器插件。缺少实际观看、连续动作或试听能力时，按原规则标明待检查预览与具体缺口，不能用测试通过或导出成功替代成片视听验收。

许可沿用工程 `LICENSE` 与第三方说明；未经作者事先书面授权不得商用。
