const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { Server } = require('socket.io');
const http = require('http');
const mongoose = require('mongoose');
const crypto = require('crypto');
const https = require('https');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-id,x-telegram-id');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// ─── Static audio/assets (correct MIME types) ───
app.use('/audio', (req, res, next) => {
  const ext = req.path.split('.').pop().toLowerCase();
  const mimeMap = { mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg' };
  if (mimeMap[ext]) {
    res.setHeader('Content-Type', mimeMap[ext]);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
  next();
}, express.static(path.join(__dirname, 'audio')));

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  allowEIO3: true,
  pingTimeout: 30000,
  pingInterval: 10000
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://candycrashfrontend.vercel.app';
const BACKEND_URL = process.env.BACKEND_URL || 'https://candycrashbackend.onrender.com';
const BOT_USERNAME = process.env.BOT_USERNAME || 'candycrashh_bot';
const ENTRY_FEE = 500;
const WIN_PRIZE = 800;
const DRAW_REFUND = 250;
const GAME_DURATION_S = 180;   // 3 minutes
const WIN_SCORE       = 700;   // instant win threshold
const SEARCH_TIMEOUT_S = 60;

// ===== MongoDB =====
let isConnected = false;
async function connectDB() {
  const uris = [process.env.MONGODB_URI1, process.env.MONGODB_URI2].filter(Boolean);
  for (const uri of uris) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
      isConnected = true;
      console.log('✅ MongoDB connected');
      return;
    } catch (e) { console.error('❌ MongoDB failed:', e.message); }
  }
  setTimeout(connectDB, 10000);
}
mongoose.connection.on('disconnected', () => { isConnected = false; });
mongoose.connection.on('reconnected', () => { isConnected = true; });
connectDB();

async function seedAgentPaymentInfo() {
  try {
    const agentUser = await User.findOne({ referralCode: 'TIC3W2ZCO6CXBK', role: 'agent' }).lean();
    if (!agentUser) return;
    const existing = await Agent.findOne({ telegramId: agentUser.telegramId }).lean();
    if (existing && existing.agentKpayNumber === '09781317607') return;
    await Agent.findOneAndUpdate(
      { telegramId: agentUser.telegramId },
      { $set: { agentKpayNumber: '09781317607', agentKpayName: 'Nang pauk', hasWave: false } },
      { upsert: false }
    );
    console.log('✅ Seeded Nang pauk kpay info');
  } catch(e) { console.error('seedAgentPaymentInfo err:', e.message); }
}
setTimeout(seedAgentPaymentInfo, 5000);

// ===== Schemas =====
const userSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true },
  username: { type: String, default: '' },
  firstName: { type: String, default: '' },
  balance: { type: Number, default: 0 },
  referredBy: { type: Number, default: null },
  referralCode: { type: String, unique: true, sparse: true },
  totalGames: { type: Number, default: 0 },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  isBanned: { type: Boolean, default: false },
  role: { type: String, enum: ['user','agent'], default: 'user' },
  botMode: { type: Boolean, default: false },
  lastActive: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});
userSchema.index({ telegramId: 1 });
userSchema.index({ referralCode: 1 });

const depositSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  kpayName: String,
  transactionId: { type: String, required: true, unique: true },
  amount: { type: Number, required: true },
  paymentMethod: { type: String, enum: ['kpay','wave'], default: 'kpay' },
  status: { type: String, enum: ['pending','confirmed','rejected'], default: 'pending' },
  processedBy: { type: String, enum: ['admin','agent'], default: 'admin' },
  createdAt: { type: Date, default: Date.now },
  processedAt: Date,
  expireAt: { type: Date, default: null }
});
depositSchema.index({ transactionId: 1 });
depositSchema.index({ status: 1 });
depositSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

const withdrawalSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  kpayName: String,
  kpayNumber: String,
  amount: { type: Number, required: true },
  paymentMethod: { type: String, enum: ['kpay','wave'], default: 'kpay' },
  status: { type: String, enum: ['pending','confirmed','rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  processedAt: Date,
  expireAt: { type: Date, default: null }
});
withdrawalSchema.index({ status: 1 });
withdrawalSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

// ★ Candy Crush game schema - scores instead of board
const gameSchema = new mongoose.Schema({
  gameId: { type: String, required: true, unique: true },
  players: [Number],
  playerNames: { type: Map, of: String, default: {} },
  scores: { type: Map, of: Number, default: {} },         // ★ candy crush scores
  winner: { type: mongoose.Schema.Types.Mixed, default: null },
  winnerName: { type: String, default: '' },
  status: { type: String, enum: ['waiting','active','completed'], default: 'waiting' },
  isAIGame: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, expires: 86400*30 }
});
gameSchema.index({ gameId: 1 });

const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed
});

const redeemCodeSchema = new mongoose.Schema({
  code:       { type: String, required: true, unique: true, uppercase: true, trim: true },
  amount:     { type: Number, required: true },
  maxUses:    { type: Number, default: 1 },
  usedBy:     [{ type: Number }],
  isActive:   { type: Boolean, default: true },
  createdAt:  { type: Date, default: Date.now }
});
redeemCodeSchema.index({ code: 1 });

const agentSchema = new mongoose.Schema({
  telegramId:    { type: Number, required: true, unique: true },
  referralCode:  { type: String },
  agentKpayNumber:  { type: String, default: '' },
  agentKpayName:    { type: String, default: '' },
  hasWave:          { type: Boolean, default: false },
  milestones: {
    1:  { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} },
    2:  { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} },
    3:  { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} },
    4:  { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} },
    5:  { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} },
    6:  { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} },
    7:  { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} },
    8:  { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} },
    9:  { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} },
    10: { current:{type:Number,default:0}, claimed:{type:Boolean,default:false} }
  },
  totalEarned:   { type: Number, default: 0 },
  completedBoxes:{ type: Number, default: 0 },
  isActive:      { type: Boolean, default: true },
  createdAt:     { type: Date, default: Date.now }
});
agentSchema.index({ telegramId: 1 });

const BOX_CONFIG = [
  { box:1, people:5,   perPerson:1000,  bonus:500      },
  { box:2, people:10,  perPerson:2000,  bonus:2000     },
  { box:3, people:30,  perPerson:3000,  bonus:10000    },
  { box:4, people:50,  perPerson:5000,  bonus:30000    },
  { box:5, people:70,  perPerson:10000, bonus:80000    },
  { box:6, people:100, perPerson:20000, bonus:300000   },
  { box:7, people:150, perPerson:30000, bonus:800000   },
  { box:8, people:200, perPerson:50000, bonus:2000000  },
  { box:9, people:70,  perPerson:70000, bonus:1000000  },
  { box:10,people:10,  perPerson:2000,  bonus:2000,    loop:true }
];

