'use strict';

const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io, store } = require('../server.js');
const { RoomStore, DISCONNECT_GRACE_MS } = require('../lib/rooms.js');

const sockets = [];
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check) {
  const deadline = Date.now() + 1500;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail('生命週期狀態未在期限內更新');
    await pause();
  }
}
function request(socket, event, payload = {}) {
  return socket.timeout(1500).emitWithAck(event, payload);
}
async function client(id) {
  const socket = connect('http://127.0.0.1:' + server.address().port, {
    transports: ['websocket'], forceNew: true, reconnection: false
  });
  sockets.push(socket);
  await new Promise(resolve => socket.once('connect', resolve));
  await request(socket, 'hello', { clientId: id, name: id });
  return socket;
}

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let failures = 0;
  async function check(name, run) {
    try { await run(); console.log('PASS ' + name); }
    catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
    for (const socket of sockets.splice(0)) socket.disconnect();
    await until(() => io.sockets.sockets.size === 0);
    for (const room of [...store.rooms.values()]) store.close(room.code);
  }

  await check('回大廳會釋放原房間，不留下永久在線的成員', async () => {
    const host = await client('lifecycle-host');
    const { code } = await request(host, 'room:create');
    host.emit('lobby:subscribe');
    await until(() => !store.get(code));
  });
  await check('換房與重複建房會清理舊房間', async () => {
    const host = await client('lifecycle-host');
    const first = await request(host, 'room:create');
    const second = await request(host, 'room:create');
    assert.notEqual(second.code, first.code);
    assert.equal(store.get(first.code), null);
    const other = await client('lifecycle-other');
    const third = await request(other, 'room:create');
    assert.equal((await request(host, 'room:join', { code: third.code })).ok, true);
    assert.equal(store.get(second.code), null);
    const rejected = await request(host, 'room:join', { code: 'XXXXX' });
    assert.equal(rejected.ok, false);
    assert.ok(store.get(third.code).member('lifecycle-host'));
  });
  await check('最後玩家離開會通知觀眾關房並撤銷邀請', async () => {
    const host = await client('lifecycle-host');
    const spectator = await client('lifecycle-spectator');
    const { code } = await request(host, 'room:create');
    const room = store.get(code);
    const invite = await request(host, 'room:invite', { role: 'spectator', ttlMinutes: 30 });
    await request(spectator, 'room:join', { code, token: invite.token });
    let closed = false;
    spectator.on('room:closed', () => { closed = true; });
    host.emit('room:leave');
    await until(() => closed);
    assert.equal(store.get(code), null);
    assert.equal(room.join('late-client', { now: Date.now() }).ok, false);
    assert.equal(room.checkInvite(invite.token, Date.now()).ok, false);
  });
  await check('最後玩家改觀戰時不保留純觀戰房間', async () => {
    const host = await client('lifecycle-host');
    const { code } = await request(host, 'room:create');
    host.emit('room:stand');
    await until(() => !store.get(code));
  });
  await check('只有 AI 與觀眾時關房並停止 AI 工作', async () => {
    const host = await client('lifecycle-host');
    const { code } = await request(host, 'room:create');
    const room = store.get(code);
    assert.equal(room.addAi('lifecycle-host', 'normal').ok, true);
    host.emit('room:stand');
    await until(() => !store.get(code));
    assert.equal(room.brains.size, 0);
    assert.equal(room.aiSeats.length, 0);
    assert.equal(room.phase, 'closed');
    assert.deepEqual(room.step(Date.now()).events, []);
  });
  await check('多分頁只計一人，關閉一頁不會讓另一頁斷線或被回收', async () => {
    const watcher = await client('lifecycle-watcher');
    let online;
    watcher.on('lobby:rooms', payload => { online = payload.online; });
    watcher.emit('lobby:subscribe');
    const first = await client('lifecycle-shared');
    const { code } = await request(first, 'room:create');
    const second = await client('lifecycle-shared');
    await request(second, 'room:join', { code });
    await until(() => online === 2);
    first.disconnect();
    await until(() => io.sockets.sockets.size === 2);
    assert.equal(store.get(code).member('lifecycle-shared').connected, true);
    store.sweep(Date.now() + DISCONNECT_GRACE_MS + 1);
    assert.ok(store.get(code));
    second.disconnect();
    await until(() => online === 1);
    await until(() => !store.get(code).member('lifecycle-shared').connected);
    store.sweep(Date.now() + DISCONNECT_GRACE_MS + 1);
    assert.equal(store.get(code), null);
  });
  await check('同一連線更新暱稱不能改變已綁定的身分', async () => {
    const host = await client('lifecycle-host');
    const { code } = await request(host, 'room:create');
    const hello = await request(host, 'hello', { clientId: 'different-client', name: '新名字' });
    assert.equal(hello.clientId, 'lifecycle-host');
    host.disconnect();
    await until(() => io.sockets.sockets.size === 0);
    assert.equal(store.get(code).member('lifecycle-host').connected, false);
  });
  await check('斷線期限到點釋放最後玩家，即使觀眾還在線也關房', () => {
    const rooms = new RoomStore();
    const { room } = rooms.create('host', { now: 0 });
    room.join('spectator', { role: 'spectator', now: 0 });
    room.disconnect('host', 100);
    assert.ok(rooms.get(room.code));
    const swept = rooms.sweep(100 + DISCONNECT_GRACE_MS);
    assert.equal(rooms.get(room.code), null);
    assert.deepEqual(swept.closed, [room]);
    assert.equal(swept.changed.includes(room), false);
  });

  io.close();
  server.close();
  process.exit(failures ? 1 : 0);
}
main().catch(error => { console.error(error); process.exit(1); });
