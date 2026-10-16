/*
 * server.js — 打地鼠大亂鬥的權威伺服器
 *
 * Express 負責靜態前端與 /health，Socket.IO 負責大廳、房間與對局。
 *
 * 共用盤面、搶打先得分，所以「誰先打到」一定要由伺服器決定：
 * 用戶端只送「我敲了第幾號洞、我以為那裡是第幾號地鼠」，
 * 加分與否、加多少、地鼠死了沒，全部由 lib/rooms.js -> public/js/rules.js 判斷。
 *
 * 環境變數
 *   PORT                 監聽埠（Render 之類的平台會自動注入），預設 3030
 *   HOST                 監聽介面，預設 0.0.0.0
 *   GAME_ALLOWED_ORIGIN  允許連進來的前端來源，逗號分隔；* 代表不限制
 *   ROUND_MS             新房間的預設一局長度（毫秒），預設 60000；房主可在房間裡改成 60／75／90 秒
 *   COUNTDOWN_MS         開賽倒數（毫秒），預設 3000
 *   AI_SPEED_SCALE       保留給自動化測試調整 AI 節奏（目前 AI 節奏在 ai.js）
 */
'use strict';

const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const Rules = require('./public/js/rules.js');
const AI = require('./public/js/ai.js');
const { RoomStore, sanitizeName } = require('./lib/rooms.js');

const PORT = Number(process.env.PORT || 3030);
const HOST = process.env.HOST || '0.0.0.0';
const ROUND_MS = Number(process.env.ROUND_MS || Rules.ROUND_MS);
const COUNTDOWN_MS = Number(process.env.COUNTDOWN_MS === undefined ? Rules.COUNTDOWN_MS : process.env.COUNTDOWN_MS);
const STARTED_AT = Date.now();

/* 對局推進頻率。50ms 夠讓「搶打」判定公平，又不會把免費方案的 CPU 吃光。 */
const TICK_MS = 50;
/* 完整狀態的推播間隔。中間的動畫前端用時間戳自己內插，不需要每幀都送。 */
const SYNC_MS = 1000;

/* 允許的前端來源：正式環境請明確設定，不要放著 * 不管 */
const ALLOWED = String(process.env.GAME_ALLOWED_ORIGIN || '*')
  .split(',').map((s) => s.trim()).filter(Boolean);
const allowAll = ALLOWED.includes('*');

function originAllowed(origin) {
  if (allowAll) return true;
  if (!origin) return true;              // 同源請求不帶 Origin
  return ALLOWED.includes(origin);
}

/* ------------------------------------------------------------ HTTP */

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders(res) { res.setHeader('Cache-Control', 'no-cache'); }
}));

/* 免費雲端的健康檢查端點：平台靠它判斷服務活著沒 */
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'whack-a-mole',
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    rooms: store.size(),
    sockets: io ? io.engine.clientsCount : 0,
    roundMs: ROUND_MS
  });
});

/* 大廳在開 socket 之前可以先看一眼房間列表 */
app.get('/api/rooms', (_req, res) => res.json({ rooms: store.list(), total: store.size() }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin(origin, cb) { cb(null, originAllowed(origin)); },
    methods: ['GET', 'POST']
  },
  pingInterval: 20000,
  pingTimeout: 25000,
  maxHttpBufferSize: 1e5
});

/* ------------------------------------------------------------ 狀態 */

const store = new RoomStore({});
const roomSockets = new Map();   // roomCode -> Set<socket>
const lobbySockets = new Set();  // 停在大廳、要收房間列表推播的 socket
const lastSyncAt = new Map();    // roomCode -> 上一次送完整狀態的時間

const now = () => Date.now();

function presenceSnapshot() {
  let players = 0;
  let spectators = 0;
  let rooms = 0;
  for (const [code, sockets] of roomSockets) {
    const room = store.get(code);
    if (!room || !sockets.size) continue;
    rooms += 1;
    for (const socket of sockets) {
      const member = room.member(socket.data.clientId);
      if (member?.role === 'player') players += 1;
      if (member?.role === 'spectator') spectators += 1;
    }
  }
  return {
    gameId: 'whack-a-mole',
    online: io.engine.clientsCount,
    players,
    spectators,
    lobby: lobbySockets.size,
    rooms,
    updatedAt: new Date().toISOString()
  };
}