const User = mongoose.model('User', userSchema);
const Deposit = mongoose.model('Deposit', depositSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
const Game = mongoose.model('Game', gameSchema);
const Settings = mongoose.model('Settings', settingsSchema);
const RedeemCode = mongoose.model('RedeemCode', redeemCodeSchema);
const Agent = mongoose.model('Agent', agentSchema);

// ===== In-Memory =====
const waitingQueue = [];
const activeGames = new Map();
const gameTurnTimeouts = new Map();
const gameTimerIntervals = new Map();  // server-side tick intervals per game   // reused for game end timers
const userSockets = new Map();
const searchNotifications = new Map();
const searchTimeouts = new Map();
const fakeGameIds = new Set();
const aiScoreIntervals = new Map();   // ★ AI score simulation intervals

// ===== Concurrency Protection =====
const processingUsers = new Set();
const moveCooldowns    = new Map();
const findGameCooldowns = new Map();
const MOVE_COOLDOWN_MS     = 300;
const FINDGAME_COOLDOWN_MS = 2000;

// ===== Helpers =====
function genRefCode(id) {
  return 'TIC' + id.toString(36).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();
}
function genGameId() {
  return 'g' + Date.now() + Math.random().toString(36).substr(2,5);
}

function verifyTgAuth(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return null;
    const check = Array.from(p.entries())
      .filter(([k]) => k !== 'hash')
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([k,v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
    const hmac = crypto.createHmac('sha256',secret).update(check).digest('hex');
    if (hmac !== hash) return null;
    const u = p.get('user');
    return u ? JSON.parse(u) : null;
  } catch { return null; }
}

// ===== Settings Helpers =====
async function getSetting(key, def) {
  try { const s=await Settings.findOne({key}).lean(); return s?s.value:def; } catch { return def; }
}
async function setSetting(key,value) {
  await Settings.findOneAndUpdate({key},{value},{upsert:true});
}

// ===== AI Config =====
const AI_ID = -999999;
const AI_NAMES = [
  'Min Khant Kyaw','Thura Aung','Nay Chi Win','Su Myat Noe','Kyaw Zin Htet',
  'Aye Chan Ko','Phyu Phyu Win','Kaung Myat Thu','Zaw_Lin_Htet','Myo_Min_Tun',
  'Ei_Thandar_Phyu','Ko_Phyo_99','Mg_Kaung_Mandalay','Shine_Htet_Aung','AungKyaw2026',
  'Htet_Naing_88','Khin_Su_112','Bo_Bo_Gyi_007','Thin_Zar_9','Kyaw_Kyaw_MM'
];
function randomAIName() { return AI_NAMES[Math.floor(Math.random()*AI_NAMES.length)]; }
const AI_TYPE_SABOTAGE = 'sabotage';

// ★ ===== Candy Crush AI Game =====
async function startCandyAIGame(socket, userId, gameId, userName) {
  const u = await User.findOneAndUpdate(
    { telegramId: userId, balance: { $gte: ENTRY_FEE }, isBanned: { $ne: true } },
    { $inc: { balance: -ENTRY_FEE } },
    { new: true }
  );
  if (!u) {
    return socket.emit('insufficientBalance', { balance: 0, required: ENTRY_FEE });
  }
  const aiName = randomAIName();
  const gameState = {
    gameId, players: [userId, AI_ID],
    scores: { [userId]: 0, [AI_ID]: 0 },
    status: 'active', isAIGame: true,
    aiType: AI_TYPE_SABOTAGE,
    startedAt: Date.now(), lastMoveAt: Date.now(),
    playerNames: { [userId]: userName, [AI_ID]: aiName }
  };
  activeGames.set(gameId, gameState);
  socket.join(gameId);

  socket.emit('gameStarted', {
    gameId,
    duration: GAME_DURATION_S,
    players: gameState.playerNames,
    myId: userId,
    opponentId: AI_ID,
    opponentName: aiName
  });

  // Start AI score simulation
  scheduleAICandyScore(gameId, userId);

  // Start game timer
  const t = setTimeout(() => endCandyGameAI(gameId, null, 'timeup'), GAME_DURATION_S * 1000 + 1500);
  gameTurnTimeouts.set(gameId, t);
  console.log('Candy AI game started:', gameId, 'User:', userId, 'vs AI:', aiName);
}

// ★ AI fake scoring — gradually increases to beat user
function scheduleAICandyScore(gameId, userId) {
  const game = activeGames.get(gameId);
  if (!game || game.status !== 'active') return;

  const elapsed = Date.now() - game.startedAt;
  const remaining = GAME_DURATION_S * 1000 - elapsed;
  if (remaining <= 0) return;

  // AI scores every 10-18 seconds, with 40-120 pts per burst
  const delay = 10000 + Math.random() * 8000;
  const pts = 40 + Math.floor(Math.random() * 80);

  const t = setTimeout(() => {
    const g = activeGames.get(gameId);
    if (!g || g.status !== 'active') return;

    g.scores[AI_ID] = (g.scores[AI_ID] || 0) + pts;
    g.lastMoveAt = Date.now();

    const userSockId = userSockets.get(userId);
    const userSock = userSockId ? io.sockets.sockets.get(userSockId) : null;
    if (userSock) {
      userSock.emit('opponentScore', { score: g.scores[AI_ID], playerId: AI_ID });
    }

    scheduleAICandyScore(gameId, userId); // reschedule
  }, delay);

  // Store for cleanup
  if (!aiScoreIntervals.has(gameId)) aiScoreIntervals.set(gameId, []);
  aiScoreIntervals.get(gameId).push(t);
}

// ★ End AI candy crush game
async function endCandyGameAI(gameId, forcedWinner = null, reason = 'timeup') {
  const game = activeGames.get(gameId);
  if (!game || (game.status !== 'active' && game.status !== 'ending')) return;
  clearTurnTimer(gameId);
  clearAIIntervals(gameId);
  game.status = 'completed';

  const humanId = game.players.find(p => p !== AI_ID);
  const humanScore = game.scores[humanId] || 0;
  const aiScore = game.scores[AI_ID] || 0;

  // Determine winner (AI always wins in sabotage mode at end)
  let winner = forcedWinner;
  if (winner === null) {
    winner = AI_ID; // AI sabotage always wins
  }

  try {
    if (winner === humanId) {
      await User.findOneAndUpdate({ telegramId: humanId }, { $inc: { balance: WIN_PRIZE, wins: 1, totalGames: 1 } });
    } else if (winner === -1) {
      if (humanId) await User.findOneAndUpdate({ telegramId: humanId }, { $inc: { balance: DRAW_REFUND, totalGames: 1 } });
    } else {
      if (humanId) await User.findOneAndUpdate({ telegramId: humanId }, { $inc: { losses: 1, totalGames: 1 } });
    }
    await Game.findOneAndUpdate({ gameId }, {
      winner, status: 'completed',
      scores: game.scores,
      playerNames: game.playerNames,
      winnerName: winner === -1 ? 'draw' : (game.playerNames?.[winner] || String(winner)),
      isAIGame: true
    }, { upsert: true });
  } catch(e) { console.error('endCandyGameAI err:', e); }

  io.to(gameId).emit('gameOver', {
    winner,
    reason,
    scores: game.scores,
    myScore: humanScore,
    opponentScore: aiScore
  });

  // Cleanup
  activeGames.delete(gameId);
  clearAIIntervals(gameId);
  if (humanId) {
    const t = searchTimeouts.get(humanId);
    if (t) { clearTimeout(t); searchTimeouts.delete(humanId); }
    moveCooldowns.delete(humanId);
    findGameCooldowns.delete(humanId);
    processingUsers.delete(humanId);
  }
}

function clearAIIntervals(gameId) {
  const timers = aiScoreIntervals.get(gameId) || [];
  timers.forEach(t => clearTimeout(t));
  aiScoreIntervals.delete(gameId);
}

// ★ Fake disconnect sabotage (when user would win)
async function handleSabotage(game, userId) {
  game.status = 'ending';
  clearTurnTimer(game.gameId);
  clearAIIntervals(game.gameId);

  const userSocketId = userSockets.get(userId);
  const userSocket = userSocketId ? io.sockets.sockets.get(userSocketId) : null;
  if (userSocket) {
    userSocket.emit('fakeDisconnect', {
      message: 'မိတ်ဆွေ၏ Internet လိုင်းကျနေပါသည်၊ ပြန်လည်ချိတ်ဆက်နေပါသည်...'
    });
  }
  const delayMs = 4000 + Math.random() * 2000;
  setTimeout(async () => {
    const g = activeGames.get(game.gameId);
    if (!g) return;
    await endCandyGameAI(game.gameId, AI_ID, 'connectionLost');
  }, delayMs);
}

// ===== Bot =====
let bot = null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  const CHANNEL_USERNAME = 'EzMoneyPayy';
  const CHANNEL_LINK = 'https://t.me/EzMoneyPayy';

  async function isChannelMember(userId) {
    try {
      const member = await bot.telegram.getChatMember(`@${CHANNEL_USERNAME}`, userId);
      return ['member','administrator','creator'].includes(member.status);
    } catch(e) { return false; }
  }

  bot.start(async (ctx) => {
    try {
      const id = ctx.from.id;
      const args = ctx.payload;
      const maint = await getSetting('maintenance', false);
      if (maint && id !== ADMIN_ID) {
        try { await ctx.reply('🔧 ဆာဗာ ပြင်ဆင်နေသောကြောင့် ယာယီပိတ်ထားပါသည်။'); } catch(e){}
        return;
      }
      let user = await User.findOne({ telegramId: id });
      if (!user) {
        user = new User({ telegramId: id, username: ctx.from.username||'', firstName: ctx.from.first_name||'', referralCode: genRefCode(id) });
        if (args && args.length > 3) {
          const ref = await User.findOne({ referralCode: args }).lean();
          if (ref && ref.telegramId !== id) user.referredBy = ref.telegramId;
        }
        await user.save();
      }
      const isMember = await isChannelMember(id);
      if (!isMember) {
        await ctx.reply(`👋 မင်္ဂလာပါ ${ctx.from.first_name}!\n\n🍭 ကစားရန် ဦးစွာ Channel ကို Join ဖြစ်ရပါမည်!\n\n📢 Join ပြုလုပ်ပြီးနောက် <b>/start</b> ကို ထပ်နှိပ်ပါ`,{parse_mode:'HTML',...Markup.inlineKeyboard([[Markup.button.url('📢 Channel Join ရန်', CHANNEL_LINK)],[Markup.button.callback('✅ Join ပြီးပြီ — စစ်ဆေးပါ','check_join')]])}).catch(()=>{});
        return;
      }
      await ctx.reply(`🍭 မင်္ဂလာပါ ${ctx.from.first_name}!\n\n💰 လက်ကျန်: ${user.balance.toLocaleString()} MMK\n🏆 နိုင်: ${user.wins}  •  ❌ ရှုံး: ${user.losses}`,Markup.inlineKeyboard([[Markup.button.webApp('🍭 PLAY NOW', FRONTEND_URL)],[Markup.button.callback('💰 Balance','bal'), Markup.button.callback('🔗 Referral','ref')]])).catch(()=>{});
    } catch(e) { console.error('Error in /start:', e.stack || e); ctx.reply('⚠️ ဆာဗာ ချိတ်ဆက်မှု ပြဿနာ').catch(()=>{}); }
  });

  bot.action('check_join', async (ctx) => {
    try {
      await ctx.answerCbQuery('စစ်ဆေးနေပါသည်...').catch(()=>{});
      const id = ctx.from.id;
      const isMember = await isChannelMember(id);
      if (!isMember) {
        await ctx.reply(`❌ Channel Join မပြုလုပ်ရသေးပါ!\n\nChannel ကို Join ပြုလုပ်ပြီးမှ ထပ်စစ်ဆေးပါ 👇`,Markup.inlineKeyboard([[Markup.button.url('📢 Channel Join ရန်', CHANNEL_LINK)],[Markup.button.callback('✅ Join ပြီးပြီ — စစ်ဆေးပါ','check_join')]])).catch(()=>{});
        return;
      }
      const user = await User.findOne({ telegramId: id }).lean();
      if (!user) { await ctx.reply('⚠️ /start ကိုနှိပ်ပါ').catch(()=>{}); return; }
      await ctx.reply(`✅ Channel Join အောင်မြင်သည်!\n\n🍭 မင်္ဂလာပါ ${ctx.from.first_name}!\n💰 လက်ကျန်: ${user.balance.toLocaleString()} MMK`,Markup.inlineKeyboard([[Markup.button.webApp('🍭 PLAY NOW', FRONTEND_URL)],[Markup.button.callback('💰 Balance','bal'), Markup.button.callback('🔗 Referral','ref')]])).catch(()=>{});
    } catch(e) { console.error('check_join error:', e.stack || e); }
  });

  bot.action('bal', async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(()=>{});
      const u = await User.findOne({ telegramId: ctx.from.id }).lean();
      if (!u) return;
      await ctx.reply(`💰 လက်ကျန်: ${u.balance.toLocaleString()} MMK\n🎮 ကစားမှု: ${u.totalGames}\n🏆 နိုင်: ${u.wins}  •  ❌ ရှုံး: ${u.losses}`,Markup.inlineKeyboard([[Markup.button.webApp('🍭 ကစားမည်', FRONTEND_URL)]])).catch(()=>{});
    } catch(e) { console.error('bal error:', e.stack || e); }
  });

  bot.action('ref', async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(()=>{});
      const u = await User.findOne({ telegramId: ctx.from.id }).lean();
      if (!u) return;
      const link = `https://t.me/${BOT_USERNAME}?start=${u.referralCode}`;
      await ctx.reply(`🔗 <b>Referral Link</b>\n\nသူငယ်ချင်း တစ်ယောက် 1,000 MMK ဖြည့်တိုင်း သင် <b>100 MMK</b> ရမည်!\n\n<code>${link}</code>`,{parse_mode:'HTML',...Markup.inlineKeyboard([[Markup.button.url('📤 Share',`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('🍭 Candy Crush ကစားပြီးငွေရှာကြစို့!')}`)]])}).catch(()=>{});
    } catch(e) { console.error('ref error:', e.stack || e); }
  });

  bot.action(/^join_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery('ချိတ်ဆက်နေပါသည်...').catch(()=>{});
      const gameId = ctx.match[1];
      const id = ctx.from.id;
      try { await ctx.deleteMessage(); } catch(e){}
      const user = await User.findOne({ telegramId: id }).lean();
      if (!user) { await ctx.reply('ဦးစွာ /start နှိပ်ပါ').catch(()=>{}); return; }
      if (user.balance < ENTRY_FEE) {
        await ctx.reply(`⚠️ ငွေမလုံလောက်ပါ!\n\nပွဲဝင်ကြေး: ${ENTRY_FEE.toLocaleString()} MMK\nသင့်ကျန်: ${user.balance.toLocaleString()} MMK`,Markup.inlineKeyboard([[Markup.button.webApp('💰 ငွေဖြည့်ရန်', FRONTEND_URL)]])).catch(()=>{});
        return;
      }
      await ctx.reply('✅ ပွဲတွင် ဝင်ရောက်ရန် Join ကိုနှိပ်ပါ',Markup.inlineKeyboard([[Markup.button.webApp('🍭 JOIN NOW', `${FRONTEND_URL}/play.html?join=${gameId}`)]])).catch(()=>{});
    } catch(e) { console.error('join action err:', e.stack || e); }
  });

  bot.action('dismiss', async (ctx) => {
    try { await ctx.answerCbQuery().catch(()=>{}); await ctx.deleteMessage().catch(()=>{}); } catch(e){}
  });

  bot.command('admin', async (ctx) => {
    try {
      const id = ctx.from.id;
      if (!ADMIN_ID || id !== ADMIN_ID) { await ctx.reply('🚫 Admin အကောင့်မဟုတ်ပါ။').catch(()=>{}); return; }
      await ctx.reply(`🛡️ <b>Admin Panel</b>\n\nမင်္ဂလာပါ Admin!`,{parse_mode:'HTML',...Markup.inlineKeyboard([[Markup.button.webApp('🛡️ Admin Panel ဝင်ရန်', `${FRONTEND_URL}/admin.html`)]])}).catch(()=>{});
    } catch(e) { console.error('admin cmd err:', e.stack || e); }
  });

  bot.command('agent', async (ctx) => {
    try {
      const id = ctx.from.id;
      const user = await User.findOne({ telegramId: id }).lean();
      if (!user) { await ctx.reply('ဦးစွာ /start နှိပ်ပါ').catch(()=>{}); return; }
      if (user.role !== 'agent') { await ctx.reply('🚫 သင်သည် အေးဂျင့် မဟုတ်သေးပါ').catch(()=>{}); return; }
      await ctx.reply(`🎯 <b>Agent Panel</b>`,{parse_mode:'HTML',...Markup.inlineKeyboard([[Markup.button.webApp('🎯 Agent Panel သို့ဝင်ရန်', `${FRONTEND_URL}/agent.html`)]])}).catch(()=>{});
    } catch(e) { console.error('agent cmd err:', e.stack || e); }
  });

  bot.catch((err, ctx) => {
    if (err.response && err.response.error_code === 403) { console.log(`User blocked the bot.`); }
    else { console.error('Bot global error:', err, ctx?.update); }
  });

  bot.launch().then(()=>console.log('✅ Bot launched')).catch(e=>console.error('Bot launch err:',e));
}

