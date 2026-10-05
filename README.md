# dsh-file-manager

给 DSH 的**文件树**补上一整套文件管理能力。配置点名的文件夹里，每个条目可以：

- **下载**（单文件；文件夹或当前根可**打包 ZIP**；多选后打包成一个 ZIP）
- **删除**（软删：移入同级 `.dsh-trash/`，二次确认写明保留期）、**重命名**、**复制移动**（一个入口里选移动还是复制）
- 多选后**批量**删除 / 下载 / 移动 / 恢复 / 彻底删除；工具栏可**新建文件夹**

`.dsh-trash/` 第一层的条目有「恢复」「彻底删除」，也能「移动」到别处（等于恢复到指定位置）；
工具栏可**清空回收站**；超过保留期的条目由宿主自动清理。

> 下载 / 打包 ZIP 部分移植自社区插件 [dsh-file-download](https://github.com/lorsabyan/dsh-file-download)
> （MIT © 2026 Aghasi Lorsabyan，见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)）；其余为原创。

## 项目结构

```
lib/index.js                   宿主半：路由、软删/恢复/彻底删除、自动清理、配置读写、审计日志
lib/client.js                  客户端半：挂按钮、弹窗、配置页（手写 bundle，不需要构建）
locale/{zh,en}.json            侧栏「插件」页那张卡片的标题与简介
cordis.patch.yml               bundle 的 patch 入口
deploy/file-manager.yml.example  配置示例
test/host.mjs                  宿主半自测（假 ctx + 真文件系统）
test/client.mjs                客户端半自测（最小 DOM + hooks 桩）
```

**展示元信息**（标题与简介）走 dsh 的官方约定：`locale/<语言>.json` 里的 `meta.title` / `meta.description`，
缺失时回退到 `package.json` 的 `name` / `description`。两个前提缺一不可：
① `package.json` 的 `exports` 必须导出 `./package.json` 与 `./locale/*.json`
（宿主用 Node 解析器读，没导出就什么都读不到 —— 侧栏卡片只剩模块名）；
② `locale/en.json` 必须存在（它是词典扫描的入口文件，但它自己不必有内容）。
改这两个文件后**刷新页面即可**（宿主每次列插件都重新读），不用重启。

两套测试都**直接加载 `lib/` 源码**（早先用的是 `test/plugin/` 里的一份副本，结果改完源码
测试还在验旧副本，跑出过一轮「假绿灯」，已删掉那份副本）。

```sh
npm i        # 只为拿 yaml（宿主半会 import("yaml")）；node_modules/ 不进 git
npm test     # = node test/host.mjs && node test/client.mjs
```

## 为什么必须有宿主半

DSH 底座**没有任何删除文件的通道**：

- `@deepseek-ai/dsh-api-workspace-files` remote 只有 `list` / `read` / `readBytes` / `stat`（只读）；
- `dsh-fs-local` 的 fs 服务没有删除原语（只有 `readText` / `readBytes` / `listDir` / `stat` /
  `lstat` / `watch` / `writeText` / `editText` / `resolve` / `withLock`）；
- 浏览器触达宿主只有 remote 与 HTTP 路由两条路，两条都不提供删除。

所以删除按钮必须自带一个宿主执行体 —— 就是 `lib/index.js`。客户端半 `lib/client.js`
只负责在行上挂按钮和弹确认框，真正的移动/删除全在宿主侧完成。

## 配置

默认在 `<DSH_HOME>/file-manager.yml`（可用 `DSH_FILE_MANAGER_CONFIG` 覆盖），**保存即生效**（宿主半每次请求比对 mtime，不用重启）。
**所有 `path` 一律绝对路径**；两种模式互斥，用 `mode` 选。

> **也可以在界面上改**：侧栏「**插件**」→ 已安装里打开 **dsh-file-manager** 卡片 → 页面中间的配置表单。
> 表单读写的就是这个 YAML（保存时宿主严格校验、先留一份 `<文件名>.bak-<时间戳>` 再原子替换）；
> 页面里点「保存」才写盘，没保存就离开 = 丢弃草稿。**配置文件本身仍是唯一真源**，ssh 手工改同样有效。

