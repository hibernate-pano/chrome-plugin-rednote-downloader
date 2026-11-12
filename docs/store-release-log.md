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