// ===== Notify Helpers =====
function obfuscateUsername(username) {
  if (!username) return '';
  if (username.length <= 3) return username;
  return username.substring(0, 3) + '...';
}

async function notifyUsersGameSearch(searcherId, gameId) {
  if (!bot) return;
  try {
    const [searcher, allUsers] = await Promise.all([
      User.findOne({ telegramId: searcherId }).select('firstName username').lean(),
      User.find({ telegramId: { $ne: searcherId }, isBanned: { $ne: true } }).select('telegramId lastActive').lean()
    ]);
    const displayName = searcher?.username ? obfuscateUsername(searcher.username) : (searcher?.firstName || 'တစ်ယောက်');
    const msgText = `🍭 <b>${displayName}</b> ပွဲရှာနေသည်!\n\n⏱ ${SEARCH_TIMEOUT_S} စက္ကန့်အတွင်း Join မနှိပ်ရင် ပွဲပျောက်မည်\n💰 ဝင်ကြေး: ${ENTRY_FEE.toLocaleString()} MMK  •  🏆 ဆု: ${WIN_PRIZE.toLocaleString()} MMK`;
    const replyMarkup = { inline_keyboard: [[{text:'🍭 ကစားမည်', callback_data:`join_${gameId}`},{text:'❌ မကစားဘူး', callback_data:'dismiss'}]]};
    const onlineUsers  = allUsers.filter(u => userSockets.has(u.telegramId));
    const offlineUsers = allUsers.filter(u => !userSockets.has(u.telegramId)).sort((a,b)=>(b.lastActive||0)-(a.lastActive||0));
    const sent = [];
    const onlineResults = await Promise.allSettled(onlineUsers.map(async u => {
      try { const msg = await bot.telegram.sendMessage(u.telegramId, msgText, {parse_mode:'HTML',reply_markup:replyMarkup}); return {userId:u.telegramId,msgId:msg.message_id}; } catch(e){return null;}
    }));
    onlineResults.forEach(r => { if (r.status==='fulfilled' && r.value) sent.push(r.value); });
    setImmediate(async () => {
      const CHUNK = 25;
      for (let i=0;i<offlineUsers.length;i+=CHUNK) {
        if (!waitingQueue.find(w=>w.gameId===gameId)) break;
        const batch = offlineUsers.slice(i,i+CHUNK);
        await Promise.allSettled(batch.map(async u => {
          try { const msg = await bot.telegram.sendMessage(u.telegramId, msgText, {parse_mode:'HTML',reply_markup:replyMarkup}); sent.push({userId:u.telegramId,msgId:msg.message_id}); } catch(e){}
        }));
        if (i+CHUNK<offlineUsers.length) await new Promise(r=>setTimeout(r,50));
      }
    });
    searchNotifications.set(gameId, sent);
  } catch(e){ console.error('notify err:', e.stack || e); }
}

async function deleteSearchMsgs(gameId) {
  if (!bot) return;
  const msgs = searchNotifications.get(gameId);
  if (!msgs) return;
  searchNotifications.delete(gameId);
  for (const {userId, msgId} of msgs) {
    try { await bot.telegram.deleteMessage(userId, msgId); await new Promise(r=>setTimeout(r,30)); } catch(e){}
  }
}

async function sendFakeSearchNotification() {
  if (!bot) return;
  const fakeEnabled = await getSetting('fakeNotifications', false);
  if (!fakeEnabled) return;
  const fakeGameId = genGameId();
  fakeGameIds.add(fakeGameId);
  const fakeName = randomAIName();
  const displayName = obfuscateUsername(fakeName);
  const allFakeUsers = await User.find({ isBanned: { $ne: true } }).select('telegramId lastActive').lean();
  const fakeOnline  = allFakeUsers.filter(u => userSockets.has(u.telegramId));
  const fakeOffline = allFakeUsers.filter(u => !userSockets.has(u.telegramId)).sort((a,b)=>(b.lastActive||0)-(a.lastActive||0));
  const users = [...fakeOnline, ...fakeOffline];
  const sent = [];
  const CHUNK = 30;
  const fakeMsgText = `🍭 <b>${displayName}</b> ပွဲရှာနေသည်!\n\n⏱ ${SEARCH_TIMEOUT_S} စက္ကန့်အတွင်း Join မနှိပ်ရင် ပွဲပျောက်မည်\n💰 ဝင်ကြေး: ${ENTRY_FEE.toLocaleString()} MMK  •  🏆 ဆု: ${WIN_PRIZE.toLocaleString()} MMK`;
  for (let i=0;i<users.length;i+=CHUNK) {
    const batch = users.slice(i,i+CHUNK);
    await Promise.allSettled(batch.map(async u => {
      try { const msg = await bot.telegram.sendMessage(u.telegramId, fakeMsgText, {parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'🍭 ကစားမည်',callback_data:`join_${fakeGameId}`},{text:'❌ မကစားဘူး',callback_data:'dismiss'}]]}}); sent.push({userId:u.telegramId,msgId:msg.message_id}); } catch(e){}
    }));
    if (i+CHUNK<users.length) await new Promise(r=>setTimeout(r,100));
  }
  searchNotifications.set(fakeGameId, sent);
  setTimeout(() => deleteSearchMsgs(fakeGameId), 3600000);
}

// ===== Zombie cleanup =====
setInterval(async () => {
  const now = Date.now();
  const IDLE_LIMIT_MS = (GAME_DURATION_S + 60) * 1000;
  for (const [gameId, game] of activeGames.entries()) {
    if (game.status !== 'active') continue;
    const lastMove = game.lastMoveAt || game.startedAt || 0;
    if (now - lastMove < IDLE_LIMIT_MS) continue;
    console.log(`🧹 Zombie game cleanup: ${gameId}`);
    try {
      if (game.isAIGame) {
        await endCandyGameAI(gameId, -1, 'timeout');
      } else {
        for (const pid of (game.players || [])) {
          await User.findOneAndUpdate({telegramId:pid},{$inc:{balance:ENTRY_FEE}}).catch(()=>{});
        }
        io.to(gameId).emit('gameOver', { winner: -1, reason: 'timeout', scores: game.scores || {} });
        activeGames.delete(gameId);
        clearTurnTimer(gameId);
        for (const pid of (game.players || [])) {
          const t = searchTimeouts.get(pid); if (t) { clearTimeout(t); searchTimeouts.delete(pid); }
        }
        setTimeout(()=>deleteSearchMsgs(gameId),500);
      }
    } catch(e) { console.error('Zombie cleanup err:', e); }
  }
}, 5 * 60 * 1000);

let fakeNotifTimer = null;
async function scheduleFakeNotification() {
  if (fakeNotifTimer) { clearTimeout(fakeNotifTimer); fakeNotifTimer = null; }
  const intervalMins = await getSetting('fakeNotifInterval', 3);
  const delay = Math.max(1, Number(intervalMins)) * 60 * 1000;
  fakeNotifTimer = setTimeout(async () => {
    await sendFakeSearchNotification();
    scheduleFakeNotification();
  }, delay);
}
scheduleFakeNotification();

// ===== Game Timer Helper =====
function clearTurnTimer(gameId) {
  const t = gameTurnTimeouts.get(gameId);
  if (t) { clearTimeout(t); gameTurnTimeouts.delete(gameId); }
}

// ★ ===== End PvP Game (score-based) =====
async function endGame(gameId, winner, reason='timeup') {
  const game = activeGames.get(gameId);
  if (!game || (game.status !== 'active' && game.status !== 'ending')) return;
  clearTurnTimer(gameId);
  game.status = 'completed';
  const winnerId = winner === -1 ? -1 : Number(winner);

  try {
    if (winnerId === -1) {
      for (const pid of game.players) {
        await User.findOneAndUpdate({telegramId:pid},{$inc:{balance:DRAW_REFUND,totalGames:1}});
      }
    } else if (winnerId) {
      const loser = game.players.find(p => Number(p) !== winnerId);
      await User.findOneAndUpdate({telegramId:winnerId},{$inc:{balance:WIN_PRIZE,wins:1,totalGames:1}});
      if (loser) await User.findOneAndUpdate({telegramId:loser},{$inc:{losses:1,totalGames:1}});
    }
    await Game.findOneAndUpdate({gameId},{
      winner: winnerId, status:'completed',
      scores: game.scores,
      playerNames: game.playerNames,
      winnerName: winnerId===-1 ? 'draw' : (game.playerNames?.[winnerId] || String(winnerId)),
      isAIGame: !!game.isAIGame
    },{upsert:true});
  } catch(e){ console.error('endGame err:', e.stack || e); }

  io.to(gameId).emit('gameOver', {
    winner: winnerId,
    reason,
    scores: game.scores
  });

  activeGames.delete(gameId);
  clearTurnTimer(gameId);
  // Clear server-side tick interval
  const giv = gameTimerIntervals.get(gameId);
  if (giv) { clearInterval(giv); gameTimerIntervals.delete(gameId); }
  for (const pid of (game.players || [])) {
    const t = searchTimeouts.get(pid);
    if (t) { clearTimeout(t); searchTimeouts.delete(pid); }
    moveCooldowns.delete(pid);
    findGameCooldowns.delete(pid);
    processingUsers.delete(pid);
  }
  setTimeout(()=>deleteSearchMsgs(gameId),500);
}