```yaml
mode: paths                  # paths（默认）| workspace
manage:                      # mode: paths：允许「管理」（删除/重命名/移动/新建）的目录清单
  - path: /srv/data/reports
    recursive: true          # true=任意深度；false=只直接子项
# workspace:                 # mode: workspace：自动覆盖**所有已注册工作区**，不用写路径
#   scope: all               # 目前只支持 all
#   recursive: true
#   disable:                 # 禁止管理的清单（相对工作区根；规则见下方两条）
#     - .git
#     - node_modules
#     - docs/tmp
auto_cleanup: true           # false = 关掉自动清理：回收站只增不减，只能人工「彻底删除 / 清空回收站」
row_show:                    # 行上显示哪些：size / mtime / trash / download（默认只有 download）
  - download
toolbar_show:                # 工具栏显示哪些（默认全显示；不勾的项就不出现）
  - multi                    # 多选
  - mkdir                    # 新建文件夹（含"在选中文件夹下新建"）
  - zip_root                 # 打包根目录
  - empty_trash              # 清空回收站
  - download                 # 下载（选中后）
  - delete                   # 删除（选中后）
  - rename                   # 重命名（选中后）
  - restore                  # 恢复（选中回收站条目后）
  - purge                    # 彻底删除（同上）
  - move                     # 复制移动
  - clear                    # 清空选择
cross_workspace: true        # 关掉 = 移动/复制/新建**只能落在当前工作区之内**（写入时才校验）；默认 true
retention_days: 7            # 进回收站后保留几天（auto_cleanup: false 时不生效）
cleanup_interval_hours: 6    # 自动清理的检查间隔（同上）
trash_dirname: .dsh-trash    # 回收站目录名（每个根各一个）
```

**`row_show` 四项的含义**（顺序无关；行上从右往左排 `download / trash / mtime / size`）：

| 取值 | 显示什么 |
|:--|:--|
| `download` | 文件行「下载」、目录行「打包 ZIP」（**默认项**） |
| `trash` | 「删除」按钮。**只管删除**：回收站里的「恢复 / 彻底删除 / 移动到…」不受它影响（不在那四项里） |
| `mtime` | 修改时间，**绝对时间** `2026-10-04 12:30`（浏览器本地时区）；文件与目录都有 |
| `size` | 文件大小（`4.2KB`）。**只对文件**——上游不给目录大小，目录只显示时间 |

- 元信息与**管理类按钮**同一套权限判定：只在允许管理、且没被 `disable` 命中的行上显示。
  ⚠️ **下载 / 打包 ZIP 是例外**：跟上游一样，**任何行都能下载**（包括 `disable` 命中、允许根之外的位置）——
  它不是"管理动作"，本插件也从不把自己当权限边界（见「安全边界」）。
- 取数按**目录**批量（`GET /api/file-manager/info`）：进入（行首次出现 / 目录展开）时每目录取一次；
  点文件树自带的**重新读取**按钮后重取；我们自己的删 / 改 / 移 / 建之后自动失效。
  每目录最多 2000 条（与上游列目录的 `maxEntries` 默认值一致）。
- ⚠️ **默认只显示下载**：升级后若想看到「删除」，要在配置里把 `trash` 加进 `row_show`（配置页里有勾选框）。

**`toolbar_show`（工具栏显示哪些）**：默认**全显示**（= 历史行为）；不勾的项就不出现在工具栏上，
配置页里是一组勾选框。全不勾 = 工具栏空着（Esc 仍能退出多选）。
`zip_root`（打包根目录）**默认带二次确认**：整棵打包可能很久，点一下先问「打包并下载这个根目录？」，确认后才开跑。