app.get('/api/presence', (_req, res) => res.json(presenceSnapshot()));

function socketsOf(code) {
  let set = roomSockets.get(code);
  if (!set) { set = new Set(); roomSockets.set(code, set); }
  return set;
}

function attach(socket, code) {
  detach(socket);
  socket.data.roomCode = code;
  socketsOf(code).add(socket);
  lobbySockets.delete(socket);
}

function detach(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const set = roomSockets.get(code);
  if (set) {
    set.delete(socket);
    if (!set.size) roomSockets.delete(code);
  }
  socket.data.roomCode = null;
}

/** 每個人拿到的是「自己這個角色看到的投影」 */
function syncRoom(room) {
  const t = now();
  lastSyncAt.set(room.code, t);
  for (const s of socketsOf(room.code)) {
    s.emit('room:sync', room.viewFor(s.data.clientId, t));
  }
}

function syncLobby() {
  if (!lobbySockets.size) return;
  const payload = { rooms: store.list(), total: store.size() };
  for (const s of lobbySockets) s.emit('lobby:rooms', payload);
}

function broadcastChat(room, message) {
  for (const s of socketsOf(room.code)) s.emit('room:chat', { message });
}

/* 所有給玩家看的訊息都只送「字典 key＋參數」，由各玩家的前端依自己的語言翻譯。 */
function fail(socket, key, params, code) {
  socket.emit('room:error', { key: key || 'err.failed', params: params || {}, code: code || 'invalid' });
}

/** 把 room.* 回傳的失敗結果（{key, params, code}）轉成 room:error */
function failRes(socket, res) {
  fail(socket, res.key, res.params, res.code);
}

/** 電腦對手在訊息參數裡的樣子：前端會依語言換成名字 */
function aiRef(seat) {
  return { name: seat.name, nameIdx: seat.nameIdx, ai: seat.level };
}

/* ------------------------------------------------------------ Socket */

