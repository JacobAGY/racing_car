const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

// ============ 组队模式参数 ============
const TEAM_SIZE = Number(process.env.TEAM_SIZE) || 5;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 50;
const TRACK_LENGTH = Number(process.env.TRACK_LENGTH) || 400; // 5人合力约20~30秒跑完
const BASE_SPEED = Number(process.env.BASE_SPEED) || 6;
const TAP_FACTOR = Number(process.env.TAP_FACTOR) || 2.2; // 每人每次点击对团队的贡献
const TICK_MS = 100;
const TEAM_NAMES = ['红队','橙队','蓝队','绿队','紫队','粉队','青队','黄队','白队','黑队'];
const TEAM_COLORS = ['#ff4757','#ffa502','#1e90ff','#2ed573','#a55eea','#fd79a8','#00cec9','#f9ca24','#dfe6e9','#57606f'];

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname, { index: false }));
app.get('/', (req, res) => {
  const fs = require('fs');
  const local = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(local) && !req.query.server) return res.sendFile(local);
  return res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/screen', (req, res) => {
  const fs = require('fs');
  const local = path.join(__dirname, 'public', 'screen.html');
  if (fs.existsSync(local) && !req.query.server) return res.sendFile(local);
  return res.sendFile(path.join(__dirname, 'screen.html'));
});
app.get('/health', (req, res) => res.json({ ok: true, teams: teams.length }));

// ============ 状态 ============
// player: { nickname, avatar, color, teamId, boost }
// team: { id, name, color, members:[socketId], status: waiting|running|finished, distance, speed, startedAt, elapsedMs, bestMs }
const players = new Map();
const teams = [];
let teamSeq = 0;

function getPlayerTeam(pid) { const p = players.get(pid); return p ? teams.find(t => t.id === p.teamId) : null; }

// 随机组队：优先填未满且未开跑的队，否则建新队
function assignTeam(pid) {
  const open = teams.filter(t => t.status === 'waiting' && t.members.length < TEAM_SIZE);
  let team;
  if (open.length) team = open[Math.floor(Math.random() * open.length)];
  else {
    const i = teamSeq++;
    team = { id: 'T' + i, name: TEAM_NAMES[i % TEAM_NAMES.length] + '-' + (Math.floor(i / TEAM_NAMES.length) + 1),
      color: TEAM_COLORS[i % TEAM_COLORS.length], members: [], status: 'waiting',
      distance: 0, speed: 0, startedAt: 0, elapsedMs: null, bestMs: null };
    teams.push(team);
  }
  team.members.push(pid);
  players.get(pid).teamId = team.id;
  return team;
}

function teamView(t) {
  const members = t.members.map(id => {
    const p = players.get(id);
    return p ? { id, nickname: p.nickname, avatar: p.avatar, color: p.color, ready: !!(t.ready && t.ready[id]) } : null;
  }).filter(Boolean);
  return { id: t.id, name: t.name, color: t.color, status: t.status,
    distance: Math.round(t.distance), progress: Math.min(100, Math.round(t.distance / TRACK_LENGTH * 100)),
    members, count: members.length, full: members.length >= TEAM_SIZE,
    elapsedMs: t.elapsedMs, bestMs: t.bestMs };
}

function boardPayload() {
  const arr = teams.map(teamView);
  arr.sort((a, b) => {
    if (a.bestMs != null && b.bestMs != null) return a.bestMs - b.bestMs;
    if (a.bestMs != null) return -1;
    if (b.bestMs != null) return 1;
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (b.status === 'running' && a.status !== 'running') return 1;
    return b.distance - a.distance;
  });
  return { teams: arr, track: TRACK_LENGTH, teamSize: TEAM_SIZE, count: players.size, max: MAX_PLAYERS };
}
function broadcast() { io.emit('board', boardPayload()); }

// 物理 tick：团队速度 = 基础 + 全队 boost 合力
setInterval(() => {
  const dt = TICK_MS / 1000, now = Date.now();
  let changed = false;
  for (const t of teams) {
    if (t.status !== 'running') continue;
    changed = true;
    let boost = 0;
    for (const id of t.members) { const p = players.get(id); if (p) boost += p.boost; }
    t.speed = BASE_SPEED + boost * TAP_FACTOR;
    t.distance += t.speed * dt;
    for (const id of t.members) { const p = players.get(id); if (p) p.boost *= 0.88; }
    // 同步关键：每次 tick 把全队同一份距离推给所有队员，保证5人看到完全一致
    for (const id of t.members) {
      io.to(id).emit('team_progress', {
        distance: Math.round(t.distance),
        progress: Math.min(100, t.distance / TRACK_LENGTH * 100),
        elapsedMs: now - t.startedAt,
      });
    }
    if (t.distance >= TRACK_LENGTH) {
      t.distance = TRACK_LENGTH; t.status = 'finished';
      t.elapsedMs = now - t.startedAt;
      if (!t.bestMs || t.elapsedMs < t.bestMs) t.bestMs = t.elapsedMs;
      for (const id of t.members) io.to(id).emit('team_finished', { team: teamView(t) });
    }
  }
  if (changed) broadcast();
}, TICK_MS);
setInterval(broadcast, 2000);

