'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { server, io, store } = require('../server.js');

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    assert.equal(io.sockets.sockets.size, 0, '首頁不建立後端連線');
    await page.click('#b-online');
    await page.waitForFunction(() => Online.status().status === 'connected');
    await page.waitForFunction(() => !document.getElementById('lobby-online-count').hidden);
    let previous = [...io.sockets.sockets.values()][0];
    previous.conn.close();
    await page.waitForFunction(() => Online.status().status !== 'connected');
    await page.waitForFunction(() => Online.status().status === 'connected');
    await page.waitForFunction(() => !document.getElementById('lobby-online-count').hidden);
    assert.notEqual([...io.sockets.sockets.values()][0].id, previous.id);
    console.log('PASS 斷線重連後恢復大廳列表與在線人數推送');

    await page.click('#b-create');
    await page.waitForSelector('#s-game.active');
    const room = [...store.rooms.values()][0];
    const hostId = room.hostId;
    previous = [...io.sockets.sockets.values()][0];
    previous.conn.close();
    await page.waitForFunction(() => Online.status().status !== 'connected');
    await page.waitForFunction(() => Online.status().status === 'connected');
    await page.waitForTimeout(200);
    assert.equal(room.member(hostId).connected, true, '自動重連必須恢復原房間成員');
    const current = [...io.sockets.sockets.values()][0];
    assert.equal(current.data.roomCode, room.code, '自動重連必須重新綁定原房間');
    console.log('PASS 房間內斷線自動回原席位，不產生殘留座位');

    store.close(room.code);
    current.conn.close();
    await page.waitForSelector('#s-lobby.active');
    await page.waitForFunction(() => !document.getElementById('lobby-online-count').hidden);
    assert.equal(store.size(), 0, '已關閉房間不能因重連而復活');
    console.log('PASS 重連時房間已關閉會返回大廳');
    await page.evaluate(() => Online.disconnect());
    await page.waitForFunction(() => Online.status().status === 'idle');
    await page.waitForTimeout(100);
    assert.equal(io.sockets.sockets.size, 0);
    assert.deepEqual(errors, []);
    console.log('PASS 離開線上後停止連線，沒有瀏覽器未處理錯誤');
  } finally {
    await browser.close();
    io.close();
    server.close();
  }
  process.exit(0);
}
main().catch(error => { console.error(error); process.exit(1); });
