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

后续命令都从工程根目录运行；每次 bash/pwsh 调用显式指定该目录。完整读取工程的安装文档 `docs/getting-started.md`、`docs/compatibility.md` 及本任务适用的 `AGENTS.md`（页面使用指定规则快照，其他任务使用工程副本），再运行：

```sh
node scripts/bootstrap.mjs
```

安装准备项目内 Python、Chromium、FFmpeg / ffprobe 和人物抠像模型，并执行环境与抠像检查。通过宿主既有权限机制处理实际阻止安装或渲染的错误，不修改全局权限。

## 进入制作

将用户提供的原片与完整 SRT 放入工程的 `inputs/`。完整读取该工程中的 `.agents/skills/srt-reference-to-three/SKILL.md` 和 `.agents/skills/motion-craft/SKILL.md`，按输入适用分支推进。纯动画只需 Motion Craft。页面任务使用会话指定的完整规则快照，分页命令带该任务的 `--rules-root`，不被共享工程旧规则或后续编辑覆盖；其他任务使用工程本地规则。脚本、字体及通用工具仍来自制作工程，不在插件安装目录写成片或安装运行环境。

插件目录里的原始技能便于发现制作能力；实际执行以页面任务快照或其他任务的工程本地规则为准。工程在父 Git 仓库的子目录时，宿主可能只扫描父仓库技能，仍须通过文件工具完整读取上述实际文件。阶段正文按 `node scripts/read-stage.mjs` 分页读取，页面任务带指定 `--rules-root`，每次只输出一页，看到完整结束标记后再继续。

真人或数字人口播必须先完成同步人物层与实际检查，保留当前制作输入的完整口播顺序、声音和时间：页面使用 `voiced-avatar.mp4` 的新配音；原声 CLI 使用原片录音。按原规则完成素材、构图、连续动画、声音、复查，交付 MP4 与可编辑工程。

## 原版制作流程

页面的音色复刻、配音、数字人生成及新字幕对齐只负责准备新的制作输入。得到 `voiced-avatar.mp4` 和可信 `source.srt` 后，直接交给原版 SRT 分析与 Motion Craft，不先运行模板生产命令。

完整读取 SRT 与 brief，按 SRT Skill 保存全文内容分析并交接实际产物；随后严格按 Motion Craft 的 `assets` → `composition` → `animation` → `sound` → `review` 阶段完整读取规则并制作。从内容及参考确定人物形态、空间关系、文字角色和连续动作，先做通开场与最难关系的连续样段，再逐语义段扩展。场景、时间线、素材和渲染入口由本任务创建，不能用三处字幕摘录、固定卡片数量或模板全片布局代替全文分析与创作。

页面任务的薄交付约定仅用于回显与归档：在会话指定的 `work/<任务编号>/` 保存 `final.mp4`、`index.html`、可编辑 Three.js 源码与本任务自己的 `render.mjs`，并保留实际制作输入 `source.mp4`、`source.srt` 和 `brief.txt`。页面的 `source.mp4` 是强制合入新配音后的数字人视频，上传原片留在任务输入目录。人物层与其他素材保存在当前任务内；实际使用的字体和依赖须能随工程打包，通用字体使用工程字库路径。源码可按内容拆分并保存，既有 `PLAN.md` 或时间线沿用原规则；不强制 `film.json`、`validation.json` 或某种场景 schema。重渲染复用本任务已生成的配音、数字人与抠像资产，已有成片先重命名保留。

预览、绝对时间取帧、音频混合及视听验收沿用原版制作规则。导出 MP4 或程序检查成功不代表完成原版整片视听验收。

## 三套中文风格与可选模板 CLI

支持简报中的 `科技感`、`教育风`、`营销风`；未指定时默认科技感。出现多个风格名时，让用户用 `风格：教育风` 这样的单独字段明确选择。工程中的 `templates/catalog.json` 与 `templates/designs/index.html` 提供配色、字体和视觉设计参考，实际版式、人物位置、对象数量与动作按语义和当前规则决定，不强制套用参考布局。

接收用户自然语言制作指令后，将完整要求保存为 UTF-8 的 `inputs/brief.txt`；页面任务直接读取本次已有 brief。标题、强调信息和列举数量忠于实际口播与用户事实，不从字幕首中末机械抽取。

仅当用户明确要求快速模板初稿或指定模板 CLI 时，才从工程根运行下面的可选命令；它不属于默认页面流程，也不替代原版各阶段：