// ===== Socket =====
io.on('connection', (socket) => {
  let myUserId = null;
  let myGameId = null;

  socket.on('findGame', async ({userId}) => {
    if (!userId) return socket.emit('error',{msg:'userId မပါ'});
    myUserId = parseInt(userId);

    const lastFG = findGameCooldowns.get(myUserId) || 0;
    if (Date.now() - lastFG < FINDGAME_COOLDOWN_MS) return socket.emit('error',{msg:'နည်းနည်းစောင့်ပါ...'});
    findGameCooldowns.set(myUserId, Date.now());

    if (processingUsers.has(myUserId)) return socket.emit('error',{msg:'ရှာဖွေနေဆဲ ဖြစ်သည်'});
    processingUsers.add(myUserId);

    try {
      userSockets.set(myUserId, socket.id);

      const existEntry = [...activeGames.entries()].find(([,g])=>g.players.includes(myUserId));
      if (existEntry) {
        const [gid, game] = existEntry;
        myGameId = gid;
        socket.join(gid);
        const oppId = game.players.find(p => p !== myUserId);
        const elapsed = Date.now() - (game.startedAt || Date.now());
        const tLeft = Math.max(0, GAME_DURATION_S - Math.floor(elapsed/1000));
        socket.emit('gameResumed',{
          gameId: gid,
          duration: GAME_DURATION_S,
          timeLeft: tLeft,
          players: game.playerNames,
          myId: myUserId,
          opponentId: oppId,
          myScore: game.scores[myUserId] || 0,
          opponentScore: game.scores[oppId] || 0,
          elapsedMs: elapsed
        });
        return;
      }

      const user = await User.findOne({telegramId:myUserId}).lean();
      if (!user) return socket.emit('error',{msg:'User မတွေ့ပါ'});
      if (user.isBanned===true) return socket.emit('error',{msg:'ကောင်ပိတ်ဆို့ထားသည်'});
      if (user.balance < ENTRY_FEE) return socket.emit('insufficientBalance',{balance:user.balance,required:ENTRY_FEE});

      User.findOneAndUpdate({telegramId:myUserId},{lastActive:new Date()}).catch(()=>{});

      const allBotMode = await getSetting('allBotMode', false);
      const joinGameId = socket.handshake.query?.join;

      if (joinGameId && fakeGameIds.has(joinGameId)) {
        if (allBotMode) {
          const gameId = genGameId(); myGameId = gameId;
          const uName = user.firstName || user.username || `User${myUserId}`;
          await startCandyAIGame(socket, myUserId, gameId, uName);
          await deleteSearchMsgs(joinGameId); return;
        } else {
          deleteSearchMsgs(joinGameId); fakeGameIds.delete(joinGameId);
        }
      }

      if (allBotMode) {
        const gameId = genGameId(); myGameId = gameId;
        const uName = user.firstName || user.username || `User${myUserId}`;
        await startCandyAIGame(socket, myUserId, gameId, uName); return;
      }

      if (user.botMode && allBotMode) {
        const gameId = genGameId(); myGameId = gameId;
        const uName = user.firstName || user.username || `User${myUserId}`;
        await startCandyAIGame(socket, myUserId, gameId, uName); return;
      }

      // Normal matchmaking
      let waiterIdx = -1;
      if (joinGameId) waiterIdx = waitingQueue.findIndex(w=>w.gameId===joinGameId && w.userId!==myUserId);
      if (waiterIdx === -1) waiterIdx = waitingQueue.findIndex(w=>w.userId!==myUserId);

      if (waiterIdx !== -1) {
        const waiter = waitingQueue.splice(waiterIdx,1)[0];
        myGameId = waiter.gameId;

        const timeout = searchTimeouts.get(myUserId);
        if (timeout) { clearTimeout(timeout); searchTimeouts.delete(myUserId); }

        try {
          const [w1, w2] = await Promise.all([
            User.findOneAndUpdate({telegramId:waiter.userId,balance:{$gte:ENTRY_FEE}},{$inc:{balance:-ENTRY_FEE}},{new:true}),
            User.findOneAndUpdate({telegramId:myUserId,balance:{$gte:ENTRY_FEE}},{$inc:{balance:-ENTRY_FEE}},{new:true})
          ]);
          if (!w1||!w2) {
            await Promise.all([
              w1 ? User.findOneAndUpdate({telegramId:waiter.userId},{$inc:{balance:ENTRY_FEE}}) : Promise.resolve(),
              w2 ? User.findOneAndUpdate({telegramId:myUserId},{$inc:{balance:ENTRY_FEE}}) : Promise.resolve()
            ]);
            if (!w1) {
              const waiterSockId = userSockets.get(waiter.userId);
              const waiterSock = waiterSockId ? io.sockets.sockets.get(waiterSockId) : null;
              const wUser = await User.findOne({telegramId:waiter.userId}).select('balance').lean();
              if (waiterSock) waiterSock.emit('insufficientBalance',{balance:wUser?.balance||0,required:ENTRY_FEE});
            } else { waitingQueue.push(waiter); }
            if (!w2) {
              const jUser = await User.findOne({telegramId:myUserId}).select('balance').lean();
              return socket.emit('insufficientBalance',{balance:jUser?.balance||0,required:ENTRY_FEE});
            }
            return;
          }
        } catch(e) { waitingQueue.push(waiter); return socket.emit('error',{msg:'ငွေ ဆုတ်ယူ မအောင်မြင်ပါ'}); }

        const waiterUser = await User.findOne({telegramId:waiter.userId}).lean();
        const joinerUser = user;

        // ★ Candy crush game state (score-based, no board/symbols)
        const gameState = {
          gameId: myGameId, players: [waiter.userId, myUserId],
          scores: { [waiter.userId]: 0, [myUserId]: 0 },
          status: 'active',
          startedAt: Date.now(), lastMoveAt: Date.now(),
          playerNames: {
            [waiter.userId]: waiterUser?.firstName||waiterUser?.username||`User${waiter.userId}`,
            [myUserId]: joinerUser?.firstName||joinerUser?.username||`User${myUserId}`
          }
        };
        activeGames.set(myGameId, gameState);
        new Game({gameId:myGameId, players:gameState.players, status:'active'}).save().catch(e=>console.error('Game save:',e));

        socket.join(myGameId);
        const waiterSocket = io.sockets.sockets.get(waiter.socketId);
        if (waiterSocket) waiterSocket.join(myGameId);

        // ★ Emit gameStarted with duration (no symbols/board)
        const basePayload = {
          gameId: myGameId,
          duration: GAME_DURATION_S,
          players: gameState.playerNames
        };
        socket.emit('gameStarted', {...basePayload, myId: myUserId, opponentId: waiter.userId, opponentName: gameState.playerNames[waiter.userId]});
        if (waiterSocket) waiterSocket.emit('gameStarted', {...basePayload, myId: waiter.userId, opponentId: myUserId, opponentName: gameState.playerNames[myUserId]});

        await deleteSearchMsgs(myGameId);

        // ── Server-side game clock ──────────────────────────────────
        // Tick every second: broadcast timeLeft to both players,
        // check WIN_SCORE threshold, end game when time reaches 0.
        let ticksLeft = GAME_DURATION_S;
        const tickInterval = setInterval(async () => {
          const g = activeGames.get(myGameId);
          if (!g || g.status !== 'active') { clearInterval(tickInterval); gameTimerIntervals.delete(myGameId); return; }
          ticksLeft--;
          // Broadcast current time to both players in the room
          io.to(myGameId).emit('timeTick', { timeLeft: ticksLeft });
          // Instant win: check if either player reached WIN_SCORE
          const p1s = g.scores[g.players[0]] || 0;
          const p2s = g.scores[g.players[1]] || 0;
          if (p1s >= WIN_SCORE || p2s >= WIN_SCORE) {
            clearInterval(tickInterval); gameTimerIntervals.delete(myGameId);
            const winner = p1s >= WIN_SCORE ? g.players[0] : g.players[1];
            await endGame(myGameId, winner, 'score_win');
            return;
          }
          // Time up
          if (ticksLeft <= 0) {
            clearInterval(tickInterval); gameTimerIntervals.delete(myGameId);
            const w = p1s > p2s ? g.players[0] : p2s > p1s ? g.players[1] : -1;
            await endGame(myGameId, w, 'timeup');
          }
        }, 1000);
        gameTimerIntervals.set(myGameId, tickInterval);

      } else {
        const gameId = genGameId();
        myGameId = gameId;
        socket.join(gameId);
        waitingQueue.push({socketId:socket.id, userId:myUserId, gameId});
        socket.emit('waitingForPlayer',{gameId, searchTimeout:SEARCH_TIMEOUT_S});
        notifyUsersGameSearch(myUserId, gameId);

        const timeout = setTimeout(() => {
          if (socket.connected) socket.emit('searchUpdate',{message:'လက်ရှိဆော့ကစားနေသူမရှိသေးပါ ဆက်လက်ရှာဖွေဖို့'});
        }, SEARCH_TIMEOUT_S * 1000);
        searchTimeouts.set(myUserId, timeout);
      }
    } catch(e) {
      console.error('findGame err:', e);
      socket.emit('error',{msg:'ဆာဗာ error ဖြစ်သည်'});
    } finally {
      processingUsers.delete(myUserId);
    }
  });

  // ★ ===== Score Update (replaces makeMove for Candy Crush) =====
  socket.on('scoreUpdate', async ({gameId, score}) => {
    const lastMove = moveCooldowns.get(myUserId) || 0;
    if (Date.now() - lastMove < MOVE_COOLDOWN_MS) return;
    moveCooldowns.set(myUserId, Date.now());

    try {
      const game = activeGames.get(gameId);
      if (!game || game.status !== 'active') return;
      if (!game.players.includes(myUserId)) return;

      const prevScore = game.scores[myUserId] || 0;
      const newScore = Math.max(prevScore, parseInt(score) || 0);

      // ★ Sabotage check for AI games: if user would overtake AI, trigger disconnect
      if (game.isAIGame && game.aiType === AI_TYPE_SABOTAGE) {
        const aiScore = game.scores[AI_ID] || 0;
        // If user's new score would beat AI by >200 pts, trigger sabotage
        if (newScore > aiScore + 200) {
          game.status = 'ending';
          await handleSabotage(game, myUserId);
          return;
        }
      }

      game.scores[myUserId] = newScore;
      game.lastMoveAt = Date.now();

      // ── Broadcast score to ALL players in room instantly ──
      // Using io.to(room) ensures zero-lag delivery even if opponent
      // reconnects on a new socket mid-game.
      io.to(gameId).emit('scoreUpdate', {
        playerId: myUserId,
        score:    newScore,
        scores:   game.scores
      });

      // ── Instant win check (700 pts) ──
      if (!game.isAIGame && newScore >= WIN_SCORE) {
        // Clear the interval timer first so it doesn't fire again
        const iv = gameTimerIntervals.get(gameId);
        if (iv) { clearInterval(iv); gameTimerIntervals.delete(gameId); }
        if (game.status === 'active') {
          await endGame(gameId, myUserId, 'score_win');
        }
      }
    } catch(e) { console.error('scoreUpdate err:', e); }
  });

  // endGameByTime kept for AI games / zombie cleanup compatibility
  async function endGameByTime(gameId) {
    const iv = gameTimerIntervals.get(gameId);
    if (iv) { clearInterval(iv); gameTimerIntervals.delete(gameId); }
    const game = activeGames.get(gameId);
    if (!game || game.status !== 'active') return;
    const [p1, p2] = game.players;
    const s1 = game.scores[p1] || 0, s2 = game.scores[p2] || 0;
    const winner = s1 > s2 ? p1 : s2 > s1 ? p2 : -1;
    await endGame(gameId, winner, 'timeup');
  }

  socket.on('cancelSearch', async ({userId}) => {
    const uid = parseInt(userId||myUserId);
    const idx = waitingQueue.findIndex(w=>w.userId===uid);
    if (idx!==-1) { const {gameId} = waitingQueue[idx]; waitingQueue.splice(idx,1); await deleteSearchMsgs(gameId); }
    const timeout = searchTimeouts.get(uid);
    if (timeout) { clearTimeout(timeout); searchTimeouts.delete(uid); }
    socket.emit('searchCancelled');
  });

  socket.on('disconnect', async () => {
    const wIdx = waitingQueue.findIndex(w=>w.socketId===socket.id);
    if (wIdx!==-1) {
      const {gameId, userId} = waitingQueue[wIdx];
      waitingQueue.splice(wIdx,1);
      await deleteSearchMsgs(gameId);
      const timeout = searchTimeouts.get(userId);
      if (timeout) { clearTimeout(timeout); searchTimeouts.delete(userId); }
    }

    const disconnectedUserId = myUserId;
    const disconnectedGameId = myGameId;

    if (disconnectedUserId) {
      userSockets.delete(disconnectedUserId);
      processingUsers.delete(disconnectedUserId);
      moveCooldowns.delete(disconnectedUserId);
      findGameCooldowns.delete(disconnectedUserId);
    }

    if (disconnectedGameId && activeGames.has(disconnectedGameId)) {
      setTimeout(async () => {
        const reconnected = disconnectedUserId && userSockets.has(disconnectedUserId);
        if (reconnected) return;

        const game = activeGames.get(disconnectedGameId);
        if (!game || game.status !== 'active') return;

        if (game.isAIGame) {
          await endCandyGameAI(disconnectedGameId, AI_ID, 'disconnect');
        } else {
          const opp = game.players.find(p => Number(p) !== Number(disconnectedUserId));
          if (opp) await endGame(disconnectedGameId, opp, 'disconnect');
        }
      }, 5000);
    }
  });

  socket.on('sendEmote', ({ gameId, emote }) => {
    try {
      if (!gameId || !emote || !myUserId) return;
      const game = activeGames.get(gameId);
      if (!game || game.status !== 'active') return;
      if (!game.players.includes(myUserId)) return;
      io.to(gameId).emit('emoteReceived', { senderId: myUserId, emote });
    } catch(e) { console.error('emote err:', e); }
  });
});

