# 豆包生图与视频背景

Agent Motion 可通过 aa.com.cn 的豆包 Seedream 接口生成背景或参考素材，再以本地图片加入 Three.js 影片。生图会消耗该平台账户额度；人物抠像、字幕合成与重渲染仍在本地执行。账号、API Key 与额度由使用者自行配置。

接口依据：[豆包图片生成文档](https://api-doc.aa.com.cn/zh/docs/api/ai-model/image/doubao/post-api-v1-image-generation-435372888)与[图像异步任务查询文档](https://api-doc.aa.com.cn/zh/docs/api/ai-model/common/2452c2cfe2f61db1a64dd1203a5142e7)。插件使用 `POST https://api.aa.com.cn/api/v1/image/generation` 提交，必要时通过 `GET https://api.aa.com.cn/api/v1/task/{task_id}` 查询；认证为 `Authorization: Bearer <AA_API_KEY>`。

## 配置 Key

在制作工程根目录新建本地 `.env`，由你在编辑器中填入自己的 Key：

```dotenv
AA_API_KEY=在本地填写你的APIKey
```

不要在聊天中粘贴 Key，也不要将 `.env` 放到 `inputs/`、成片归档或提交到 Git。以下命令从制作工程根执行，使用 Node.js 22.x 或 24.x 的 `--env-file=.env` 读取配置。已有 `AA_API_KEY` 环境变量也可直接使用。

## 文生图

将 UTF-8 提示词保存为 `inputs/image-prompt.txt`，先创建 `inputs/generated/` 父目录。示例提示词：

```text
十六比九专业科技口播视频背景，深海军蓝与克制的薄荷绿光线，
右侧留出人像区域，左侧大面积低细节留白用于标题和信息图，
远景有柔和空间层次，画面干净，无人物、无文字、无字母、无标志。
```

让生图负责画面素材，标题、字幕、数字与要点由 Three.js 叠加，以保证简体中文正确、清晰且可编辑。建议提示词控制在 300 个汉字以内；明确留白位置，避免背景纹理干扰正文。

```sh
node --env-file=.env deepseek/lib/image.js --prompt inputs/image-prompt.txt --output inputs/generated/hero
```

`hero` 必须是尚不存在的新目录。默认模型为 `doubao-seedream-4-0-250828`，默认尺寸 `2848x1600`，默认最多生成一张。成功后图片保存为 `image-1.png`、`image-1.jpg` 或 `image-1.webp`，以实际返回格式为准；多图依次编号。终端给出实际保存路径。

| 参数 | 用法 |
| --- | --- |
| `--model` | `doubao-seedream-4-0-250828`、`doubao-seedream-4-5-251128` 或 `doubao-seedream-5-0-260128`。 |
| `--size` | 宽高像素，例如 `2848x1600`；该尺寸符合三个模型的十六比九推荐规格。不同模型有各自的总像素和宽高比限制。 |
| `--max-images` | 1–15，表示本次请求的图片数量上限，实际张数由服务返回。 |
| `--watermark` | 启用服务提供的生成图片水印。 |
| `--reference` | 本地 PNG、JPEG 或 WebP；可重复传入，最多 14 张，详见下例。 |
| `--resume` | 从指定既有目录的 `task.json` 续查任务；不重新提交生成请求。 |
| `--timeout-seconds` | 总等待时限，默认 600 秒，支持 1–3600 秒；达到时限后保留任务记录。 |

例如选择 4.5 模型、最多两张：

```sh
node --env-file=.env deepseek/lib/image.js --prompt inputs/image-prompt.txt --output inputs/generated/hero-v2 --model doubao-seedream-4-5-251128 --size 2848x1600 --max-images 2
```

客户端固定使用非流式请求 `stream: false` 与下载链接返回 `response_format: "url"`。生成链接有时效，完成后即下载到本地；后续影片与重渲染使用本地图片。

## 图生图

用户明确提供并授权上传的参考素材，才通过 `--reference` 发给服务。插件将这些图片编码后上传；不会自动把原片、人物抠像结果或工作区中的私人素材作为参考。

```sh
node --env-file=.env deepseek/lib/image.js --prompt inputs/image-prompt.txt --output inputs/generated/reference-scene --reference inputs/reference-1.png --reference inputs/reference-2.jpg
```

接口最多接收 14 张参考图；单图不超过 30 MB，总像素不超过 3600 万，宽高均大于 14 像素，宽高比在 1/16–16 之间。实际模型与账号限制以官方文档和服务返回为准。

## 续查已有任务

异步任务默认最多等待 600 秒，可用 `--timeout-seconds` 调整。等待超时会保留 `task.json`，其中记录任务 ID、状态、返回链接、使用量和已保存文件。使用原目录续查，避免再次提交同一付费请求：

```sh
node --env-file=.env deepseek/lib/image.js --resume --output inputs/generated/hero
```

续查只发送任务查询 GET，不重新 POST 生图。若提交阶段断网且未取得任务 ID，先在平台控制台核对任务与额度，再决定是否以新目录重新提交。报错或部分下载保留供诊断；不要通过删除任务记录来处理等待超时。

## 加入视频

先检查生成图片的缩略图或局部裁切，再按实际文件后缀指定背景，例如：

```sh
node deepseek/lib/produce.js --video inputs/source.mp4 --srt inputs/source.srt --brief inputs/brief.txt --output work/my-film --background-image inputs/generated/hero/image-1.png
```

图片会复制为影片目录内的 `background.*` 资产，进入 Three.js 背景层；标题、简体中文字幕和人物仍由工程独立合成。制作与检查继续遵循原 SRT 分析和 Motion Craft 规则，包括换背景时的人物描边、取景、空间层次与原声同步。

编辑影片后，运行 `node work/my-film/render.mjs` 使用已保存资产重新渲染，不联网重新生图，不重复产生生图费用。归档时保留生成图片、任务记录与影片引用资产，移除本地 Key 配置。

## 当前验证范围

接口适配依据上述官方文档，自动检查使用模拟响应验证提交、异步查询、下载和错误处理，未以付费请求验证真实生成质量。首次实际生成后仍需检查画面、留白、纹理和版权适用范围，再用于最终影片。
