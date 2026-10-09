---
name: agent-motion
description: 在 DeepSeek Harness 中用 Three.js 制作或修改动效视频、MG、真人口播包装；从原片、完整 SRT 和制作要求开始，准备独立工程并进入 Motion Craft 制作流程。
---

# Agent Motion · DeepSeek Harness

本 Skill 是插件入口。制作规则以本项目的 Motion Craft 和 SRT 与参考驱动制作 Skill 为准；沿用宿主的文件、bash/pwsh、图片及浏览器能力。

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

真人口播必须先完成同步人物层与实际检查，保留原始口播顺序、声音和时间。按原规则完成素材、构图、连续动画、声音、复查，交付 MP4 与可编辑工程。

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

在工程根执行 `npm run serve`，打开当前工程在 `work/<任务>/` 下的实际预览页面。本地抠像与渲染复用项目 Python、Playwright 和 FFmpeg，不依赖付费生成服务；可选背景生图另走上述接口。

检查图片和视频时先生成缩略图、低分辨率代表帧拼图或局部裁切；只有小字、脸部或细节无法判断时才打开对应原图。宿主的 `read_image` 需要支持图片输入的模型路由；交互浏览器使用已安装且可用的浏览器插件。缺少实际观看、连续动作或试听能力时，按原规则标明待检查预览与具体缺口，不能用测试通过或导出成功替代成片视听验收。

许可沿用工程 `LICENSE` 与第三方说明；未经作者事先书面授权不得商用。
