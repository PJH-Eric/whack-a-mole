'use strict';

const assert = require('node:assert/strict');
const { RoomStore, DISCONNECT_GRACE_MS } = require('../lib/rooms.js');

const store = new RoomStore();
const { room } = store.create('host', { name: 'host', now: 0 });
room.join('spectator', { role: 'spectator', now: 0 });
room.addAi('host', 'normal');
const invite = room.createInvite('host', { role: 'spectator', now: 0 });
room.disconnect('host', 100);
assert.equal(store.sweep(100 + DISCONNECT_GRACE_MS - 1).closed.length, 0);
const swept = store.sweep(100 + DISCONNECT_GRACE_MS);
assert.deepEqual(swept.closed, [room]);
assert.equal(swept.changed.includes(room), false);
assert.equal(store.get(room.code), null);
assert.equal(room.join('late-client', { now: 100000 }).ok, false);
assert.equal(room.checkInvite(invite.invite.token, 100000).ok, false);
assert.equal(room.brains.size, 0);
assert.equal(room.aiSeats.length, 0);
assert.deepEqual(room.step(100000).events, []);

const other = store.create('host', { name: 'host', now: 0 }).room;
other.join('spectator', { role: 'spectator', now: 0 });
other.addAi('host', 'normal');
assert.equal(other.leave('host', 1).emptied, true);
console.log('PASS 房間模型：斷線期限、AI／觀戰關房、邀請失效與禁止復活');