```sh
node deepseek/lib/produce.js --video inputs/source.mp4 --srt inputs/source.srt --brief inputs/brief.txt --output work/my-film
```

该 TypeScript 编译入口生成固定结构的模板初稿。其标题最多三十六字，可选 `要点：` 仅支持三个、每个最多十八字，省略时使用字幕摘录；这些是此可选工具的限制，不是原版 Skill 或默认工坊的制作限制。可用 `--style 教育风` 明确覆盖简报，`--preview-only` 先做抠像及可编辑预览、暂缓成片编码；参数详见工程内 `docs/user-manual.md`。有权使用的背景音乐通过 `--music inputs/music.wav --music-volume 0.08` 低音量混入，仍须检查人声清晰。人物偏心或有多人时校准 `--person-x`、`--person-y` 与 `--person-scale`；默认遮罩上半身质心只是取景启发，不能代替画面检查。

简体转换保留字幕时码，不自动翻译英文。英文字幕须先由宿主可用模型翻译成中文并核对时序；实际可见文案全部使用简体中文，品牌缩写按用户要求处理。

可选模板 CLI 输出 `final.mp4`、`index.html`、`scene.mjs`、`film.json`、人物层、输入和检查记录。选择此工具时仍按原规则检查与完善，修改后运行任务自己的 `render.mjs`。归档保留工程所需字体、依赖、工具与资产；默认原版制作不需要先生成这些模板文件。

## 可选豆包生图与背景素材

需要生成背景或图生图素材时，先读工程的 `docs/image-generation.md`，使用 aa.com.cn 的豆包 Seedream 接口。由用户在制作工程本地 `.env` 填入 `AA_API_KEY`，不要要求在聊天中粘贴 Key，不读取或输出 Key 的内容。生图使用该平台额度，沿用当前用户授权范围，不自行批量提交或将重渲染变成重复生图。

将无字背景提示词写入 UTF-8 `inputs/image-prompt.txt`，明确科技感、教育风或营销风的配色，以及标题、信息区和人物的留白。提示词要求无文字、无字母、无标志；视频内简体中文、数字和要点通过 Three.js 独立排版。

```sh
node --env-file=.env deepseek/lib/image.js --prompt inputs/image-prompt.txt --output inputs/generated/hero
```

输出须为新目录，父目录须存在；默认模型 `doubao-seedream-4-0-250828`、尺寸 `2848x1600`、最多一张。只有用户明确授权上传的本地 PNG/JPEG/WebP 才作为 `--reference`，最多 14 张；不自动上传原视频、人物层或私人素材。异步任务等待超时保存 `task.json` 后，用 `--resume --output inputs/generated/hero` 续查，只查询原任务，不重新提交付费生成。

先检查已下载图片的缩略图，将合适的本地资产用于本任务原创场景，保持简体文字与人物独立合成。显式使用模板 CLI 时也可传 `--background-image inputs/generated/hero/image-1.png`，工具会复制为影片的 `background.*` 本地资产。工程重渲染复用本地资产，不调用生图接口。完整参数、异步处理及两份官方接口文档见 `docs/image-generation.md`。

## 预览与检查

在工程根执行 `npm run serve`，打开当前工程在 `work/<任务>/` 下的实际预览页面。本地抠像与渲染复用项目 Python、Playwright 和 FFmpeg；重渲染复用已有配音、数字人与背景资产，不再次提交付费生成。

检查图片和视频时先生成缩略图、低分辨率代表帧拼图或局部裁切；只有小字、脸部或细节无法判断时才打开对应原图。宿主的 `read_image` 需要支持图片输入的模型路由；交互浏览器使用已安装且可用的浏览器插件。构图前以本任务真实帧实际试读，工具失败就准确记录未查看，不能仅因存在该工具而假定能看图。需要用户在宿主已有模型设置选择图像模型时，复用当前任务素材续检，不擅自切换路由或重做收费生成。

各阶段规则完整读到 `END_READING` 后再动手，尤其不得先写整片动画再补读 animation。按原规则实际比较完整构图中的候选字体，读取选定案例分析并查看连续动作，先验证连续样段再扩展整片。缺少实际观看、连续动作或试听能力时，按原规则标明待检查预览与具体缺口，不能用测试通过或导出成功替代成片视听验收。工坊的“已导出”只表示媒体与工程检查完成，页面保留播放下载并提示待视听确认；一次 `read_image` 成功也不能证明整片通过。

许可沿用工程 `LICENSE` 与第三方说明；未经作者事先书面授权不得商用。
