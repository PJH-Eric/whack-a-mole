# 房間與線上人員生命週期驗證

日期：2026-11-13。環境：Windows、Node.js 22.23.2、Chromium（Playwright）。

- 根因：回大廳／換房只移除 socket 綁定，舊成員永久在線；觀眾與 AI 保住房間；同身分多分頁互相覆蓋連線狀態。
- 統一離房、回大廳與換房清理，最後一條房內連線離開才釋放成員。在線人數依完成交握的身分去重。
- 斷線玩家沿用 60 秒寬限，到點釋放；沒有真人玩家即關房，失效邀請、停止 AI 腦袋及對局工作。
- 重連完成身分交握才恢復房間或大廳訂閱；關房或重連被拒時回到大廳。主動離線移除舊 socket 監聽。

驗證：

- `npm test`：343 項既有規則及語系／分析／故障提示檢查通過。
- `node tests/lifecycle.cjs`：8 項真實 Socket.IO 生命週期回歸情境通過。
- `npm run test:online`：98 項線上流程通過，包含一局與再開一局。
- `node scripts/lifecycle-browser.cjs`：4 項通過，含大廳與原席位重連、已關房間、停止連線，無 pageerror。
- `npm run test:leave`：10 項通過；`npm run test:reconnect`：11 項通過，包含拔網路恢復與房主接手。
- `CHECK_PORT=3975 npm run test:browser`：577 項通過，涵蓋手機直橫、小手機、平板直橫、大平板、桌機寬版、完整單機、三角色線上、設定與操作。
- 修正既有測試的過期首頁 SVG selector，改驗證實際封面圖片成功載入；線上測試先透過收合鈕關閉可遮住按鈕的大廳聊天，再操作房間按鈕。
- 已檢視平板橫向對局截圖；本次沒有完成所有畫面在每個語系的完整排列。
- 無設定 formatter；手動依既有風格整理，`git diff --check` 通過。UTF-8 無 BOM。

最後依 loop-engineering 檢視、修復、驗證：產品生命週期一輪，既有瀏覽器測試入口校正兩輪。產品回歸與完整瀏覽器驗證全部通過。

部署相容性複查：`npm test` 改使用無開發依賴的 `tests/lifecycle-model.cjs`；真實 Socket.IO 回歸測試併入 `npm run test:online`。獨立目錄以 Git archive ZIP 還原後執行 `npm ci --omit=dev && npm test`，全部通過；未增加正式依賴或修改雲端設定。未驗證正式服務部署結果；本機 Node 版本低於宣告的 26.12.1。原有 QA 文件刪除保留，不納入提交。