// ===== Admin middleware =====
function isAdmin(req,res,next) {
  const aid = parseInt(req.headers['x-admin-id']||req.query.adminId);
  if (!aid||aid!==ADMIN_ID) return res.status(403).json({error:'Forbidden'});
  next();
}

app.post('/api/admin/verify', async(req,res)=>{
  try {
    const {telegramId}=req.body;
    if (!telegramId) return res.status(400).json({error:'telegramId required'});
    const tid=parseInt(telegramId);
    if (!ADMIN_ID||tid!==ADMIN_ID) return res.status(403).json({error:'Admin မဟုတ်ပါ'});
    res.json({ok:true,adminId:tid});
  } catch(e){ res.status(500).json({error:'Server error'}); }
});

// ===== Agent Milestone Helper =====
async function updateAgentMilestone(agentTelegramId, depositAmount) {
  try {
    const agentUser = await User.findOne({ telegramId: agentTelegramId, role: 'agent' }).lean();
    if (!agentUser) return;
    let agent = await Agent.findOne({ telegramId: agentTelegramId });
    if (!agent) { agent = new Agent({ telegramId: agentTelegramId, referralCode: agentUser.referralCode }); await agent.save(); }
    for (const cfg of BOX_CONFIG) {
      const ms = agent.milestones[cfg.box];
      if (!ms || ms.claimed) continue;
      if (depositAmount >= cfg.perPerson) {
        if (ms.current < cfg.people) agent.milestones[cfg.box].current = ms.current + 1;
      }
    }
    await agent.save();
  } catch(e) { console.error('agentMilestone err:', e); }
}

// ===== Routes =====
app.get('/', (_,res)=>res.json({ok:true,game:'Candy Crush Multiplayer'}));
app.get('/health', (_,res)=>res.json({ok:true,mongodb:isConnected?'connected':'disconnected',activeGames:activeGames.size,queue:waitingQueue.length}));

app.post('/api/auth', async(req,res)=>{
  try {
    const {initData,telegramId:devId} = req.body;
    let tid,username,firstName;
    if (initData) {
      const u=verifyTgAuth(initData);
      if (!u) return res.status(401).json({error:'Telegram auth မှား'});
      tid=u.id; username=u.username||''; firstName=u.first_name||'';
    } else if (devId) {
      tid=parseInt(devId); username=''; firstName='User';
    } else return res.status(401).json({error:'Auth required'});
    const maint=await getSetting('maintenance',false);
    if (maint&&tid!==ADMIN_ID) return res.status(503).json({error:'🔧 ဆာဗာ ပြင်ဆင်နေပါသည်'});
    let user=await User.findOne({telegramId:tid});
    if (!user) { user=new User({telegramId:tid,username,firstName,referralCode:genRefCode(tid)}); await user.save(); }
    else {
      let d=false;
      if (username&&user.username!==username){user.username=username;d=true;}
      if (firstName&&user.firstName!==firstName){user.firstName=firstName;d=true;}
      if (d) await user.save();
    }
    if (user.isBanned) return res.status(403).json({error:'🚫 ကောင်ပိတ်ဆို့ထားပါသည်'});
    res.json({telegramId:user.telegramId,username:user.username||user.firstName||`User${user.telegramId}`,firstName:user.firstName,balance:user.balance,referralCode:user.referralCode,totalGames:user.totalGames,wins:user.wins,losses:user.losses,botMode:user.botMode});
  } catch(e){ console.error(e); res.status(500).json({error:'Server error'}); }
});

app.get('/api/user/:id', async(req,res)=>{
  try {
    const u=await User.findOne({telegramId:parseInt(req.params.id)}).select('balance totalGames wins losses botMode').lean();
    if (!u) return res.status(404).json({error:'Not found'});
    res.json(u);
  } catch(e){ res.status(500).json({error:'Server error'}); }
});

app.post('/api/deposit', async(req,res)=>{
  try {
    const {telegramId,kpayName,transactionId,amount,paymentMethod}=req.body;
    if (!telegramId||!kpayName||!transactionId||!amount) return res.status(400).json({error:'ကွင်းလပ်များ ဖြည့်ပေးပါ'});
    if (parseInt(amount)<500) return res.status(400).json({error:'အနည်းဆုံး 500 MMK'});
    const u=await User.findOne({telegramId:parseInt(telegramId)}).lean();
    if (!u) return res.status(404).json({error:'User not found'});
    if (u.isBanned) return res.status(403).json({error:'ကောင်ပိတ်ဆို့ထားသည်'});
    const dup=await Deposit.findOne({transactionId}).lean();
    if (dup) return res.status(400).json({error:'Transaction ID ကို အသုံးပြုပြီးသည်'});
    const method = (paymentMethod === 'wave') ? 'wave' : 'kpay';
    const methodLabel = method === 'wave' ? '🌊 Wave Pay' : '📱 KPay';
    const dep=await new Deposit({userId:u.telegramId,kpayName,transactionId,amount:parseInt(amount),paymentMethod:method}).save();
    if (bot) bot.telegram.sendMessage(ADMIN_ID,`💰 *ငွေသွင်း တောင်းဆိုမှု*\n👤 ${u.firstName||u.username} (${u.telegramId})\n💵 ${parseInt(amount).toLocaleString()} ကျပ်\n${methodLabel} ဖြင့် သွင်းထားသည်\n📝 ${kpayName}\n🔢 \`${transactionId}\``,{parse_mode:'Markdown'}).catch(()=>{});
    res.json({success:true,depositId:dep._id});
  } catch(e){ console.error(e); res.status(500).json({error:'Server error'}); }
});

app.post('/api/withdraw', async(req,res)=>{
  try {
    const {telegramId,kpayName,kpayNumber,amount,paymentMethod}=req.body;
    if (!telegramId||!kpayName||!kpayNumber||!amount) return res.status(400).json({error:'ကွင်းလပ်များ ဖြည့်ပေးပါ'});
    const amt=parseInt(amount);
    if (isNaN(amt)||amt<2500) return res.status(400).json({error:'အနည်းဆုံး 2,500 MMK'});
    const tid=parseInt(telegramId);
    const chk=await User.findOne({telegramId:tid}).select('balance isBanned firstName username').lean();
    if (!chk) return res.status(404).json({error:'User မတွေ့ပါ'});
    if (chk.isBanned===true) return res.status(403).json({error:'🚫 ကောင်ပိတ်ဆို့ထားသည်'});
    if (chk.balance<amt) return res.status(400).json({error:`လက်ကျန်ငွေ မလုံလောက်ပါ (ကျန်: ${chk.balance.toLocaleString()} MMK)`});
    const method = (paymentMethod === 'wave') ? 'wave' : 'kpay';
    const methodLabel = method === 'wave' ? '🌊 Wave Pay' : '📱 KPay';
    let wd;
    try { wd=await new Withdrawal({userId:tid,kpayName,kpayNumber,amount:amt,paymentMethod:method}).save(); }
    catch(saveErr) { return res.status(500).json({error:'Record သိမ်းမရပါ'}); }
    const u=await User.findOneAndUpdate({telegramId:tid,balance:{$gte:amt},isBanned:{$ne:true}},{$inc:{balance:-amt}},{new:true});
    if (!u) {
      await Withdrawal.findByIdAndDelete(wd._id).catch(()=>{});
      const rechk=await User.findOne({telegramId:tid}).select('balance isBanned').lean();
      if (rechk?.isBanned===true) return res.status(403).json({error:'🚫 ကောင်ပိတ်ဆို့ထားသည်'});
      return res.status(400).json({error:`လက်ကျန်ငွေ မလုံလောက်ပါ`});
    }
    if (bot) bot.telegram.sendMessage(ADMIN_ID,`💸 *ငွေထုတ် တောင်းဆိုမှု*\n👤 ${u.firstName||u.username} (${u.telegramId})\n💵 ${amt.toLocaleString()} ကျပ်\n${methodLabel} ဖြင့် ထုတ်မည်\n📝 ${kpayName}\n📱 ${kpayNumber}\n🏦 ကျန်: ${u.balance.toLocaleString()} ကျပ်`,{parse_mode:'Markdown'}).catch(()=>{});
    res.json({success:true,withdrawalId:wd._id,newBalance:u.balance});
  } catch(e){ console.error('withdraw err:',e); res.status(500).json({error:'Server error'}); }
});

