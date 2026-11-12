# v1.4.0 发版记录

**日期**：2026-11-12
**状态**：GitHub 已发布 ✅ / Chrome 商店 ⛔ 未提交（缺 item id）

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

## 商店三步只走到「准备」

- **凭据有效**：`cws-mcp` 的 refresh token 换 token 成功，scope = `.../auth/chromewebstore`。
- **但没有 item id**：`docs/store-listing.md` 第 134 行「商店 item 已创建」仍是未勾选框。
  本机 Chrome 里也没装过商店版，仓库任何历史 manifest 都没有 `key` 字段 ⇒ **这个扩展从没在商店建过 item**。
- **API 只能更新、不能创建** ⇒ 上传与提交审核都走不通，不是脚本问题。

## 卡在哪、需要什么

**需要人工一步**：在 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
点「新增项目」上传 `out/extension.zip` 建 item。建好之后 URL 最后一段就是 item id。

拿到 item id 后我这边可以直接跑完剩下三步：

```bash
SKILL=~/.config/magpie/library/skills/chrome-store-release/scripts/cws-release.mjs
node $SKILL upload  out/extension.zip                          --item-id <ID>   # 判据 uploadState=SUCCESS
node $SKILL publish 1.4.0                                      --item-id <ID>   # 判据 status 含 OK
node $SKILL verify  1.4.0                                      --item-id <ID>   # 400「in review」= 真的进队列了
```

## 另外还欠两样（都在 dashboard 里手动做，API 没有对应端点）

1. **商店素材上传**：`out/store/promo-440x280.png`、`screenshot-note.png`、`screenshot-batch.png`
   —— API 没有 listing 资产端点，只能 GUI 传。
2. **商店表单字段**：全部文案已经写好，照抄 `docs/store-listing.md` 即可。