io.on('connection', (socket) => {
  socket.data.clientId = null;
  socket.data.name = 'Player';
  socket.data.roomCode = null;

  socket.on('latency:ping', (_sentAt, ack) => { if (typeof ack === 'function') ack(); });

  socket.on('hello', (payload, ack) => {
    const p = payload || {};
    let id = String(p.clientId || '').trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) id = crypto.randomBytes(12).toString('hex');
    socket.data.clientId = id;
    socket.data.name = sanitizeName(p.name, 'Player');
    if (typeof ack === 'function') {
      ack({ ok: true, clientId: id, name: socket.data.name, serverTime: now(), roundMs: ROUND_MS });
    }
  });

  socket.on('lobby:subscribe', () => {
    detach(socket);
    lobbySockets.add(socket);
    socket.emit('lobby:rooms', { rooms: store.list(), total: store.size() });
  });

  socket.on('lobby:unsubscribe', () => { lobbySockets.delete(socket); });

  socket.on('room:create', (payload, ack) => {
    if (!socket.data.clientId) return fail(socket, 'err.noSession', null, 'nosession');
    const p = payload || {};
    socket.data.name = sanitizeName(p.name, socket.data.name);
    const res = store.create(socket.data.clientId, {
      name: socket.data.name,
      roomName: p.roomName,
      private: !!p.private,
      board: p.board,
      pace: p.pace,
      roundMs: p.roundSec ? Rules.roundMsOf(p.roundSec) : ROUND_MS,
      now: now()
    });
    if (!res.ok) { failRes(socket, res); if (typeof ack === 'function') ack(res); return; }
    const room = res.room;
    attach(socket, room.code);
    room.system('sys.roomOpened', { name: socket.data.name }, now());
    syncRoom(room);
    syncLobby();
    if (typeof ack === 'function') ack({ ok: true, code: room.code });
  });

  socket.on('room:join', (payload, ack) => {
    if (!socket.data.clientId) return fail(socket, 'err.noSession', null, 'nosession');
    const p = payload || {};
    const room = store.get(p.code);
    if (!room) {
      const e = { ok: false, key: 'err.roomNotFound', code: 'gone' };
      failRes(socket, e);
      if (typeof ack === 'function') ack(e);
      return;
    }
    socket.data.name = sanitizeName(p.name, socket.data.name);
    const res = room.join(socket.data.clientId, {
      name: socket.data.name,
      role: p.role,
      token: p.token ? String(p.token) : null,
      now: now()
    });
    if (!res.ok) { failRes(socket, res); if (typeof ack === 'function') ack(res); return; }
    attach(socket, room.code);
    if (res.reconnected) {
      room.system('sys.reconnected', { name: res.member.name }, now());
    } else {
      room.system(res.member.role === 'player' ? 'sys.joinedPlayer' : 'sys.joinedSpectator', { name: res.member.name }, now());
    }
    syncRoom(room);
    syncLobby();
    if (typeof ack === 'function') {
      ack({
        ok: true, code: room.code, role: res.member.role,
        downgraded: !!res.downgraded, waiting: !!res.waiting,
        reconnected: !!res.reconnected, note: res.note || null
      });
    }
  });

  /* 進房前先問一下這個邀請連結還有沒有效，讓前端能顯示明確原因 */
  socket.on('invite:check', (payload, ack) => {
    const p = payload || {};
    const room = store.get(p.code);
    if (!room) {
      return typeof ack === 'function'
        && ack({ ok: false, key: 'err.inviteRoomGone', code: 'gone' });
    }
    const res = room.checkInvite(String(p.token || ''), now());
    if (typeof ack === 'function') {
      ack(res.ok ? { ok: true, role: res.invite.role, note: res.note || null, room: room.brief() } : res);
    }
  });

  /* --------------------------------------------------------- 房內操作 */

  function withRoom(handler) {
    return (payload, ack) => {
      const room = store.get(socket.data.roomCode);
      if (!room) return fail(socket, 'err.noRoom', null, 'gone');
      handler(room, payload || {}, ack);
    };
  }

  socket.on('room:ready', withRoom((room, p) => {
    const res = room.setReady(socket.data.clientId, !!p.ready);
    if (!res.ok) return failRes(socket, res);
    syncRoom(room); syncLobby();
  }));

  socket.on('room:sit', withRoom((room) => {
    const res = room.becomePlayer(socket.data.clientId);
    if (!res.ok) return failRes(socket, res);
    room.system('sys.sat', { name: res.member.name }, now());
    syncRoom(room); syncLobby();
  }));

  socket.on('room:stand', withRoom((room) => {
    const res = room.becomeSpectator(socket.data.clientId);
    if (!res.ok) return failRes(socket, res);
    room.system('sys.stood', { name: res.member.name }, now());
    syncRoom(room); syncLobby();
  }));

  socket.on('room:addAi', withRoom((room, p) => {
    const res = room.addAi(socket.data.clientId, p.level);
    if (!res.ok) return failRes(socket, res);
    room.system('sys.aiAdded', { who: aiRef(res.seat) }, now());
    syncRoom(room); syncLobby();
  }));

  socket.on('room:removeAi', withRoom((room, p) => {
    const res = room.removeAi(socket.data.clientId, String(p.id || ''));
    if (!res.ok) return failRes(socket, res);
    room.system('sys.aiRemoved', { who: aiRef(res.seat) }, now());
    syncRoom(room); syncLobby();
  }));

  socket.on('room:setRound', withRoom((room, p) => {
    const res = room.setRound(socket.data.clientId, p.roundSec);
    if (!res.ok) return failRes(socket, res);
    if (res.changed) room.system('sys.roundSet', { sec: res.sec }, now());
    syncRoom(room); syncLobby();
  }));

  socket.on('room:setPace', withRoom((room, p) => {
    const res = room.setPace(socket.data.clientId, String(p.pace || ''));
    if (!res.ok) return failRes(socket, res);
    if (res.changed) room.system('sys.paceSet', { pace: { key: 'pace.' + res.pace + '.label' } }, now());
    syncRoom(room); syncLobby();
  }));

  socket.on('room:setBoard', withRoom((room, p) => {
    const res = room.setBoard(socket.data.clientId, String(p.board || ''));
    if (!res.ok) return failRes(socket, res);
    if (res.changed) room.system('sys.boardSet', { board: res.label, holes: res.holes }, now());
    syncRoom(room); syncLobby();
  }));

  socket.on('room:start', withRoom((room) => {
    const res = room.start(socket.data.clientId, now(), { countdownMs: COUNTDOWN_MS });
    if (!res.ok) return failRes(socket, res);
    room.system('sys.getReady', { seed: room.seed }, now());
    syncRoom(room); syncLobby();
  }));

  /* 搶打的核心：先到先判定，判定結果一次廣播給全房（含觀戰者） */
  socket.on('room:whack', withRoom((room, p) => {
    const t = now();
    const res = room.whack(socket.data.clientId, { hole: Number(p.hole), moleId: Number(p.moleId) || null }, t);
    if (!res.ok) return failRes(socket, res);
    for (const s of socketsOf(room.code)) s.emit('room:events', { t, events: [res.event] });
  }));

  socket.on('room:rematch', withRoom((room) => {
    const res = room.voteRematch(socket.data.clientId, now());
    if (!res.ok) return failRes(socket, res);
    const me = room.member(socket.data.clientId);
    if (res.started) room.system('sys.rematchStarted', {}, now());
    else room.system('sys.rematchVote', { name: me.name, votes: res.votes, need: res.need }, now());
    syncRoom(room); syncLobby();
  }));

  socket.on('room:reset', withRoom((room) => {
    const res = room.backToLobby(socket.data.clientId, now());
    if (!res.ok) return failRes(socket, res);
    room.system('sys.backToLobby', {}, now());
    syncRoom(room); syncLobby();
  }));

  socket.on('room:chat', withRoom((room, p) => {
    const res = room.say(socket.data.clientId, p.text, now());
    if (!res.ok) return failRes(socket, res);
    broadcastChat(room, res.message);
  }));

  socket.on('room:mute', withRoom((room, p) => {
    const res = room.mute(socket.data.clientId, String(p.targetId || ''), p.seconds, now());
    if (!res.ok) return failRes(socket, res);
    room.system('sys.muted', { name: res.name, sec: res.seconds }, now());
    syncRoom(room);
  }));

  socket.on('room:invite', withRoom((room, p, ack) => {
    const res = room.createInvite(socket.data.clientId, {
      role: p.role, ttlMs: Number(p.ttlMinutes) * 60000, maxUses: p.maxUses, now: now()
    });
    if (!res.ok) { failRes(socket, res); return typeof ack === 'function' && ack(res); }
    syncRoom(room);
    if (typeof ack === 'function') {
      ack({
        ok: true, token: res.invite.token, role: res.invite.role,
        expiresAt: res.invite.expiresAt, maxUses: res.invite.maxUses
      });
    }
  }));

  socket.on('room:revokeInvite', withRoom((room, p) => {
    const res = room.revokeInvite(socket.data.clientId, String(p.token || ''));
    if (!res.ok) return failRes(socket, res);
    syncRoom(room);
  }));

  socket.on('room:leave', withRoom((room) => {
    const res = room.leave(socket.data.clientId, now());
    detach(socket);
    socket.emit('room:left', { ok: true });
    /* 最後一個人走了就立刻關房，不留空房佔房號 */
    if (res.ok && res.emptied) { closeRoom(room, 'err.roomEmpty'); syncLobby(); return; }
    if (res.ok) room.system('sys.left', { name: res.name }, now());
    syncRoom(room);
    syncLobby();
  }));

  socket.on('disconnect', () => {
    lobbySockets.delete(socket);
    const room = store.get(socket.data.roomCode);
    detach(socket);
    if (!room) return;
    const member = room.member(socket.data.clientId);
    if (!member) return;
    /* 先標記為斷線並保留座位，讓重新整理的人可以憑 clientId 回到原位 */
    room.disconnect(socket.data.clientId, now());
    room.system('sys.disconnected', { name: member.name }, now());
    syncRoom(room);
    syncLobby();
  });
});

