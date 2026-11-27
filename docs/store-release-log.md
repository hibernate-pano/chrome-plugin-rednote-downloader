# v1.5.0 发版记录（筹备中）

**日期**：2026-11-16
**状态**：代码已改完、验证已跑过 ✅ / **商店未上传**（下一步是 `release:zip` → upload → publish）

## 起因：不是「加功能」，是修已上架版本里的缺陷

上架 4 天，商店公开页 0 条评价（`0 out of 5` + 「no reviews」，2026-11-16 复核），
所以这一版没有用户反馈可修 —— 改成自己按两条读代码的路子找缺陷：
一条看内容脚本（面板/路由），一条看打包引擎。找到的问题都是**用户可见的错误行为**，
不是风格问题，全部有具体触发场景。

## 修了什么

面板状态（`src/content/index.ts` / `ui/panel.ts` / `detect/detector.ts`）：

| 问题 | 触发 | 后果 |
|---|---|---|
| 路由身份只比 PageKind | 账号 A 主页 → 账号 B 主页 | 面板留着 A 的卡片，下载用的是 A 的 noteId |
| 停止扫描没有取消位 | 扫描中点「停止扫描」 | 页面继续自己滚几十秒，先弹「没找到可下载的笔记」的假结论 |
| 非笔记/主页路由不清状态 | 回首页信息流再点 FAB | 面板还是上一篇笔记，按钮会把它再下一遍 |
| 笔记页三条提前 return 不重画页脚 | 识别中 / 纯文字笔记 | 页脚残留上一篇的「全部下载」，闭包持有上一篇的文件 |
| 批量 `phase` 从不置 `completed` | 批量下载完成 | 页脚里「全部下载完成 / 下载列表 / 重试失败项」这段代码从未生效 |
| 取消/重试取 `batchTaskId ?? noteTaskId` | 主页批量后再进笔记页下载 | 按「取消」没反应（打到已结束的任务） |
| 设置变更只赋值不重绘 | 面板开着去设置页改模板/主题 | 面板显示旧文件名，落盘用新模板 |

打包引擎（`src/background/downloader.ts` / `offscreen/*` / `shared/messages.ts`）：

| 问题 | 触发 | 后果 |
|---|---|---|
| 打包中点重试会再起一个包 | 300 个文件的包还在打，某文件早失败被点重试 | 两个包写同一个 OPFS 目录互相截断，整批结果被丢，界面却说全部完成 |
| 多包（>2GB）一损俱损 | 分包的其中一条下载被中断 | 已落盘的包被判失败并删除，磁盘上有 zip 界面说全失败 |
| 失败路径不清理 | `ZIP_FAILED` / 建 blob 地址失败 | OPFS 里留最多 2GB 半成品，攒几次吃满配额，此后打包全失败 |
| 空/截断响应当成功 | CDN 对过期直链回 200 + 空 body | 包里出现 0 字节文件，面板报「已完成」 |
| 缓冲没有上限 | 第 1 项是慢的大文件 | 后面下完的全堆内存，后台页面被 OOM 杀掉，任务永远「下载中」 |
| 下载栏取消记成失败 | 用户在大 zip 的下载气泡上点取消 | 报「N 个文件下载失败」，错误还是英文枚举 |

## 怎么验证的

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 干净 |
| `npm test` | **104 通过**（原有 96 + 8 条回归：多包互不连累 / 打包中拒绝重试 / 失败清理 / 空响应 / 截断响应 / 包内条目归属 / 路由身份 ×2） |
| `npm run e2e` | ui 25/25、批量 44/44、打包 18/18；真站点 2/2 后撞登录墙（游客态限制，未变） |
| `npm run release:zip` | `out/extension.zip` v1.5.0 · 86KB · 18 个文件（根目录是 `manifest.json`，无 map 无 `.DS_Store`）· sha256 `7547c2e62ed66ab3869820d2e9adab52ba60aafc3728fcc91a30f0fca031bae1` |

## ⚠️ 事故：工作目录在整个目录树里消失过一次

2026-11-16 23:09 左右，`/Users/panbo/Code/Demos/chrome-plugin-rednote-downloader`
整个目录（含 `.git`）从文件系统里消失，就在 `npm run e2e` 跑期间。
现场证据：该目录的父目录 mtime 恰好是 23:09；e2e 拉起的 Chrome 进程 cwd 仍指向它（inode 还在，名字没了）；
`~/.Trash` 为空；本地 APFS 快照只有 13:25 那份（需要 root 才能挂载，没挂）。

处理：`git clone` 回同一路径（HEAD = `45aca53`，与消失前一致，工作树当时是干净的），
然后把本次全部改动按原样重新落盘，重跑 typecheck / 单测 / e2e 全部通过后才提交。
**没有查出是谁删的**（不是我执行的任何命令：本次会话没有对仓库路径做过删除操作）。
以后在这个环境下干长活，先提交再跑长测试。

## 🔧 一处必须记住的坑（下次发版会踩）

`~/.config/chrome-web-store/credentials.env` 里的 `ITEM_ID` 是
`llicfmiagjiknidigpdcnogfeheogpfd` —— 那是 **漫画翻译助手** 的 id（2026-11-16 用公开页核对过标题）。
本扩展的 id 是 `lkbaggcclpoclohncmdfaicjepaplgje`。

