# MiniGitWeb

基于 Web 的 Git 仓库管理工具，提供简洁直观的界面来管理您的 Git 仓库。零依赖，单文件前端 + Node.js 后端。

## 功能特性

### 📂 仓库管理
- **仓库挂载**: 输入仓库绝对路径快速挂载（自动校验是否为 Git 仓库）
- **快捷切换**: 已挂载的仓库自动保存，一键切换
- **路径历史**: 服务端记录最近 20 条路径，方便选择

### 🔧 Git 操作
- **Status**: 查看仓库状态，显示修改 / 暂存 / 未跟踪文件
- **Add**: 弹窗选择文件加入暂存区；支持按分组全选 / 反选；无可加入文件时「加入暂存区」自动禁用；操作后弹窗保持打开并刷新列表
- **Reset（取消暂存）**: 在 Add 弹窗中取消已暂存文件；无暂存文件时「取消暂存」自动禁用
- **Push**: 自动 commit 并推送；新分支自动创建远程分支并建立追踪（`git push -u`）；弹窗实时提示本地是否有未推送提交 / 未提交改动
- **Pull**: 拉取远程最新代码
- **Stash**: 暂存工作区修改，支持保存 / 恢复 / 删除 / 清空
- **Branch**: 分支管理，支持创建 / 切换 / 删除分支

### 🎨 界面特性
- **响应式设计**: 适配桌面端和移动端
- **主题切换**: 深色 / 浅色主题，提示文字保持高对比度
- **操作历史**: 记录最近 50 条操作，支持点击回填路径、清空
- **控制台输出**: 实时显示 Git 命令执行结果
- **全屏模式**: 控制台全屏显示；全屏下提供浮动操作栏（淡入 / 滑入动画，打开弹窗时自动隐藏）
- **统一弹窗**: 弹窗层级高于全屏层，全屏下同样正常显示与操作

### 📱 移动端优化
- **折叠面板**: 仓库目录和操作按钮支持折叠
- **触摸友好**: 按钮大小适合移动端点击

## 快速开始

### 前置要求
- Node.js 14+（推荐 16+）
- 系统已安装 `git` 并可在 PATH 中调用
- 无需任何 npm 依赖

### 安装

```bash
git clone https://github.com/yzp531/MiniGitWeb.git
cd MiniGitWeb
```

### 运行

```bash
cd server
node index.js
```

默认监听 `0.0.0.0:3456`，可通过环境变量修改端口：

```bash
GIT_WEB_PORT=8080 node index.js
```

访问 http://localhost:3456 即可使用。

默认账号：`admin` / `admin@123`，请在生产环境修改 `server/index.js` 中的登录校验。

## 使用说明

1. **登录**: 输入用户名和密码登录系统
2. **挂载仓库**: 在「仓库目录」输入框中输入 Git 仓库的绝对路径，点击「挂载」
3. **执行操作**: 挂载成功后，点击相应的操作按钮（Status、Add、Push 等）
4. **全屏**: 点击控制台右上角 ⛶ 进入全屏，右侧浮动栏提供快捷操作
5. **切换仓库**: 点击快捷路径中的仓库名称即可快速切换

## API 说明

所有 `/api/git/*` 接口需登录鉴权（HttpOnly Cookie `token`，或请求头 `Authorization: Bearer <token>`）。请求体为 JSON，Git 操作接口需带 `path` 字段。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | 登录，下发 token Cookie |
| POST | `/api/auth/logout` | 退出登录 |
| GET / POST / DELETE | `/api/history` | 路径历史：查询 / 新增 / 删除 |
| POST | `/api/git/validate` | 校验路径是否为 Git 仓库 |
| POST | `/api/git/status` | 仓库状态（含 ahead / behind / dirty / 上游信息） |
| POST | `/api/git/add` | 暂存文件（`files` 可选，缺省执行 `git add .`） |
| POST | `/api/git/reset` | 取消暂存 |
| POST | `/api/git/pull` | 拉取远程代码 |
| POST | `/api/git/push` | 自动 commit + push，新分支自动 `-u` 建立追踪 |
| POST | `/api/git/stash` | stash 列表 / 保存 / 恢复 / 删除 / 清空 |
| POST | `/api/git/branch` | 分支列表 / 创建 / 切换 / 删除 |

## 项目结构

```
MiniGitWeb/
├── index.html          # 前端单文件（内联 CSS / JS）
├── favicon.svg         # 网站图标
├── server/
│   ├── index.js        # 后端服务（HTTP 服务 + Git 调用）
│   └── package.json
├── README.md
├── AGENTS.md
└── git.md
```

> 说明：仓库中的 `script.js`、`style.css` 属于同服务器上的壁纸站，与 MiniGitWeb 无关。

## 部署

### 直接运行

```bash
cd server
node index.js
```

### PM2（推荐）

```bash
pm2 start server/index.js --name git-web
pm2 restart git-web    # 后端代码变更后需重启
pm2 save
```

> 注意：`index.html` 为静态文件，修改后即时生效；修改 `server/index.js` 后必须重启后端进程才会生效。

## 安全说明

- `server/tokens.json`、`server/path-history.json` 已在 `.gitignore` 中，不会提交到版本控制
- 默认账号密码为弱口令，生产环境请务必修改
- 建议通过 Nginx 反向代理并配置 HTTPS，限制访问来源
- 服务端执行 Git 命令时已禁用交互式输入（`GIT_TERMINAL_PROMPT=0`）

## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request！

## 联系方式

如有问题或建议，请通过 GitHub Issues 联系。