/* ------------------------------------------------------------ 對局主迴圈 */

/*
 * 每 50ms 推進一次所有進行中的房間。
 * 有事件（冒出／被打／溜掉／開賽／結束）就立刻廣播，
 * 中間的升降動畫由前端依 spawnAt / expireAt 自己內插，
 * 所以不必每幀送完整狀態，免費方案的頻寬撐得住。
 */
setInterval(() => {
  const t = now();

  for (const room of store.active()) {
    const before = room.phase;
    const { events } = room.step(t);

    if (events.length) {
      for (const s of socketsOf(room.code)) s.emit('room:events', { t, events });
    }

    /* 階段轉換一定要送完整狀態，前端才好切畫面 */
    if (room.phase !== before) {
      if (room.phase === 'over') {
        const rank = Rules.standings(room.state);
        const champ = rank[0];
        const ref = (p) => (p.nameIdx === null || p.nameIdx === undefined
          ? { name: p.name } : { name: p.name, nameIdx: p.nameIdx, ai: p.ai });
        if (room.state.draw) room.system('sys.timeUpTie', { names: rank.filter((r) => r.rank === 1).map(ref) }, t);
        else room.system('sys.timeUpWinner', { who: ref(champ), score: champ.score }, t);
      }
      syncRoom(room);
      syncLobby();
      continue;
    }

    /* 對局中每秒補一次完整狀態，補掉任何漏收的事件 */
    if (t - (lastSyncAt.get(room.code) || 0) >= SYNC_MS) syncRoom(room);
  }
}, TICK_MS);

