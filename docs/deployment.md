# 部署说明

本说明部署 Agent Motion 1.2.0 的 TypeScript Cordis 插件及独立视频制作工程。宿主适配基线为 `@deepseek-ai/dsh@0.2.0-rc.2`；插件入口是 `deepseek/lib/index.js`，源文件位于 `deepseek/src/`。

## 准备与构建

需要 Node.js 22+、npm、可下载依赖的网络；Harness 的插件管理另需要 PATH 中可用的 pnpm。模型服务由 Harness 自行配置。克隆或完整解压项目，在项目根运行：

```sh
npm ci
npm run build
npm test
npm run test:plugin
npm run package:check
npm pack
```

构建使用 TypeScript 5.9.3、ES2022 模块和严格类型检查，产物位于 `deepseek/lib/`，可由 Node 直接加载。`test:plugin` 运行插件与管线检查。打包前的 `prepack` 自动构建，生成 `agent-motion-1.2.0.tgz`；包里保留原 Skills、三种模板、工具脚本、字体与编译输出。无需消费者在安装时运行 Git `prepare`。

发布 GitHub 源码时同时提交更新的 `deepseek/lib/`，才能直接从 GitHub 安装。不要提交 `node_modules/`、`.runtime/`、`.venv/`、用户输入或制作历史。发布前检查实际 `npm pack` 文件列表及 [第三方许可](../THIRD_PARTY_NOTICES.md)。

Windows 的 PowerShell 包装脚本可能吞掉 npm 命令中的 `--` 参数。因此携带业务参数的安装、诊断、抠像和生产命令统一直接执行 `node` 脚本；上述无业务参数的 npm 构建命令也可使用 `npm.cmd`。

## 安装到 Harness Web

先生成官方完整 Web profile；随后安装 tarball 并确认 bundle 层：

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 web --dump-config
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "/absolute/path/to/agent-motion-1.2.0.tgz"
npx @deepseek-ai/dsh@0.2.0-rc.2 --profile web --dump-config
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

Windows 可将包路径替换为 `C:/packages/agent-motion-1.2.0.tgz`。配置输出应出现 `# == agent-motion`、`id: agent-motion` 和 `name: agent-motion`，profile bundle 列表应保留官方 base、web-app 及 agent-motion。Web 默认监听 `http://127.0.0.1:3080`；模型凭据和路由继续在 Harness 配置。安装或替换包后重启既有 Web 进程。

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

## 准备独立制作工程

在安装包外创建一个新目录，父目录须已存在。插件入口 Skill 会解析安装包的资源路径，也可手动执行：

```sh
node "/absolute/path/to/plugin/deepseek/create-workspace.mjs" "/absolute/path/to/projects/my-film"
cd "/absolute/path/to/projects/my-film"
node scripts/bootstrap.mjs
node scripts/doctor.mjs --matting --json
```

初始化会复制已编译生产 CLI、`scene.mjs`、全部模板、原始制作 Skills、脚本和字体，创建 `work/`，并生成匹配的生产锁文件。工程不需要 Harness 或 TypeScript 开发依赖，也不运行 `build`/`prepack`。已有目录和符号链接会被拒绝；部分失败工程保留供诊断，修复后换新目录，勿覆盖素材。

`bootstrap.mjs` 准备工程内 Node 依赖、隔离 Python、Chromium、FFmpeg/ffprobe 和 RVM 模型，再做环境与短片抠像检查。下载和缓存保存在 `.runtime/`、`.venv/`；模型、浏览器和运行环境不随 tarball 打包。首次安装需要联网，CPU 抠像不要求独立显卡，但速度取决于视频长度、分辨率和机器。

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

归档时保存完整制作工程根目录及其依赖、字体、素材和人物层；单独复制 `work/my-film/` 不足以重新渲染。迁移到另一平台时保留工程与锁文件，在目标机器重新准备平台运行环境。