- **没有 `base` 了**：写相对路径会被跳过并给 warning；旧键 `base` / `allow_delete` 一律忽略 + warning。
- 两个模式的段只能有一个生效；另一个会被忽略并给一条 warning。
- `mode: workspace` 的根来自 dsh 的**工作区服务**（`workspaceRegistry`）：换/加工作区不用改配置（拿不到服务时只 warning、不产生根、不崩）。
- `disable` 命中的位置：客户端不挂按钮，宿主端所有写操作 403（删 / 改 / 移 / 建 / 复制一律挡）。
- **`cross_workspace`（跨工作区，默认 `true`）**：**只管写入** —— 关掉后，「移动到… / 复制到… / 新建文件夹」
  的目标只能落在**当前文件树所在的工作区**之内，越界一律 403；开着则不限制（只要是某个允许根）。
  **浏览不受它影响**：选目录器随时能看任何目录、也能跳转到任何允许根（弹窗里那行「跳转工作区：★ 当前 / 📁 其它」）。
  这样"看"和"落笔"分开：浏览不拦人，落点才校验（校验内容 = 允许根 + 回收站例外 + `disable` + 跨工作区边界）。
  背景：上游 `remote.workspaceFiles` 的**目录浏览**被锁在会话工作区内（读单文件反而允许出界），
  所以选目录走插件自己的 `/browse`（只读、不设限）。
- **`disable` 的规则语义**（对齐 `.gitignore` 的直觉，两侧同判定）：
  - **不含 `/`** = 匹配**任意深度**上的同名路径段：`.git` 既挡 `<根>/.git`，也挡 `<根>/子项目/.git` 及其内部全部内容，
    `node_modules` 同理；
  - **含 `/`** = 锚定在工作区根上的多级路径：`docs/tmp` 只挡这一个位置，别处的 `其他/tmp` 不受影响。

## 按钮规则（宿主与客户端各判一遍，规则一致）

> 行上显示哪些由配置 **`row_show`** 决定（默认只有「下载 / 打包」）；下表是"可显示"的集合。
> 「删除」按 `trash` 项开关，「下载 / 打包」按 `download` 项；**回收站行的恢复 / 彻底删除 / 移动到… 不受开关影响**。

| 位置 | 行内按钮 | 工具栏（勾选后） |
|:---|:---|:---|
| `manage` / 工作区里的普通条目 | 「删除」（移入同级 `<trash_dirname>`，二次确认写明保留期） | 「重命名」；**「复制移动」**（弹窗顶部选移动还是复制；目标同名文件夹会合并）；**选中单个文件夹时「新建文件夹」= 建在它下面**；**没选中时**弹「选路径 + 填名字」的窗口（和「移动到…」同一种目录浏览），可先浏览到任意允许目录再建；批量 |
| 回收站里**任意深度**的条目 | 「恢复」「彻底删除」「移动到…」（= 恢复到指定位置） | 同上，可批量 |
| 回收站**目录本身** | 视图所在根自己的那个：不给按钮；**视图之内、更内层工作区**的回收站：给「删除」 | — |
| `.meta.json` / `disable` 命中 / 视图外 | **只给「下载」（目录则「打包」）**，不给任何管理动作 | — |

- **"纯容器"**（只为镜像结构存在、本身不是被删条目的目录）与"被删的目录"按钮相同：
  「恢复」= 把它覆盖的每个删除单元各自搬回原位；「彻底删除」= 全部真删（二次确认）。
- 回收站里的条目**不支持改名**（会让记录失效）；要改名就先恢复出来。

## 审计日志

所有**会改东西**的动作都会往 `<DSH_HOME>/file-manager.log` 追加一行 JSONL（`ts` / `action` / `path` / …），
用来回答"这条不见了，是我删的还是自动清的"——`purge` / `清空回收站` / 自动清理 三处是**永久删除**，事后只能靠它查证。

```
{"ts":"2026-10-04T12:34:56.789Z","action":"trash","path":"/srv/data/reports/x.md","stored":"x.md","trashDir":"/srv/data/reports/.dsh-trash","result":"ok"}
{"ts":"…","action":"auto-cleanup","removed":3,"retentionDays":7,"trashDirs":["/srv/data/reports/.dsh-trash"],"result":"ok"}
```

- 记录的动作：`trash` / `restore` / `purge` / `move` / `copy` / `rename` / `mkdir` / `empty-trash` / `auto-cleanup` / `settings`。
- 路径可用 `DSH_FILE_MANAGER_LOG` 覆盖（测试就是这么隔离的）；超过 4 MiB 自动轮转成 `<文件名>.1`（只留一代）。
- 写日志失败**绝不影响**主流程。
- 另外：回收站的 `.meta.json` **损坏时不再静默当空**（那会把整份记录覆盖掉、条目变成只能"彻底删除"的孤儿），
  而是改名留证成 `.meta.json.corrupt-<时间戳>` 并记一条 error 日志。