/**
 * 關掉一間房並把還連著的人踢回大廳。
 * @param {boolean} [alreadyRemoved] 回收流程已經把房間從 store 拿掉了，不用再拿一次
 */
function closeRoom(room, key, alreadyRemoved) {
  if (!alreadyRemoved) store.close(room.code);
  for (const s of socketsOf(room.code)) {
    s.emit('room:closed', { key: key });
    s.data.roomCode = null;
  }
  roomSockets.delete(room.code);
  lastSyncAt.delete(room.code);
}

/* 回收：斷線太久的人、沒人的空房、打完很久的房 */
setInterval(() => {
  const t = now();
  const swept = store.sweep(t);
  for (const room of swept.changed) syncRoom(room);
  for (const room of swept.closed) closeRoom(room, 'err.roomEmpty', true);
  if (swept.changed.length || swept.closed.length) syncLobby();
}, 2000);

/* ------------------------------------------------------------ 啟動 */

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function shutdown(signal) {
  console.log('\n收到 ' + signal + '，正在關閉伺服器…');
  io.close(() => { server.close(() => process.exit(0)); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('========================================');
    console.log('  打地鼠大亂鬥 伺服器已啟動');
    console.log('========================================');
    console.log('  這台電腦：  http://localhost:' + PORT);
    for (const ip of lanAddresses()) {
      console.log('  同網段：    http://' + ip + ':' + PORT + '   <- 其他人用這個');
    }
    console.log('  健康檢查：  http://localhost:' + PORT + '/health');
    console.log('  允許來源：  ' + (allowAll ? '不限制（* — 正式環境請設定 GAME_ALLOWED_ORIGIN）' : ALLOWED.join(', ')));
    console.log('  一局長度：  ' + Math.round(ROUND_MS / 1000) + ' 秒，開賽倒數 ' + Math.round(COUNTDOWN_MS / 1000) + ' 秒');
    console.log('  最多同時：  ' + Rules.MAX_PLAYERS + ' 人共用一組地洞');
    console.log('  電腦難度：  ' + AI.ORDER.join(' / '));
    console.log('----------------------------------------');
  });
}

module.exports = { app, server, io, store };
