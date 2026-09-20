const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

// ============ 可调参数（可用环境变量覆盖） ============
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 50;
const TRACK_LENGTH = Number(process.env.TRACK_LENGTH) || 500; // 个人计时赛建议 300~500米，约15~25秒跑完
const BASE_SPEED = Number(process.env.BASE_SPEED) || 8;
const SHAKE_FACTOR = Number(process.env.SHAKE_FACTOR) || 6;
const TICK_MS = 100;
const BROADCAST_MS = 300;
const ROOM_ID = 'A123';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/screen', (req, res) => res.sendFile(path.join(__dirname, 'public', 'screen.html')));

const COLORS = ['#ff4757','#ffa502','#2ed573','#1e90ff','#eccc68','#ff6b81','#7bed9f','#70a1ff','#5352ed','#ff7f50',
  '#a4b0be','#5f27cd','#01a3a4','#c56cf0','#f78fb3','#3dc1d3','#e15f41','#574b90','#63cdda','#f5cd79'];
let colorIdx = 0;

// 玩家：status idle=未开始 running=进行中 finished=已完赛
// 单房间常开，无全局倒计时，每个人随时开始，随时结算
const players = new Map(); // socketId -> { nickname,color,status,distance,speed,boost,startedAt,elapsedMs,bestMs,attempts,lastStartAt,finishedAt }

function leaderboard() {
  const arr = [...players.entries()].map(([id, p]) => ({
    id, nickname: p.nickname, color: p.color, status: p.status,
    distance: Math.round(p.distance),
    progress: Math.min(100, Math.round((p.distance / TRACK_LENGTH) * 100)),
    elapsedMs: p.elapsedMs || null,
    bestMs: p.bestMs || null,
    attempts: p.attempts || 0,
  }));
  arr.sort((a, b) => {
    const aDone = a.bestMs != null, bDone = b.bestMs != null;
    if (aDone && bDone) return a.bestMs - b.bestMs;      // 完赛按最快成绩排
    if (aDone && !bDone) return -1;
    if (!aDone && bDone) return 1;
    if (a.status === 'running' && b.status === 'running') return b.distance - a.distance;
    if (a.status === 'running') return -1;
    if (b.status === 'running') return 1;
    return b.distance - a.distance;
  });
  return arr.map((p, i) => ({ ...p, rank: i + 1 }));
}

function broadcast() {
  io.emit('board', { players: leaderboard(), track: TRACK_LENGTH, count: players.size, max: MAX_PLAYERS });
}

// 全局物理 tick：一直跑，更新所有 running 玩家的距离
setInterval(() => {
  const dt = TICK_MS / 1000;
  const now = Date.now();
  let changed = false;
  players.forEach((p, id) => {
    if (p.status !== 'running') return;
    changed = true;
    p.speed = BASE_SPEED + p.boost * SHAKE_FACTOR;
    p.distance += p.speed * dt;
    p.boost *= 0.88;
    if (p.distance >= TRACK_LENGTH) {
      p.distance = TRACK_LENGTH;
      p.status = 'finished';
      p.finishedAt = now;
      p.elapsedMs = now - p.startedAt;
      if (!p.bestMs || p.elapsedMs < p.bestMs) p.bestMs = p.elapsedMs;
      io.to(id).emit('run_finished', {
        elapsedMs: p.elapsedMs, bestMs: p.bestMs,
        rank: leaderboard().findIndex(x => x.id === id) + 1,
      });
    }
  });
  if (changed) broadcast();
}, TICK_MS);

setInterval(broadcast, 2000); // 兜底广播，保持大屏人数同步

io.on('connection', (socket) => {
  socket.on('join', ({ nickname }) => {
    if (players.size >= MAX_PLAYERS && !players.has(socket.id)) {
      return socket.emit('join_error', { msg: '人数已满（50人），请稍后再来' });
    }
    const name = String(nickname || '').slice(0, 10) || '车手' + Math.floor(Math.random() * 900 + 100);
    if (!players.has(socket.id)) {
      players.set(socket.id, {
        nickname: name, color: COLORS[colorIdx++ % COLORS.length],
        status: 'idle', distance: 0, speed: 0, boost: 0,
        startedAt: 0, elapsedMs: null, bestMs: null, attempts: 0,
        lastStartAt: 0, finishedAt: 0,
      });
    } else {
      players.get(socket.id).nickname = name;
    }
    const me = players.get(socket.id);
    socket.emit('joined', { id: socket.id, nickname: me.nickname, bestMs: me.bestMs, track: TRACK_LENGTH });
    broadcast();
  });

  // 个人开始挑战：随时可点，无需等别人（带冷却，防止冲线瞬间误触连点）
  socket.on('start_run', () => {
    const p = players.get(socket.id);
    if (!p) return;
    const now = Date.now();
    if (p.status === 'running') return; // 跑步中重复点直接忽略
    if (p.lastStartAt && now - p.lastStartAt < 2000) return; // 完赛2秒内禁止重开
    p.lastStartAt = now;
    p.status = 'running';
    p.distance = 0; p.speed = 0; p.boost = 0;
    p.elapsedMs = null;
    p.startedAt = Date.now();
    p.attempts += 1;
    socket.emit('run_started', { startedAt: p.startedAt, track: TRACK_LENGTH, attempts: p.attempts });
    broadcast();
  });

  socket.on('shake_tick', ({ count }) => {
    const p = players.get(socket.id);
    if (!p || p.status !== 'running') return;
    const c = Math.min(Number(count) || 0, 30);
    p.boost += c;
    // 实时回执自己的进度（200~300ms一次，手机端秒表更跟手）
    socket.emit('run_progress', {
      distance: Math.round(p.distance),
      progress: Math.min(100, (p.distance / TRACK_LENGTH) * 100),
      elapsedMs: Date.now() - p.startedAt,
    });
  });

  socket.on('host_reset', () => { // 一轮活动结束，清空成绩但保留人
    players.forEach(p => { p.status = 'idle'; p.distance = 0; p.speed = 0; p.boost = 0; p.elapsedMs = null; p.bestMs = null; p.attempts = 0; });
    io.emit('event_reset', {});
    broadcast();
  });
  socket.on('host_clear', () => {
    players.clear();
    io.emit('event_reset', {});
    broadcast();
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    broadcast();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`TimeTrial running at http://localhost:${PORT}  screen: /screen  track=${TRACK_LENGTH}m`));