## 回收站布局、同名冲突与元数据

回收站是**镜像布局**：`<root>/<trash_dirname>/<原相对路径>` —— **不看元数据也能看出出处**
（`A/.dsh-trash/B/日报/x.md` 一眼就是"从工作区 B 的 日报 里删的"）。

- **恢复时目标已有同名文件夹 → 递归合并**（决策 M2：文件夹只是容器，你要的是里面的文件）：
  逐层"目标没有就搬进去、两边都是目录就继续往下、遇到真正的同名项就给**搬过去的那一份**加时间戳后缀"；
  现有文件一个字节都不会被覆盖。非目录的重名（文件↔文件、文件↔目录、目录↔文件）同样给搬过去的那一份加后缀；
- 回收站**镜像落点**的同名冲突只给基名加时间戳后缀（`日报.20261003123000`），父级镜像不变；
- 恢复**绝不覆盖**：目标已存在就同样加时间戳后缀；
- `.meta.json` 以**落点路径为键**，记录 `{key, stored, type, deletedAt, size}`：`key` 是原相对路径，`stored` 是实际落点（冲突时不同）；
- **任意深度**的恢复/彻底删除：先找覆盖它的**最深记录**，用 `key` + 剩余部分反推原路径；
- 自动清理**按记录**走（一条记录 = 一个删除单元，按 `deletedAt` 判过期），磁盘上无记录覆盖的对象按 **mtime** 兜底，最后剪空容器（**被删目录本身绝不剪**）。

## HTTP 路由

全部注册在 Connection 的 fetch 围栏内（Host/Origin fence + 浏览器会话），与全站其余路由同一道门，
本插件不重复实现鉴权。

| 方法 | 路径 | 作用 |
|:---|:---|:---|
| GET | `/api/file-manager/config` | 客户端读：允许的根（realpath + 声明路径）、保留天数、自动清理开关、回收站目录名 |
| GET | `/api/file-manager/settings` | **配置页读草稿**：配置文件路径、mtime（保存时的并发栅栏）、当前草稿、生效值、起点建议 |
| POST | `/api/file-manager/settings` | **配置页保存**：`{config,mtimeMs}` → 严格校验 → 备份 → 原子替换（400 中文原因 / 409 被别处改过） |
| GET | `/api/file-manager/browse?path=&view=` | **选目录**（配置页「浏览…」+ 移动/复制弹窗共用）：只列该目录的**直接子目录**；**只读不设限**，另回 `roots`（可跳转的允许根，带 `current` 标记）与 `suggests` |
| GET | `/api/file-manager/info?dir=` | **行元信息**：该目录直接子项的 `size`（仅文件）与 `mtimeMs`（文件与目录）；权限口径与行按钮一致（允许根 + `disable`） |
| POST | `/api/file-manager/trash` | `{path}` → 移入回收站 |
| POST | `/api/file-manager/restore` | `{path}` → 移回原相对路径 |
| POST | `/api/file-manager/purge` | `{path}` → 真删除（仅限回收站内条目） |
| POST | `/api/file-manager/move` | `{path,targetDir}` → 移动到允许范围内的另一个目录（同名自动加修改时间） |
| POST | `/api/file-manager/copy` | `{path,targetDir}` → **复制**到允许范围内的另一个目录（重名给副本加时间戳后缀；源保持不动） |
| POST | `/api/file-manager/rename` | `{path,name}` → 改名（同名**报错**；回收站里的条目一律拒绝） |
| POST | `/api/file-manager/mkdir` | `{parent,name}` → 新建文件夹（同名报错） |
| POST | `/api/file-manager/empty-trash` | `{root?,view?,dryRun?}` → 清空回收站：**连 `<trash_dirname>` 目录与 `.meta.json` 一起删掉**（下次删除会重建）；`dryRun` 只回报"将删除多少、按哪个范围"，不删；缺省清所有允许根，带 `view` 只清「视图根 + 视图内的嵌套根」 |