`cws-release.mjs` 只认 `--item-id` / `CWS_ITEM_ID` 环境变量，不读这个文件的 `ITEM_ID`，
但**别 `source` 这个文件**：一旦它变成 `CWS_ITEM_ID` 就会被当成目标 item ——
上传会把本扩展的 zip 推到别人的条目上。发版时把 id 写在命令行里。

---

# v1.4.0 发版记录

**日期**：2026-11-12
**状态**：GitHub 已发布 ✅ / Chrome 商店 **已上架** ✅（2026-11-12 21:15 公开页实证 `Version 1.4.0 / Updated November 11, 2026`）

## 已完成

| 步骤 | 结果 |
|---|---|
| 合并 `fix/2026-11-12-bugs` → `master`（--no-ff） | ✅ `1b41e40` |
| 版本号 1.3.2 → 1.4.0（package.json + manifest.json） | ✅ `c85c371` |
| 商店文档（版本历史 / 变更说明 / 检查清单） | ✅ 同提交 |
| 构建产物 `out/extension.zip` | ✅ 85KB / 18 项 / 无 map 无 .DS_Store |
| 验证 | typecheck 干净 · 单测 105 · e2e-ui 25 · e2e-zip 18 · e2e-batch 44 |
| tag `v1.4.0` | ✅ 已推送 |
| `master` 推送 origin | ✅ `9f35ff1..c85c371` |

## ⚠️ 一处更正（留下痕迹）

14:20 那一版台账里我写过「这个扩展从没在商店建过 item，API 只能更新不能创建」——**这是错的**。
1.3.2 早在 2026-10-26 就上过商店了。

错因：我拿公开商店搜索页搜到的**同名扩展**（slug 撞了）试 API 得 403，就推断「账号名下没有这个扩展」。
403 只说明「这个 id 不在你名下」，推不出「你名下没有任何 item」。而 Chrome 商店 v1.1 **没有 item 列表端点**、
v2 那个路径 404 ⇒ API 根本列不出来，只能去 dashboard 看。

这次没有做**对照实验**（拿一个确定存在的对象试同一个端点），也没有先问一句。
以后查外部服务：403/404 只说明这条路径查不到 —— 见 `~/.config/alma/skills/external-service-probe/SKILL.md`。

---

## Chrome 商店

item id：`lkbaggcclpoclohncmdfaicjepaplgje`（由 Jasper 提供）

| 步骤 | 证据 | 结论 |
|---|---|---|
| 上传前基线 | 草稿 `crxVersion=1.3.2`、公开页 `Version 1.3.2 / Updated October 26, 2026` | 线上还是 1.3.2 |
| upload | 「✓ 上传成功（1.4.0）」；**回读草稿 `crxVersion=1.4.0`** | 包进草稿了 |
| publish | `status:["OK"]`，且发布前自检「草稿 crxVersion=1.4.0（期望 1.4.0）」通过 | 已提交审核 |
| verify | HTTP 400 `You may not edit or publish an item that is in review` | **确实进了审核队列** |
| live 复核（提审当时） | 公开页仍是 `1.3.2 / October 26, 2026` | 当时还没放行，等审核 |
| **live 复核（2026-11-12 21:15）** | 公开页 `Version 1.4.0 / Updated November 11, 2026` | **审核已放行，1.4.0 已上架** |

> `uploadState` 一直是 `NOT_FOUND` —— 它在上传成功后也是这个值，**不能拿它当成功判据**。
> 真正的判据是草稿 `crxVersion` 变成了 1.4.0。
>
> 「in review」的歧义（可能是在审上一版 vs 这一版）已排除：
> 草稿 crxVersion 正是要发的 1.4.0，且公开页仍是 1.3.2 ⇒ 在审的是这一版。

产物：`out/extension.zip`，sha256 `350878a5eef8e088d13c28c0b2d810e04b05842152ceb68bd32e1de3bb7d6b35`，85KB / 18 项。
构建产物比源码新（`find src public -newer` 为空），不是旧包。

### 审核放行后要做的

- [x] 公开页 `Version` 变成 1.4.0（2026-11-12 21:15 实证）
- [x] 公开页 `Updated` 变成 November 11, 2026
- [x] 台账把「已提交审核」改成「已上架（公开页 Version 1.4.0）」
- [x] README 的商店徽章 / 版本号 —— 查过了，README 里没有写死旧版本号，无需改

### 仍需人工做（API 没有对应端点，只能 GUI）

1. **商店素材上传**：`out/store/promo-440x280.png`、`screenshot-note.png`、`screenshot-batch.png`
2. **商店表单字段**：文案已全部写好，照抄 `docs/store-listing.md` 即可

## 另外还欠两样（都在 dashboard 里手动做，API 没有对应端点）

1. **商店素材上传**：`out/store/promo-440x280.png`、`screenshot-note.png`、`screenshot-batch.png`
   —— API 没有 listing 资产端点，只能 GUI 传。
2. **商店表单字段**：全部文案已经写好，照抄 `docs/store-listing.md` 即可。