io.on('connection', (socket) => {
  socket.on('join', ({ nickname, avatar }) => {
    if (players.size >= MAX_PLAYERS && !players.has(socket.id))
      return socket.emit('join_error', { msg: '人数已满，请稍后再来' });
    const name = String(nickname || '').slice(0, 10) || '车手' + Math.floor(Math.random() * 900 + 100);
    const av = String(avatar || '').slice(0, 200000); // 头像 dataURL 或 emoji
    const colors = ['#ff6b81','#ffa502','#7bed9f','#70a1ff','#eccc68'];
    if (!players.has(socket.id)) {
      players.set(socket.id, { nickname: name, avatar: av, color: colors[Math.floor(Math.random() * colors.length)], teamId: null, boost: 0, lastStartAt: 0 });
      assignTeam(socket.id);
    } else {
      const p = players.get(socket.id);
      p.nickname = name; if (av) p.avatar = av;
    }
    const team = getPlayerTeam(socket.id);
    socket.emit('joined', { id: socket.id, nickname: name, team: teamView(team), track: TRACK_LENGTH, teamSize: TEAM_SIZE });
    broadcast();
  });

  // 全员准备：5人点准备后小车上图（IWPB 地图起点），随后自动倒计时开跑
  socket.on('team_ready', () => {
    const t = getPlayerTeam(socket.id);
    if (!t || t.status === 'running') return;
    t.ready = t.ready || {};
    t.ready[socket.id] = true;
    const n = Object.keys(t.ready).length;
    io.emit('team_ready_update', { team: teamView(t), readyCount: n, teamSize: TEAM_SIZE });
    if (n >= Math.min(TEAM_SIZE, t.members.length) && t.members.length >= 2 && !t.countdown) {
      t.countdown = true;
      let n2 = 3;
      io.emit('team_countdown', { team: teamView(t), n: n2 });
      const iv = setInterval(() => {
        n2 -= 1;
        if (n2 > 0) { io.emit('team_countdown', { team: teamView(t), n: n2 }); return; }
        clearInterval(iv); t.countdown = false;
        const now = Date.now();
        t.status = 'running'; t.distance = 0; t.speed = 0; t.elapsedMs = null; t.startedAt = now; t.lastStartAt = now;
        for (const id of t.members) { const p = players.get(id); if (p) p.boost = 0; io.to(id).emit('team_started', { team: teamView(t), startedAt: now }); }
        broadcast();
      }, 1000);
    }
  });

  // 任意队员点开始，全队一起开跑（带2秒冷却防误触）
  socket.on('team_start', () => {
    const t = getPlayerTeam(socket.id);
    if (!t || t.status === 'running') return;
    const now = Date.now();
    if (t.lastStartAt && now - t.lastStartAt < 2000) return;
    t.lastStartAt = now;
    t.status = 'running'; t.distance = 0; t.speed = 0; t.elapsedMs = null; t.startedAt = now;
    for (const id of t.members) { const p = players.get(id); if (p) p.boost = 0; io.to(id).emit('team_started', { team: teamView(t), startedAt: now }); }
    broadcast();
  });

  // 点击加速：每人每200ms上报，计入团队合力
  socket.on('tap', ({ count }) => {
    const p = players.get(socket.id);
    const t = getPlayerTeam(socket.id);
    if (!p || !t || t.status !== 'running') return;
    p.boost += Math.min(Number(count) || 0, 30);
    socket.emit('team_progress', { distance: Math.round(t.distance),
      progress: Math.min(100, t.distance / TRACK_LENGTH * 100), elapsedMs: Date.now() - t.startedAt });
  });

  socket.on('host_reset', () => {
    for (const t of teams) { t.status = 'waiting'; t.distance = 0; t.speed = 0; t.elapsedMs = null; /* 保留 bestMs 做总榜 */ }
    io.emit('event_reset', {});
    broadcast();
  });
  socket.on('host_clear', () => { players.clear(); teams.length = 0; teamSeq = 0; io.emit('event_reset', {}); broadcast(); });
  socket.on('host_shuffle', () => {
    // 重新随机组队
    const ids = [...players.keys()].sort(() => Math.random() - 0.5);
    teams.length = 0; teamSeq = 0;
    for (const id of ids) { players.get(id).teamId = null; players.get(id).boost = 0; assignTeam(id); }
    for (const t of teams) t.status = 'waiting';
    io.emit('event_reset', {});
    broadcast();
  });

  // ============ 方案A：WebRTC 信令中继（SDP / ICE 只经服务器转发，游戏数据走 P2P DataChannel） ============
  socket.on('rtc_join', ({ room }) => {
    const r = String(room || 'IWPB-1').slice(0, 32);
    socket.join('rtc:' + r);
    const size = (io.sockets.adapter.rooms.get('rtc:' + r) || new Set()).size;
    // 第一个进房间的当临时主机（host），之后进的当队员（guest），房间满5人
    socket.emit('rtc_role', { room: r, role: size <= 1 ? 'host' : 'guest', index: size - 1 });
    socket.to('rtc:' + r).emit('rtc_peer_in', { id: socket.id });
  });
  socket.on('rtc_offer', ({ room, to, sdp }) => { io.to(to).emit('rtc_offer', { from: socket.id, room, sdp }); });
  socket.on('rtc_answer', ({ to, sdp }) => { io.to(to).emit('rtc_answer', { from: socket.id, sdp }); });
  socket.on('rtc_ice', ({ to, candidate }) => { io.to(to).emit('rtc_ice', { from: socket.id, candidate }); });

  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    players.delete(socket.id);
    if (p && p.teamId) {
      const t = teams.find(x => x.id === p.teamId);
      if (t) {
        t.members = t.members.filter(id => id !== socket.id);
        if (t.members.length === 0) teams.splice(teams.indexOf(t), 1);
        else if (t.status === 'running' && t.members.length === 0) t.status = 'waiting';
      }
    }
    broadcast();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`TeamRace running at http://localhost:${PORT} team=${TEAM_SIZE} track=${TRACK_LENGTH}m`));