出错一律返回 `{ok:false, error:"中文说明"}` + 4xx。

## 安全边界（重要）

**这里不是权限边界。** 目标目录本来就能被持有 Web 链接的人读写，持链接者本来就能
经 `remote.workspaceFiles` 读任意工作区文件。本插件的职责是**防误删**：

1. 只允许配置点名的文件夹，每条路由都重新做 `lstat` + `realpath` 校验，
   父目录的 realpath 必须落在允许范围内（允许范围内的符号链接指向外部 → 直接拒绝）；
2. 深度受该项 `recursive` 约束；
3. `.dsh-trash` 自身、`.meta.json` 一律拒绝；回收站必须是**真目录**，被换成符号链接就拒绝写入；
4. 递归删除**绝不跟随符号链接**：自己实现 `lstat` + `unlink`，只对真实目录递归
   （不复用 `fs.rm`，把语义写死）；
5. 移动用 `rename`，符号链接只搬链接本身，不跟随；
6. 配置读不到 / 解析失败 → 一个按钮都不挂（fail-safe），并拒绝所有删除请求。

## 安装

这是个标准的 dsh 插件包，两种装法：

```sh
# ① 用 dsh 自己的插件管理器（本地目录或打包好的 tgz 都行）
dsh plugin add /path/to/dsh-file-manager

# ② 手工放进某个 profile：把包拷进它的 node_modules，并在 profile 的 dsh.profile.bundles 里登记
cp -r dsh-file-manager <profile>/node_modules/
# 然后编辑 <profile>/package.json，把 "dsh-file-manager" 加进 dsh.profile.bundles
```

- **新增 bundle 要重启一次 dsh**（可加载的模块解析表在启动时冻结，热重组拿不到新包）；
- **只改 `lib/client.js` 不用重启**：覆盖文件后刷新页面即可（启动清单是每请求现生成的）；
- 配置放在 `<DSH_HOME>/file-manager.yml`（可用 `DSH_FILE_MANAGER_CONFIG` 覆盖），格式见
  `deploy/file-manager.yml.example`。**保存即生效，不用重启**。界面上也能改：侧栏「插件」→ 本插件卡片；
- 配置文件建议 **644**：里面只有路径与保留天数这些，不含密钥。

## 已知脆弱点

1. **新增 bundle 不能只靠热重组**。可加载的模块解析表在启动时算好并 `Object.freeze`，新包不在表里就永远解析不到：
   客户端半**正常**（启动清单每请求现生成），宿主半的路由却全 404。**唯一解**是重启 dsh。
2. **宿主半必须显式声明 `inject`**。cordis 只在 `export const inject = ["connection"]` 之后才允许访问服务代理；
   少了这一行 `apply()` 直接失败、整行不激活（日志里只有一行 `warning: 1 entry did not activate`，很容易漏看）。
3. 客户端半是手写 bundle（`window.__ModuleLoader__.load`），改完**不需要构建**；client-hmr 会按文件 mtime 热替换。
4. **`inject` 写的是服务名（或插件名），而且客户端半要自己导出它**：
   名字必须是真实存在的服务（本插件客户端只要 `slots`）；只在 `package.json` 的 `dsh.client.inject` 里写**不够**，
   bundle 本身也要导出（`module.exports = { apply, inject: ["slots"] }`），否则一碰 `ctx.slots` 就是
   `cannot get property "slots" without inject`，整页停在「Failed to load plugins」。
   **改 `dsh.client.inject` 必须重启**（模块元信息被缓存在内存里且从不失效）。
5. **按钮 / 行内元信息的几何必须走行内样式**：别的插件样式表里的复合选择器优先级可能高于我们的
   `button[data-dsh-file-manager]`，会把按钮的内容盒压成 0（图标完全看不见，但按钮还在、还能 hover 出提示）。
   所以几何写进行内样式；`svg` 另加 `flex:0 0 auto` 防止被压扁。
6. **回收站镜像布局 + "把回收站搬进自己"**：从外层视图删内层工作区的回收站时，落点必须算在**外层视图根**的回收站里；
   算不出来就拒绝（否则会 `rename` 到自己里面 → EINVAL）。