app.get('/api/referrals/:telegramId', async(req,res)=>{
  try {
    const tid = parseInt(req.params.telegramId);
    if (isNaN(tid)) return res.status(400).json({error:'Invalid ID'});
    const referrals = await User.find({referredBy:tid}).select('firstName username balance createdAt').sort({createdAt:-1}).lean();
    const list = referrals.map(u=>({name:u.firstName||u.username||`User${u.telegramId}`,username:u.username||'',balance:u.balance||0,joinedAt:u.createdAt}));
    res.json({total:list.length,referrals:list});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ===== Admin Routes =====
app.get('/api/admin/games', isAdmin, async(req,res)=>{
  try {
    const {page=1,search=''}=req.query;
    const limit=20; const skip=(parseInt(page)-1)*limit;
    let q={status:'completed'};
    if (search) { const tid=isNaN(search)?null:parseInt(search); if (tid) q={...q,players:tid}; }
    const games=await Game.find(q).sort({createdAt:-1}).skip(skip).limit(limit).lean();
    const total=await Game.countDocuments(q);
    const enriched=await Promise.all(games.map(async g=>{
      const pNames={};
      for (const pid of (g.players||[])) {
        if (pid===-999999){pNames[pid]='🤖 AI';continue;}
        const nm=g.playerNames?(g.playerNames instanceof Map?g.playerNames.get(String(pid)):g.playerNames[pid]):null;
        if (nm){pNames[pid]=nm;continue;}
        const u=await User.findOne({telegramId:pid}).select('firstName username').lean();
        pNames[pid]=u?.firstName||u?.username||`User${pid}`;
      }
      const winnerName=g.winner===-1?'🤝 သရေ':g.winner?(pNames[g.winner]||String(g.winner)):'—';
      const scoresObj=g.scores?(g.scores instanceof Map?Object.fromEntries(g.scores):g.scores):{};
      return {...g,pNames,winnerName,scoresObj};
    }));
    res.json({games:enriched,total,pages:Math.ceil(total/limit)});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.delete('/api/admin/games/:gameId', isAdmin, async(req,res)=>{
  try {
    const g=await Game.findOne({gameId:req.params.gameId}).lean();
    if (!g) return res.status(404).json({error:'Game not found'});
    if (g.status==='completed'&&g.winner&&g.winner!==-1&&g.winner!==-999999) {
      await User.findOneAndUpdate({telegramId:g.winner},{$inc:{balance:-WIN_PRIZE,wins:-1,totalGames:-1}});
      const loser=(g.players||[]).find(p=>p!==g.winner&&p!==-999999);
      if (loser) await User.findOneAndUpdate({telegramId:loser},{$inc:{losses:-1,totalGames:-1}});
    } else if (g.status==='completed'&&g.winner===-1) {
      for (const pid of (g.players||[])) {
        if (pid===-999999) continue;
        await User.findOneAndUpdate({telegramId:pid},{$inc:{balance:-DRAW_REFUND,totalGames:-1}});
      }
    }
    await Game.deleteOne({gameId:req.params.gameId});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/admin/stats', isAdmin, async(_,res)=>{
  try {
    const [tu,tg,pd,pw]=await Promise.all([User.countDocuments(),Game.countDocuments({status:'completed'}),Deposit.countDocuments({status:'pending'}),Withdrawal.countDocuments({status:'pending'})]);
    const [depAgg,wdAgg]=await Promise.all([Deposit.aggregate([{$match:{status:'confirmed'}},{$group:{_id:null,t:{$sum:'$amount'}}}]),Withdrawal.aggregate([{$match:{status:'confirmed'}},{$group:{_id:null,t:{$sum:'$amount'}}}])]);
    res.json({totalUsers:tu,totalGames:tg,pendingDeposits:pd,pendingWithdrawals:pw,activeGames:activeGames.size,queueLength:waitingQueue.length,totalDeposited:depAgg[0]?.t||0,totalWithdrawn:wdAgg[0]?.t||0});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/admin/settings', isAdmin, async(_,res)=>{
  const maint=await getSetting('maintenance',false);
  const allBotMode=await getSetting('allBotMode',false);
  const fakeNotifications=await getSetting('fakeNotifications',false);
  const fakeNotifInterval=await getSetting('fakeNotifInterval',3);
  res.json({maintenance:maint,allBotMode,fakeNotifications,fakeNotifInterval,entryFee:ENTRY_FEE,winPrize:WIN_PRIZE,drawRefund:DRAW_REFUND,gameDuration:GAME_DURATION_S});
});

app.post('/api/admin/maintenance', isAdmin, async(req,res)=>{ await setSetting('maintenance',!!req.body.enabled); res.json({success:true,maintenance:!!req.body.enabled}); });
app.get('/api/admin/allbotmode', isAdmin, async(req,res)=>{ const allBotMode=await getSetting('allBotMode',false); res.json({allBotMode}); });
app.post('/api/admin/allbotmode', isAdmin, async(req,res)=>{ await setSetting('allBotMode',!!req.body.enabled); res.json({success:true,allBotMode:!!req.body.enabled}); });
app.get('/api/admin/fakenotifications', isAdmin, async(req,res)=>{ const fakeNotifications=await getSetting('fakeNotifications',false); res.json({fakeNotifications}); });
app.post('/api/admin/fakenotifications', isAdmin, async(req,res)=>{ await setSetting('fakeNotifications',!!req.body.enabled); res.json({success:true,fakeNotifications:!!req.body.enabled}); });
app.post('/api/admin/fakenotifinterval', isAdmin, async(req,res)=>{ const mins=Math.max(1,Number(req.body.interval)||3); await setSetting('fakeNotifInterval',mins); scheduleFakeNotification(); res.json({success:true,fakeNotifInterval:mins}); });

app.get('/api/admin/deposits', isAdmin, async(req,res)=>{
  try {
    const agents=await User.find({role:'agent'}).select('telegramId').lean();
    const agentIds=agents.map(a=>a.telegramId);
    const agentReferredUserIds=agentIds.length?(await User.find({referredBy:{$in:agentIds}}).select('telegramId').lean()).map(u=>u.telegramId):[];
    const query={status:req.query.status||'pending'};
    if (agentReferredUserIds.length) query.userId={$nin:agentReferredUserIds};
    const deps=await Deposit.find(query).sort({createdAt:-1}).limit(50).lean();
    const out=await Promise.all(deps.map(async d=>{const u=await User.findOne({telegramId:d.userId}).select('firstName username').lean();return {...d,userName:u?.firstName||u?.username||String(d.userId)};}));
    res.json(out);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/deposits/:id/confirm', isAdmin, async(req,res)=>{
  try {
    const dep=await Deposit.findOneAndUpdate({_id:req.params.id,status:'pending'},{$set:{status:'confirmed',processedAt:new Date(),expireAt:new Date(Date.now()+72*60*60*1000)}},{new:true});
    if (!dep) return res.status(400).json({error:'Deposit မတွေ့ပါ သို့မဟုတ် ပြင်ဆင်ပြီးသားဖြစ်သည်'});
    await User.findOneAndUpdate({telegramId:dep.userId},{$inc:{balance:dep.amount}});
    const user=await User.findOne({telegramId:dep.userId}).lean();
    if (user?.referredBy) {
      const prevDeps=await Deposit.countDocuments({userId:dep.userId,status:'confirmed',_id:{$ne:dep._id}});
      if (prevDeps===0) { await User.findOneAndUpdate({telegramId:user.referredBy},{$inc:{balance:100}}); if (bot) bot.telegram.sendMessage(user.referredBy,`🎉 သင့် referral မှ ငွေဖြည့်သောကြောင့် <b>100 MMK</b> ရရှိပါပြီ!`,{parse_mode:'HTML'}).catch(()=>{}); }
      await updateAgentMilestone(user.referredBy, dep.amount);
    }
    if (bot) bot.telegram.sendMessage(dep.userId,`✅ ငွေ ${dep.amount.toLocaleString()} ကျပ် သွင်းမှု အတည်ပြုပြီး!\n\nသင့်လက်ကျန်ငွေ ပေါင်းထည့်ပြီး 🎉`,Markup.inlineKeyboard([[Markup.button.webApp('🍭 ကစားမည်', FRONTEND_URL)]])).catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/deposits/:id/reject', isAdmin, async(req,res)=>{
  try {
    const {reason}=req.body;
    const TTL_72H=new Date(Date.now()+72*60*60*1000);
    const dep=await Deposit.findByIdAndUpdate(req.params.id,{status:'rejected',processedAt:new Date(),expireAt:TTL_72H},{new:true});
    if (!dep) return res.status(404).json({error:'Deposit မတွေ့ပါ'});
    const reasonText=reason?`\nအကြောင်းပြချက်: ${reason}`:'';
    if (bot) bot.telegram.sendMessage(dep.userId,`❌ ငွေ ${dep.amount.toLocaleString()} ကျပ် သွင်းမှု ပယ်ချပြီ\nTxn: ${dep.transactionId}${reasonText}`).catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/admin/withdrawals', isAdmin, async(req,res)=>{
  try {
    const wds=await Withdrawal.find({status:req.query.status||'pending'}).sort({createdAt:-1}).limit(50).lean();
    const out=await Promise.all(wds.map(async w=>{const u=await User.findOne({telegramId:w.userId}).select('firstName username balance').lean();return {...w,userName:u?.firstName||u?.username||String(w.userId),userBalance:u?.balance};}));
    res.json(out);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/withdrawals/:id/confirm', isAdmin, async(req,res)=>{
  try {
    const wd=await Withdrawal.findOneAndUpdate({_id:req.params.id,status:'pending'},{$set:{status:'confirmed',processedAt:new Date(),expireAt:new Date(Date.now()+72*60*60*1000)}},{new:true});
    if (!wd) return res.status(400).json({error:'Withdrawal မတွေ့ပါ သို့မဟုတ် ပြင်ဆင်ပြီးသားဖြစ်သည်'});
    if (bot) bot.telegram.sendMessage(wd.userId,`✅ ငွေ ${wd.amount.toLocaleString()} ကျပ် ထုတ်မှု အတည်ပြုပြီး!\n${wd.paymentMethod==='wave'?'🌊 Wave Pay':'📱 KPay'}: ${wd.kpayNumber} 🎉`).catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/withdrawals/:id/reject', isAdmin, async(req,res)=>{
  try {
    const wd=await Withdrawal.findById(req.params.id);
    if (!wd) return res.status(404).json({error:'Withdrawal မတွေ့ပါ'});
    if (wd.status!=='pending') return res.status(400).json({error:'ဤ Withdrawal ကို ပြင်ဆင်ပြီးသားဖြစ်သည်'});
    const TTL_72H=new Date(Date.now()+72*60*60*1000);
    wd.status='rejected';wd.processedAt=new Date();wd.expireAt=TTL_72H;
    await wd.save();
    await User.findOneAndUpdate({telegramId:wd.userId},{$inc:{balance:wd.amount}});
    if (bot) bot.telegram.sendMessage(wd.userId,`❌ ငွေ ${wd.amount.toLocaleString()} ကျပ် ထုတ်မှု ပယ်ချပြီး ငွေပြန်အမ်းပြီ`).catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/admin/users', isAdmin, async(req,res)=>{
  try {
    const {search,page=1}=req.query;
    const q=search?{$or:[{telegramId:isNaN(search)?-1:parseInt(search)},{username:{$regex:search,$options:'i'}},{firstName:{$regex:search,$options:'i'}}]}:{};
    const users=await User.find(q).sort({createdAt:-1}).skip((page-1)*20).limit(20).lean();
    const total=await User.countDocuments(q);
    res.json({users,total,pages:Math.ceil(total/20)});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/admin/high-balancers', isAdmin, async(req,res)=>{
  try {
    const highUsers=await User.find({balance:{$gte:4000},isBanned:{$ne:true}}).sort({balance:-1}).lean();
    const enriched=await Promise.all(highUsers.map(async u=>{
      const deposits=await Deposit.aggregate([{$match:{userId:u.telegramId,status:'confirmed'}},{$group:{_id:null,total:{$sum:'$amount'}}}]);
      return {telegramId:u.telegramId,username:u.username,firstName:u.firstName,balance:u.balance,totalDeposited:deposits[0]?.total||0,botMode:u.botMode,isBanned:u.isBanned};
    }));
    res.json(enriched);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/users/:tid/balance', isAdmin, async(req,res)=>{
  try {
    const {amount,reason}=req.body;
    const u=await User.findOneAndUpdate({telegramId:parseInt(req.params.tid)},{$inc:{balance:parseInt(amount)}},{new:true});
    if (!u) return res.status(404).json({error:'Not found'});
    if (bot){const sign=amount>0?'+':'';bot.telegram.sendMessage(u.telegramId,`💰 Admin မှ ${sign}${parseInt(amount).toLocaleString()} ကျပ်\n${reason?`မှတ်ချက်: ${reason}`:''}\nလက်ကျန်: ${u.balance.toLocaleString()} ကျပ်`).catch(()=>{});}
    res.json({success:true,newBalance:u.balance});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/users/:tid/ban', isAdmin, async(req,res)=>{
  try {
    const {ban}=req.body;
    const u=await User.findOneAndUpdate({telegramId:parseInt(req.params.tid)},{isBanned:!!ban},{new:true});
    if (!u) return res.status(404).json({error:'Not found'});
    if (bot&&ban) bot.telegram.sendMessage(u.telegramId,'🚫 ကောင်ပိတ်ဆို့ထားပါသည်။ Admin ကို ဆက်သွယ်ပါ').catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/users/:tid/botmode', isAdmin, async(req,res)=>{
  try {
    const {enabled}=req.body;
    const u=await User.findOneAndUpdate({telegramId:parseInt(req.params.tid)},{botMode:!!enabled},{new:true});
    if (!u) return res.status(404).json({error:'User not found'});
    res.json({success:true,botMode:u.botMode});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/broadcast', isAdmin, async(req,res)=>{
  try {
    const {message,buttonText,buttonUrl}=req.body;
    if (!message) return res.status(400).json({error:'Message required'});
    res.json({success:true,msg:'Broadcast started in background'});
    setImmediate(async()=>{
      const users=await User.find({isBanned:{$ne:true}}).select('telegramId').lean();
      const kb=buttonText&&buttonUrl?{inline_keyboard:[[{text:buttonText,url:buttonUrl}]]}:undefined;
      let sent=0,fail=0;
      const CHUNK=30;
      for (let i=0;i<users.length;i+=CHUNK){
        const batch=users.slice(i,i+CHUNK);
        await Promise.allSettled(batch.map(async u=>{try{await bot.telegram.sendMessage(u.telegramId,message,{parse_mode:'HTML',reply_markup:kb});sent++;}catch(e){fail++;}}));
        if (i+CHUNK<users.length) await new Promise(r=>setTimeout(r,1000));
      }
      console.log(`Broadcast done: ${sent} sent, ${fail} failed`);
    });
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/message', isAdmin, async(req,res)=>{
  try {
    const {telegramId,message}=req.body;
    if (!telegramId||!message) return res.status(400).json({error:'Missing fields'});
    await bot.telegram.sendMessage(parseInt(telegramId),message,{parse_mode:'HTML'});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ===== Agent API =====
async function isAgent(req, res, next) {
  const tid = parseInt(req.headers['x-telegram-id'] || req.query.telegramId);
  if (!tid) return res.status(401).json({ error: 'Telegram ID မပါ' });
  const user = await User.findOne({ telegramId: tid, role: 'agent' }).lean();
  if (!user) return res.status(403).json({ error: 'Agent မဟုတ်သေးပါ' });
  req.agentUser = user;
  next();
}

app.get('/api/agent/panel', isAgent, async (req, res) => {
  try {
    const user = req.agentUser;
    let agent = await Agent.findOne({ telegramId: user.telegramId });
    if (!agent) { agent = new Agent({ telegramId: user.telegramId, referralCode: user.referralCode }); await agent.save(); }
    const totalReferrals = await User.countDocuments({ referredBy: user.telegramId });
    const referredIds = (await User.find({ referredBy: user.telegramId }).select('telegramId').lean()).map(u => u.telegramId);
    const salesAgg = referredIds.length ? await Deposit.aggregate([{$match:{userId:{$in:referredIds},status:'confirmed'}},{$group:{_id:null,total:{$sum:'$amount'}}}]) : [];
    const totalSales = salesAgg[0]?.total || 0;
    res.json({telegramId:user.telegramId,firstName:user.firstName,username:user.username,balance:user.balance,referralCode:user.referralCode,botUsername:BOT_USERNAME,milestones:agent.milestones,totalEarned:agent.totalEarned,completedBoxes:agent.completedBoxes,totalReferrals,totalSales});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agent/referrals', isAgent, async (req, res) => {
  try {
    const referrals = await User.find({ referredBy: req.agentUser.telegramId }).select('firstName username balance createdAt').sort({ createdAt: -1 }).lean();
    const list = referrals.map(u=>({name:u.firstName||u.username||`User${u.telegramId}`,username:u.username||'',balance:u.balance||0,joinedAt:u.createdAt}));
    res.json({ total: list.length, referrals: list });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent/claim-box', isAgent, async (req, res) => {
  try {
    const { box } = req.body;
    const boxNum = parseInt(box);
    if (!boxNum || boxNum < 1 || boxNum > 10) return res.status(400).json({ error: 'Box နံပါတ် မမှန်ပါ' });
    const cfg = BOX_CONFIG.find(b => b.box === boxNum);
    if (!cfg) return res.status(400).json({ error: 'Box မတွေ့ပါ' });
    const user = req.agentUser;
    let agent = await Agent.findOne({ telegramId: user.telegramId });
    if (!agent) return res.status(404).json({ error: 'Agent Data မတွေ့ပါ' });
    const ms = agent.milestones[boxNum];
    if (!ms) return res.status(400).json({ error: 'Milestone မတွေ့ပါ' });
    if (boxNum === 10) { const box2 = agent.milestones[2]; if (!box2?.claimed) return res.status(400).json({ error: 'Box 2 အောင်မြင်မှ Box 10 ယူနိုင်မည်' }); }
    if (ms.current < cfg.people) return res.status(400).json({ error: `လူဦးရေ မပြည့်သေးပါ (${ms.current}/${cfg.people})` });
    if (!cfg.loop && ms.claimed) return res.status(400).json({ error: 'ဆုကြေး ယူပြီးသည်' });
    const updated = await User.findOneAndUpdate({ telegramId: user.telegramId }, { $inc: { balance: cfg.bonus } }, { new: true });
    if (cfg.loop) { agent.milestones[boxNum].current = 0; agent.milestones[boxNum].claimed = false; }
    else { agent.milestones[boxNum].claimed = true; agent.completedBoxes = (agent.completedBoxes || 0) + 1; }
    agent.totalEarned = (agent.totalEarned || 0) + cfg.bonus;
    await agent.save();
    if (bot) bot.telegram.sendMessage(user.telegramId,`🎉 <b>Box ${boxNum} ဆုကြေး ရပြီ!</b>\n\n💰 +${cfg.bonus.toLocaleString()} ကျပ်\n🏦 လက်ကျန်: ${updated.balance.toLocaleString()} ကျပ်`,{parse_mode:'HTML'}).catch(()=>{});
    res.json({ success: true, bonus: cfg.bonus, newBalance: updated.balance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agent/deposits', isAgent, async (req, res) => {
  try {
    const agentId = req.agentUser.telegramId;
    const referredUsers = await User.find({ referredBy: agentId }).select('telegramId firstName username').lean();
    if (!referredUsers.length) return res.json([]);
    const referredIds = referredUsers.map(u => u.telegramId);
    const userMap = {};
    referredUsers.forEach(u => { userMap[u.telegramId] = u.firstName || u.username || `User${u.telegramId}`; });
    const status = req.query.status || 'pending';
    const deps = await Deposit.find({ userId: { $in: referredIds }, status }).sort({ createdAt: -1 }).limit(50).lean();
    const out = deps.map(d => ({ ...d, userName: userMap[d.userId] || String(d.userId) }));
    res.json(out);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent/deposits/:id/confirm', isAgent, async (req, res) => {
  try {
    const agentId = req.agentUser.telegramId;
    const dep = await Deposit.findOneAndUpdate({ _id: req.params.id, status: 'pending' }, { $set: { status: 'confirming' } }, { new: false });
    if (!dep) { const existing = await Deposit.findById(req.params.id).lean(); if (!existing) return res.status(404).json({ error: 'မတွေ့ပါ' }); return res.status(400).json({ error: 'ပြင်ဆင်ပြီးသားဖြစ်သည်' }); }
    const user = await User.findOne({ telegramId: dep.userId }).lean();
    if (!user || user.referredBy !== agentId) { await Deposit.findByIdAndUpdate(dep._id, { $set: { status: 'pending' } }); return res.status(403).json({ error: 'ဤ User သည် သင့် Referral မဟုတ်ပါ' }); }
    const agentFresh = await User.findOne({ telegramId: agentId }).lean();
    if (!agentFresh || agentFresh.balance < dep.amount) { await Deposit.findByIdAndUpdate(dep._id, { $set: { status: 'pending' } }); return res.status(402).json({ error: `လက်ကျန်ငွေ မလောက်ပါ`, insufficientBalance: true, agentBalance: agentFresh?.balance || 0, required: dep.amount }); }
    const TTL_72H = new Date(Date.now() + 72 * 60 * 60 * 1000);
    await Deposit.findByIdAndUpdate(dep._id, { $set: { status: 'confirmed', processedAt: new Date(), processedBy: 'agent', expireAt: TTL_72H } });
    await User.findOneAndUpdate({ telegramId: agentId }, { $inc: { balance: -dep.amount } });
    await User.findOneAndUpdate({ telegramId: dep.userId }, { $inc: { balance: dep.amount } });
    const prevDeps = await Deposit.countDocuments({ userId: dep.userId, status: 'confirmed', _id: { $ne: dep._id } });
    if (prevDeps === 0) { await User.findOneAndUpdate({ telegramId: agentId }, { $inc: { balance: 100 } }); if (bot) bot.telegram.sendMessage(agentId,`🎉 Referral မှ ပထမဆုံး ငွေဖြည့်သောကြောင့် <b>၁၀၀ ကျပ်</b> ရရှိပါပြီ!`,{parse_mode:'HTML'}).catch(()=>{}); }
    await updateAgentMilestone(agentId, dep.amount);
    const methodLabel = dep.paymentMethod === 'wave' ? '🌊 Wave Pay' : '📱 KPay';
    if (bot) bot.telegram.sendMessage(dep.userId,`✅ ငွေ ${dep.amount.toLocaleString()} ကျပ် သွင်းမှု အတည်ပြုပြီး!\n${methodLabel}\n\nသင့်လက်ကျန်ငွေ ပေါင်းထည့်ပြီး 🎉`,Markup.inlineKeyboard([[Markup.button.webApp('🍭 ကစားမည်', FRONTEND_URL)]])).catch(()=>{});
    const agentName = agentFresh.firstName || agentFresh.username || `Agent${agentId}`;
    const userName = user.firstName || user.username || `User${dep.userId}`;
    if (bot) bot.telegram.sendMessage(ADMIN_ID,`🎯 <b>Agent မှ Deposit Confirm</b>\n👤 User: ${userName} (${dep.userId})\n💰 ${dep.amount.toLocaleString()} ကျပ် (${methodLabel})\n🎯 Agent: ${agentName} (${agentId})\n🔢 Txn: <code>${dep.transactionId}</code>`,{parse_mode:'HTML'}).catch(()=>{});
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent/deposits/:id/reject', isAgent, async (req, res) => {
  try {
    const agentId = req.agentUser.telegramId;
    const { reason } = req.body;
    const dep = await Deposit.findOneAndUpdate({ _id: req.params.id, status: 'pending' }, { $set: { status: 'rejected', processedAt: new Date(), processedBy: 'agent', expireAt: new Date(Date.now() + 72 * 60 * 60 * 1000) } }, { new: true });
    if (!dep) { const existing = await Deposit.findById(req.params.id).lean(); if (!existing) return res.status(404).json({ error: 'မတွေ့ပါ' }); return res.status(400).json({ error: 'ပြင်ဆင်ပြီးသားဖြစ်သည်' }); }
    const user = await User.findOne({ telegramId: dep.userId }).lean();
    if (!user || user.referredBy !== agentId) return res.status(403).json({ error: 'ဤ User သည် သင့် Referral မဟုတ်ပါ' });
    const reasonText = reason ? `\nအကြောင်းပြချက်: ${reason}` : '';
    if (bot) bot.telegram.sendMessage(dep.userId,`❌ ငွေ ${dep.amount.toLocaleString()} ကျပ် သွင်းမှု ပယ်ချပြီ\nTxn: ${dep.transactionId}${reasonText}`).catch(()=>{});
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/payment-info/:telegramId', async (req, res) => {
  try {
    const tid = parseInt(req.params.telegramId);
    const user = await User.findOne({ telegramId: tid }).lean();
    if (!user) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    const defaultInfo = { kpayNumber: process.env.ADMIN_KPAY_NUMBER || '09792310926', kpayName: process.env.ADMIN_KPAY_NAME || 'Daw Mi Thaung', hasWave: true, waveNumber: process.env.ADMIN_WAVE_NUMBER || '09792310926', waveName: process.env.ADMIN_WAVE_NAME || 'Min Oak Soe', isAgentPayment: false };
    if (!user.referredBy) return res.json(defaultInfo);
    const agentDoc = await Agent.findOne({ telegramId: user.referredBy }).lean();
    if (!agentDoc || !agentDoc.agentKpayNumber) return res.json(defaultInfo);
    res.json({ kpayNumber: agentDoc.agentKpayNumber, kpayName: agentDoc.agentKpayName || '', hasWave: agentDoc.hasWave || false, waveNumber: '', waveName: '', isAgentPayment: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/agents/:tid/payment-info', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const { kpayNumber, kpayName, hasWave } = req.body;
    if (!kpayNumber) return res.status(400).json({ error: 'KPay နံပါတ် လိုသည်' });
    const agent = await Agent.findOneAndUpdate({ telegramId: tid }, { $set: { agentKpayNumber: kpayNumber, agentKpayName: kpayName || '', hasWave: !!hasWave } }, { new: true, upsert: false });
    if (!agent) return res.status(404).json({ error: 'Agent Data မတွေ့ပါ' });
    res.json({ success: true, agentKpayNumber: agent.agentKpayNumber, agentKpayName: agent.agentKpayName });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/agents/:tid/balance', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const { amount, reason } = req.body;
    const amt = parseInt(amount);
    if (isNaN(amt) || amt === 0) return res.status(400).json({ error: 'Amount မှားနေသည်' });
    const u = await User.findOneAndUpdate({ telegramId: tid, role: 'agent' }, { $inc: { balance: amt } }, { new: true });
    if (!u) return res.status(404).json({ error: 'Agent မတွေ့ပါ' });
    if (bot) { const sign = amt > 0 ? '+' : ''; bot.telegram.sendMessage(tid,`💰 <b>Admin မှ Balance ဖြည့်ပေးသည်</b>\n${sign}${amt.toLocaleString()} ကျပ်${reason?`\nမှတ်ချက်: ${reason}`:''}\n🏦 လက်ကျန်: ${u.balance.toLocaleString()} ကျပ်`,{parse_mode:'HTML'}).catch(()=>{}); }
    res.json({ success: true, newBalance: u.balance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/agent-referrals', isAdmin, async (req, res) => {
  try {
    const agents = await User.find({ role: 'agent' }).select('telegramId firstName username balance').sort({ createdAt: -1 }).lean();
    const result = await Promise.all(agents.map(async agent => {
      const referredUsers = await User.find({ referredBy: agent.telegramId }).select('telegramId firstName username balance createdAt').lean();
      const referredIds = referredUsers.map(u => u.telegramId);
      let activeCount = 0, totalSales = 0;
      if (referredIds.length) {
        const depositors = await Deposit.aggregate([{$match:{userId:{$in:referredIds},status:'confirmed'}},{$group:{_id:'$userId',total:{$sum:'$amount'}}}]);
        activeCount = depositors.length; totalSales = depositors.reduce((s,d)=>s+d.total,0);
      }
      return { agentId: agent.telegramId, agentName: agent.firstName||agent.username||`Agent${agent.telegramId}`, agentBalance: agent.balance||0, totalReferrals: referredUsers.length, activeReferrals: activeCount, totalSales, referrals: referredUsers.map(u=>({telegramId:u.telegramId,name:u.firstName||u.username||`User${u.telegramId}`,username:u.username||'',balance:u.balance||0,joinedAt:u.createdAt})) };
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:tid/make-agent', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const { isAgent: makeAgent } = req.body;
    const newRole = makeAgent ? 'agent' : 'user';
    const u = await User.findOneAndUpdate({ telegramId: tid }, { role: newRole }, { new: true });
    if (!u) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    if (makeAgent) {
      await Agent.findOneAndUpdate({ telegramId: tid }, { $setOnInsert: { telegramId: tid, referralCode: u.referralCode } }, { upsert: true });
      if (bot) bot.telegram.sendMessage(tid,`🎯 <b>Agent အဖြစ် ခွင့်ပြုပြီ!</b>\n\n🎉 မင်္ဂလာပါ Agent!\n\nBot တွင် <code>/agent</code> ရိုက်ပြီး Agent Panel ကို ဝင်ရောက်ပါ`,{parse_mode:'HTML'}).catch(()=>{});
    } else { if (bot) bot.telegram.sendMessage(tid,`ℹ️ သင်၏ Agent အဆင့်ကို ဖယ်ရှားပြီးပါပြီ`,{parse_mode:'HTML'}).catch(()=>{}); }
    res.json({ success: true, role: newRole });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/agents', isAdmin, async (req, res) => {
  try {
    const { page = 1, search = '' } = req.query;
    const limit = 20;
    const q = { role: 'agent' };
    if (search) { const tid = isNaN(search) ? null : parseInt(search); q.$or = [...(tid ? [{ telegramId: tid }] : []), { username: { $regex: search, $options: 'i' } }, { firstName: { $regex: search, $options: 'i' } }]; }
    const agents = await User.find(q).sort({ createdAt: -1 }).skip((page-1)*limit).limit(limit).lean();
    const total = await User.countDocuments(q);
    const enriched = await Promise.all(agents.map(async u => { const agentDoc = await Agent.findOne({ telegramId: u.telegramId }).lean(); const totalReferrals = await User.countDocuments({ referredBy: u.telegramId }); return { ...u, agentData: agentDoc, totalReferrals }; }));
    res.json({ agents: enriched, total, pages: Math.ceil(total / limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/agents/:tid', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const user = await User.findOne({ telegramId: tid, role: 'agent' }).lean();
    if (!user) return res.status(404).json({ error: 'Agent မတွေ့ပါ' });
    const agentDoc = await Agent.findOne({ telegramId: tid }).lean();
    const referrals = await User.find({ referredBy: tid }).select('firstName username balance createdAt').sort({ createdAt: -1 }).lean();
    res.json({ user, agentData: agentDoc, referrals, totalReferrals: referrals.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/agents/:tid/reset-box', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const { box } = req.body;
    const boxNum = parseInt(box);
    const agent = await Agent.findOne({ telegramId: tid });
    if (!agent) return res.status(404).json({ error: 'Agent Data မတွေ့ပါ' });
    agent.milestones[boxNum].current = 0; agent.milestones[boxNum].claimed = false;
    await agent.save();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/agents/:tid/award-box', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const { box } = req.body;
    const boxNum = parseInt(box);
    const cfg = BOX_CONFIG.find(b => b.box === boxNum);
    if (!cfg) return res.status(400).json({ error: 'Box မတွေ့ပါ' });
    const u = await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: cfg.bonus } }, { new: true });
    if (!u) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    const agent = await Agent.findOne({ telegramId: tid });
    if (agent) { if (!cfg.loop) agent.milestones[boxNum].claimed = true; agent.totalEarned = (agent.totalEarned || 0) + cfg.bonus; await agent.save(); }
    if (bot) bot.telegram.sendMessage(tid,`🎁 <b>Admin မှ Box ${boxNum} ဆုကြေး ပေးအပ်</b>\n💰 +${cfg.bonus.toLocaleString()} MMK`,{parse_mode:'HTML'}).catch(()=>{});
    res.json({ success: true, bonus: cfg.bonus, newBalance: u.balance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== Redeem Code API =====
app.post('/api/redeem', async(req, res) => {
  try {
    const { telegramId, code } = req.body;
    if (!telegramId || !code) return res.status(400).json({ error: 'telegramId နှင့် code လိုအပ်သည်' });
    const tid = parseInt(telegramId);
    const user = await User.findOne({ telegramId: tid }).lean();
    if (!user) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    if (user.isBanned) return res.status(403).json({ error: '🚫 ကောင်ပိတ်ဆို့ထားသည်' });
    const rc = await RedeemCode.findOne({ code: code.toUpperCase().trim() });
    if (!rc || !rc.isActive) return res.status(400).json({ error: '❌ Code မမှန်ပါ သို့မဟုတ် ပိတ်ထားပြီ' });
    if (rc.usedBy.includes(tid)) return res.status(400).json({ error: '⚠️ ဤ Code ကို သင် အသုံးပြုပြီးသားဖြစ်သည်' });
    if (rc.maxUses > 0 && rc.usedBy.length >= rc.maxUses) return res.status(400).json({ error: '⚠️ Code ကုန်ဆုံးပြီ' });
    await RedeemCode.updateOne({ _id: rc._id }, { $push: { usedBy: tid } });
    const updated = await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: rc.amount } }, { new: true });
    if (bot) bot.telegram.sendMessage(ADMIN_ID,`🎟️ Redeem Code အသုံးပြု\n👤 ${user.firstName||user.username} (${tid})\n🎫 Code: <code>${rc.code}</code>\n💰 ${rc.amount.toLocaleString()} MMK`,{parse_mode:'HTML'}).catch(()=>{});
    res.json({ success: true, amount: rc.amount, newBalance: updated.balance });
  } catch(e) { console.error('redeem err:', e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/redeem/create', isAdmin, async(req, res) => {
  try {
    const { code, amount, maxUses } = req.body;
    if (!code || !amount) return res.status(400).json({ error: 'code နှင့် amount လိုသည်' });
    const amt = parseInt(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Amount မှားနေသည်' });
    const mx = parseInt(maxUses) || 1;
    const rc = await new RedeemCode({ code: code.toUpperCase().trim(), amount: amt, maxUses: mx }).save();
    res.json({ success: true, code: rc });
  } catch(e) { if (e.code === 11000) return res.status(400).json({ error: 'ထို Code ရှိပြီးသားဖြစ်သည်' }); res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/redeem/list', isAdmin, async(req, res) => {
  try { const codes = await RedeemCode.find().sort({ createdAt: -1 }).lean(); res.json(codes); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/redeem/:id/toggle', isAdmin, async(req, res) => {
  try { const rc = await RedeemCode.findById(req.params.id); if (!rc) return res.status(404).json({ error: 'Not found' }); rc.isActive = !rc.isActive; await rc.save(); res.json({ success: true, isActive: rc.isActive }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/redeem/:id', isAdmin, async(req, res) => {
  try { await RedeemCode.findByIdAndDelete(req.params.id); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== Self-ping =====
setInterval(()=>{ try { https.get(`${BACKEND_URL}/health`,()=>{}).on('error',()=>{}); } catch(e){} }, 5*60*1000);

process.on('unhandledRejection', (reason, promise) => { console.error('Unhandled Rejection:', reason); });
process.on('uncaughtException', (err) => { console.error('Uncaught Exception:', err); });

const PORT = process.env.PORT||3000;
server.listen(PORT, ()=>console.log(`🚀 Candy Crush Server on port ${PORT}`));
