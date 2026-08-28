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
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['admin', 'player'], default: 'player' },
  balance: { type: Number, default: 0 },
  totalWon: { type: Number, default: 0 },
  totalLost: { type: Number, default: 0 },
  totalBetPlaced: { type: Number, default: 0 },
  seenQuestions: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const transactionSchema = new mongoose.Schema({
  username: { type: String, required: true },
  type: { type: String, enum: ['deposit', 'withdrawal'], required: true },
  amount: { type: Number, required: true },
  upiId: { type: String, default: '' },
  txnId: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  timestamp: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

const historySchema = new mongoose.Schema({
  game: String,
  multiplier: Number,
  timestamp: { type: Date, default: Date.now }
});
const GameHistory = mongoose.model('GameHistory', historySchema);

// ==========================================
// PROBABILITY ENGINES
// ==========================================
function getAviatorMultiplier() {
  const rand = Math.random() * 100;
  if (rand < 35) return +(1.00 + Math.random() * 0.04).toFixed(2);
  if (rand < 55) return +(1.05 + Math.random() * 0.40).toFixed(2);
  if (rand < 80) return +(1.46 + Math.random() * 0.99).toFixed(2);
  if (rand < 90) return +(2.46 + Math.random() * 1.99).toFixed(2);
  if (rand < 95) return +(4.46 + Math.random() * 17.57).toFixed(2);
  if (rand < 98) return +(22.04 + Math.random() * 19.11).toFixed(2);
  return +(41.16 + Math.random() * 73.97).toFixed(2);
}

function getGenericRewardMultiplier() {
  const rand = Math.random() * 100;
  if (rand < 30) return 1;
  if (rand < 55) return 2;
  if (rand < 65) return 3;
  if (rand < 80) return 4;
  if (rand < 85) return 5;
  if (rand < 89) return 6;
  if (rand < 92) return 7;
  if (rand < 97) return 8;
  if (rand < 99) return 9;
  return 10;
}

// ==========================================
// 24x7 AVIATOR ENGINE (WebSocket)
// ==========================================
let aviatorState = { status: 'WAITING', currentX: 1.00, crashX: 1.00, history: [] };

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  });
}

async function startAviatorLoop() {
  try {
    const docs = await GameHistory.find({ game: 'aviator' }).sort({ timestamp: -1 }).limit(20);
    aviatorState.history = docs.map(d => d.multiplier);
  } catch (err) {
    console.error("History fetch error:", err.message);
  }

  while (true) {
    try {
      aviatorState.status = 'WAITING';
      aviatorState.currentX = 1.00;
      aviatorState.crashX = getAviatorMultiplier();
      broadcast({ type: 'AVIATOR_STATE', ...aviatorState });

      await new Promise(r => setTimeout(r, 5000));

      aviatorState.status = 'FLYING';
      let startTime = Date.now();

      await new Promise(resolve => {
        const interval = setInterval(async () => {
          let elapsed = (Date.now() - startTime) / 1000;
          aviatorState.currentX = +(Math.pow(1.06, elapsed * 2.2)).toFixed(2);

          if (aviatorState.currentX >= aviatorState.crashX) {
            aviatorState.currentX = aviatorState.crashX;
            aviatorState.status = 'CRASHED';
            clearInterval(interval);

            try { 
              await GameHistory.create({ game: 'aviator', multiplier: aviatorState.crashX }); 
            } catch (e) {
              console.error("GameHistory save error:", e.message);
            }

            aviatorState.history.unshift(aviatorState.crashX);
            if (aviatorState.history.length > 20) aviatorState.history.pop();

            broadcast({ type: 'AVIATOR_STATE', ...aviatorState });
            setTimeout(resolve, 2000);
          } else {
            broadcast({ type: 'AVIATOR_STATE', ...aviatorState });
          }
        }, 100);
      });
    } catch (loopErr) {
      console.error("Loop iteration error:", loopErr.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ==========================================
// HTTP APIs & AUTH
// ==========================================
app.post('/api/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'All fields required' });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hashedPassword });
    res.json({ success: true, username: user.username, role: user.role, balance: user.balance });
  } catch (err) {
    res.status(400).json({ error: 'Username already exists' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.json({ username: user.username, role: user.role, balance: user.balance, seenQuestions: user.seenQuestions || [] });
});

app.post('/api/change-password', async (req, res) => {
  const { username, oldPassword, newPassword } = req.body;
  const user = await User.findOne({ username });
  if (!user || !(await bcrypt.compare(oldPassword, user.password))) {
    return res.status(400).json({ error: 'Old Password Incorrect!' });
  }
  user.password = await bcrypt.hash(newPassword, 10);
  await user.save();
  res.json({ success: true, message: 'Password Updated Successfully!' });
});

// AVIATOR BET DEDUCTION & WIN/LOSS APIS
app.post('/api/aviator/bet', async (req, res) => {
  const { username, betAmount } = req.body;
  const numBet = parseFloat(betAmount);
  if (isNaN(numBet) || numBet <= 0) return res.status(400).json({ error: 'Invalid Bet Amount' });

  const user = await User.findOneAndUpdate(
    { username, balance: { $gte: numBet } },
    { $inc: { balance: -numBet, totalBetPlaced: numBet } },
    { new: true }
  );

  if (!user) return res.status(400).json({ error: 'Insufficient Balance' });
  res.json({ success: true, newBalance: user.balance });
});

app.post('/api/aviator/cashout', async (req, res) => {
  const { username, betAmount, multiplier } = req.body;
  const numBet = parseFloat(betAmount);
  const numMult = parseFloat(multiplier);
  if (isNaN(numBet) || isNaN(numMult) || numBet <= 0 || numMult < 1) {
    return res.status(400).json({ error: 'Invalid Parameters' });
  }

  const winAmount = +(numBet * numMult).toFixed(2);
  const user = await User.findOneAndUpdate(
    { username },
    { $inc: { balance: winAmount, totalWon: winAmount } },
    { new: true }
  );

  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true, newBalance: user.balance, winAmount });
});

app.post('/api/aviator/loss', async (req, res) => {
  const { username, betAmount } = req.body;
  const numBet = parseFloat(betAmount);
  if (isNaN(numBet) || numBet <= 0) return res.status(400).json({ error: 'Invalid Details' });

  const user = await User.findOneAndUpdate(
    { username },
    { $inc: { totalLost: numBet } },
    { new: true }
  );

  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true, newBalance: user.balance });
});

// ==========================================
// DEPOSIT & WITHDRAWAL APIS
// ==========================================
app.post('/api/deposit', async (req, res) => {
  const { username, amount, txnId } = req.body;
  const numAmt = parseFloat(amount);
  if (isNaN(numAmt) || numAmt <= 0 || !txnId) return res.status(400).json({ error: 'Invalid details provided' });

  await Transaction.create({ username, type: 'deposit', amount: numAmt, txnId });
  res.json({ success: true, message: 'Deposit request submitted successfully! Awaiting Admin approval.' });
});

app.post('/api/withdraw', async (req, res) => {
  const { username, amount, upiId } = req.body;
  const numAmt = parseFloat(amount);
  if (isNaN(numAmt) || numAmt <= 0 || !upiId) return res.status(400).json({ error: 'Invalid details provided' });

  const user = await User.findOneAndUpdate(
    { username, balance: { $gte: numAmt } },
    { $inc: { balance: -numAmt } },
    { new: true }
  );

  if (!user) return res.status(400).json({ error: 'Insufficient Balance' });

  await Transaction.create({ username, type: 'withdrawal', amount: numAmt, upiId });
  res.json({ success: true, newBalance: user.balance, message: 'Withdrawal request submitted!' });
});

// ==========================================
// ADMIN CONTROL ENDPOINTS
// ==========================================
app.post('/api/admin/create-user', async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hashedPassword });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: 'Username already exists' });
  }
});

app.get('/api/admin/users', async (req, res) => {
  const users = await User.find({ role: 'player' }).sort({ createdAt: -1 });
  res.json(users);
});

app.get('/api/admin/transactions', async (req, res) => {
  const txns = await Transaction.find().sort({ timestamp: -1 });
  res.json(txns);
});

app.post('/api/admin/process-transaction', async (req, res) => {
  const { txnId, action } = req.body;
  const txn = await Transaction.findById(txnId);
  if (!txn || txn.status !== 'pending') return res.status(400).json({ error: 'Transaction unavailable' });

  if (action === 'approve') {
    txn.status = 'approved';
    if (txn.type === 'deposit') {
      await User.findOneAndUpdate({ username: txn.username }, { $inc: { balance: txn.amount } });
    }
  } else if (action === 'reject') {
    txn.status = 'rejected';
    if (txn.type === 'withdrawal') {
      await User.findOneAndUpdate({ username: txn.username }, { $inc: { balance: txn.amount } });
    }
  }
  await txn.save();
  res.json({ success: true });
});

app.post('/api/admin/update-balance', async (req, res) => {
  const { username, amount } = req.body;
  const user = await User.findOneAndUpdate(
    { username },
    { $inc: { balance: amount } },
    { new: true }
  );
  if (user) return res.json({ success: true, newBalance: user.balance });
  res.status(404).json({ error: 'User not found' });
});

app.post('/api/play-instant', async (req, res) => {
  const { username, game, betAmount, choice } = req.body;
  const numBet = parseFloat(betAmount);
  if (isNaN(numBet) || numBet <= 0) return res.status(400).json({ error: 'Invalid Bet Amount' });

  const initialUser = await User.findOneAndUpdate(
    { username, balance: { $gte: numBet } },
    { $inc: { balance: -numBet, totalBetPlaced: numBet } },
    { new: true }
  );

  if (!initialUser) return res.status(400).json({ error: 'Insufficient Balance' });

  let won = false;
  let rewardMultiplier = 0;
  let resultMeta = {};

  if (game === 'dice') {
    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    const sum = d1 + d2;
    const isSmall = sum >= 2 && sum <= 6;
    if ((isSmall && choice === 'small') || (!isSmall && choice === 'big')) {
      won = true;
      rewardMultiplier = getGenericRewardMultiplier();
    }
    resultMeta = { dice1: d1, dice2: d2, sum };
  } else if (game === 'prediction') {
    const startVal = choice.startVal;
    const endVal = choice.endVal;
    const dir = choice.direction;
    won = (dir === 'up' && endVal > startVal) || (dir === 'down' && endVal < startVal);
    rewardMultiplier = won ? 2 : 0;
    resultMeta = { startVal, endVal };
  } else if (game === 'careerboot') {
    won = choice.won;
    rewardMultiplier = choice.multiplier || 0;
    
    if (choice.askedQuestionIds && Array.isArray(choice.askedQuestionIds)) {
      await User.findOneAndUpdate(
        { username },
        { $addToSet: { seenQuestions: { $each: choice.askedQuestionIds } } }
      );
    }
  }

  const winPayout = won ? (numBet * rewardMultiplier) : 0;
  let finalUser;

  if (winPayout > 0) {
    finalUser = await User.findOneAndUpdate(
      { username },
      { $inc: { balance: winPayout, totalWon: winPayout } },
      { new: true }
    );
  } else {
    finalUser = await User.findOneAndUpdate(
      { username },
      { $inc: { totalLost: numBet } },
      { new: true }
    );
  }

  res.json({ won, rewardMultiplier, newBalance: finalUser.balance, seenQuestions: finalUser.seenQuestions, resultMeta });
});

// ==========================================
// EMBEDDED FRONTEND ENGINE
// ==========================================
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
<!DOCTYPE html>
<html lang="hi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Skilled Old Hand ðŸ¤‘</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    * { box-sizing: border-box; touch-action: manipulation; }
    body, html { height: 100%; width: 100%; margin: 0; padding: 0; overflow: hidden; background-color: #0d0202; font-family: ui-sans-serif, system-ui; }
    .gold-gradient { background: linear-gradient(135deg, #bf953f, #fcf6ba, #b38728, #fbf5b7); }
    .gold-text { background: linear-gradient(135deg, #bf953f, #fcf6ba, #b38728); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .tomato-card { background: linear-gradient(145deg, #800a0a, #360303); border: 2px solid #d4af37; box-shadow: 0 10px 25px rgba(0,0,0,0.8); }
    .no-scrollbar::-webkit-scrollbar { display: none; }
    .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }

    @keyframes popIn {
      0% { transform: scale(0.6); opacity: 0; }
      80% { transform: scale(1.05); opacity: 1; }
      100% { transform: scale(1); opacity: 1; }
    }
    .popup-anim { animation: popIn 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards; }

    @keyframes expandPage {
      0% { transform: scale(0.1) rotate(-15deg); opacity: 0; }
      100% { transform: scale(1) rotate(0deg); opacity: 1; }
    }
    .animate-expand { animation: expandPage 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
  </style>
</head>
<body class="h-full w-full flex items-center justify-center p-0 md:p-4">

  <div id="app" class="w-full h-full max-w-md max-h-[920px] bg-[#120303] md:rounded-3xl border-0 md:border-2 border-[#d4af37]/40 shadow-2xl flex flex-col relative overflow-hidden"></div>

  <script>
    class SoundEngine {
      constructor() { this.ctx = null; }
      init() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      stopAll() {
        if (this.ctx && this.ctx.state !== 'closed') {
          this.ctx.close();
          this.ctx = null;
        }
      }
      playFly() {
        if (state.currentView !== 'aviator') return;
        this.init();
        let osc = this.ctx.createOscillator(); let g = this.ctx.createGain();
        osc.frequency.setValueAtTime(140, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(300, this.ctx.currentTime + 0.1);
        g.gain.setValueAtTime(0.02, this.ctx.currentTime);
        osc.connect(g); g.connect(this.ctx.destination);
        osc.start(); osc.stop(this.ctx.currentTime + 0.1);
      }
      playCoinFlip() {
        if (state.currentView !== 'guesscorrect' && state.currentView !== 'careerboot') return;
        this.init();
        let osc = this.ctx.createOscillator(); let g = this.ctx.createGain();
        osc.frequency.setValueAtTime(800, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(200, this.ctx.currentTime + 0.08);
        g.gain.setValueAtTime(0.04, this.ctx.currentTime);
        osc.connect(g); g.connect(this.ctx.destination);
        osc.start(); osc.stop(this.ctx.currentTime + 0.08);
      }
      playMarketBeep() {
        if (state.currentView !== 'prediction') return;
        this.init();
        let osc = this.ctx.createOscillator(); let g = this.ctx.createGain();
        osc.frequency.setValueAtTime(600, this.ctx.currentTime);
        g.gain.setValueAtTime(0.01, this.ctx.currentTime);
        osc.connect(g); g.connect(this.ctx.destination);
        osc.start(); osc.stop(this.ctx.currentTime + 0.05);
      }
      playWin() {
        if (['lobby', 'login', 'admin', 'pwchange', 'deposit', 'withdraw'].includes(state.currentView)) return;
        this.init();
        let osc = this.ctx.createOscillator(); let g = this.ctx.createGain();
        osc.frequency.setValueAtTime(523.25, this.ctx.currentTime);
        osc.frequency.setValueAtTime(659.25, this.ctx.currentTime + 0.1);
        osc.frequency.setValueAtTime(783.99, this.ctx.currentTime + 0.2);
        g.gain.setValueAtTime(0.1, this.ctx.currentTime);
        osc.connect(g); g.connect(this.ctx.destination);
        osc.start(); osc.stop(this.ctx.currentTime + 0.35);
      }
      playLoss() {
        if (['lobby', 'login', 'admin', 'pwchange', 'deposit', 'withdraw'].includes(state.currentView)) return;
        this.init();
        let osc = this.ctx.createOscillator(); osc.type = 'sawtooth'; let g = this.ctx.createGain();
        osc.frequency.setValueAtTime(180, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(40, this.ctx.currentTime + 0.3);
        g.gain.setValueAtTime(0.1, this.ctx.currentTime);
        osc.connect(g); g.connect(this.ctx.destination);
        osc.start(); osc.stop(this.ctx.currentTime + 0.3);
      }
    }
    const sound = new SoundEngine();

    let state = {
      user: null,
      authMode: 'login',
      currentView: 'login',
      adminSubTab: 'users',
      aviator: { status: 'WAITING', currentX: 1.00, history: [] },
      userBet: 100,
      showCustomBetModal: false,
      hasBetAviator: false,
      nextRoundBet: false,
      cashedOut: false,
      popup: null,
      adminUsers: [],
      adminTxns: [],
      diceRolling: false,
      diceResults: [1, 1],
      marketHistory: [120, 125, 122, 130, 128, 135, 140, 138, 145, 150],
      predictionMark1: null,
      predictionMark2: null,
      predictionTimer: 0,
      pulseRadius: 0,

      careerboot: {
        stage: 'WHEEL',
        selectedSlice: null,
        spinning: false,
        wheelAngle: 0,
        round: 1,
        questionIndex: 0,
        activeQuestions: [],
        accumulatedMultiplier: 0,
        selectedAnswer: null,
        isAnswered: false,
        askedQuestionIdsThisGame: []
      }
    };

    function generate15kQuestions(category, prefix, sampleTemplates) {
      const mcqs = [];
      for (let i = 1; i <= 3750; i++) {
        sampleTemplates.forEach((tmpl, idx) => {
          mcqs.push({
            id: \`\${prefix}_\${i}_\${idx}\`,
            q: \`[#\${i}] \${tmpl.q}\`,
            opts: tmpl.opts,
            a: tmpl.a
          });
        });
      }
      return mcqs;
    }

    const CAREERBOOT_DATA = {
      'Grammar': {
        color: '#dc2626',
        lesson: \`
          <div class="space-y-4 text-sm text-amber-100/90 leading-relaxed text-left font-sans">
            <h3 class="text-base font-bold text-amber-300 border-b border-amber-500/30 pb-1">CHAPTER 1: Executive Writing & Sentence Mechanics</h3>
            <p><strong>1. Punctuation Rules:</strong> Avoid comma splices and misplaced commas. Correct: "The manager and supervisor agreed." (No comma needed between two subjects connected by 'and').</p>
            <p><strong>2. Subject-Verb Agreement:</strong> Singular indefinite pronouns like 'neither', 'either', and 'each' require singular verbs. Example: "Neither of the applicants is qualified." Collective nouns acting as a single unit take singular verbs ("A group of experts is presenting").</p>
            <p><strong>3. Dangling Modifiers:</strong> A modifier must clearly reference its subject. "Having finished the report, the computer crashed" is incorrect because the computer didn't finish the report. Correct structure attaches the modifier directly to the person performing the action.</p>

            <h3 class="text-base font-bold text-amber-300 border-b border-amber-500/30 pb-1 mt-4">CHAPTER 2: Advanced Pronouns & Style Consistency</h3>
            <p><strong>4. Pronoun Cases:</strong> Objective pronouns (me, him, her, us, them) are targets of prepositions or verbs: "Give the file to John and me" (not 'I' or 'myself').</p>
            <p><strong>5. Possessives vs Contractions:</strong> "Its" shows possession ("The bird lost its feather"), whereas "It's" is a contraction for "it is" or "it has".</p>
            <p><strong>6. Parallelism & Voice:</strong> Parallel structure maintains consistent grammatical forms ("reading, writing, and editing"). Active voice emphasizes the actor, whereas Passive voice ("The report was finalized by the committee") focuses on the receiver of the action.</p>

            <h3 class="text-base font-bold text-amber-300 border-b border-amber-500/30 pb-1 mt-4">CHAPTER 3: Clauses, Subjunctives & Diction</h3>
            <p><strong>7. Clause Independence & Subjunctive:</strong> Independent clauses can stand alone ("The quarterly figures exceeded projections"). Subjunctive mood expresses hypothetical situations: "If I were the CEO, I would expand."</p>
            <p><strong>8. Commonly Confused Words:</strong> "Affect" is primarily a verb meaning to influence ("The policy will affect all employees"), while "Effect" is usually a noun meaning a result.</p>
            <p><strong>9. Modifiers & Relative Pronouns:</strong> Adverbs modify adjectives ("exceptionally clear"). Use "whose" to demonstrate relative possession ("The client whose account closed"). Avoid double comparatives like "more smarter".</p>
          </div>
        \`,
        mcqs: generate15kQuestions('Grammar', 'GMR', [
          { q: "Identify the correctly punctuated sentence.", opts: ["The manager, and supervisor agreed.", "The manager and supervisor agreed.", "The manager, and supervisor, agreed.", "The manager and supervisor, agreed."], a: 1 },
          { q: "Which word correctly completes: 'Neither of the applicants ___ qualified.'", opts: ["are", "is", "were", "have"], a: 1 },
          { q: "Choose the sentence with correct subject-verb agreement.", opts: ["Data shows great progress.", "The team are winning.", "A group of experts is presenting.", "Both is arriving today."], a: 2 },
          { q: "Which phrase contains a dangling modifier?", opts: ["Having finished the report, the computer crashed.", "After completing the audit, she left.", "To succeed, practice daily.", "While reviewing numbers, we saw mistakes."], a: 0 }
        ])
      },
      'Vocabulary': {
        color: '#2563eb',
        lesson: \`
          <div class="space-y-4 text-sm text-amber-100/90 leading-relaxed text-left font-sans">
            <h3 class="text-base font-bold text-amber-300 border-b border-amber-500/30 pb-1">CHAPTER 1: Operational & Strategic Terminology</h3>
            <p><strong>1. Risk & Change Management:</strong> "Mitigate" means to lessen or reduce harm. "Pivot" refers to a strategic change in business direction without changing the core vision.</p>
            <p><strong>2. Synergy & Feasibility:</strong> "Synergy" represents combined effectiveness greater than individual parts. "Feasible" means something is possible and practical to execute.</p>
            <p><strong>3. Frameworks & Comparisons:</strong> A "Paradigm" is a standard pattern or model. A "Benchmark" is a standard of excellence against which performance is compared.</p>

            <h3 class="text-base font-bold text-amber-300 border-b border-amber-500/30 pb-1 mt-4">CHAPTER 2: Governance, Agreements & Disruption</h3>
            <p><strong>4. Transparency & Consensus:</strong> The antonym of transparent is "Opaque". "Consensus" represents general agreement across stakeholders.</p>
            <p><strong>5. Market Dynamics:</strong> "Disruptive" innovation radically alters an industry standard. "Scalable" processes expand without structural failure.</p>
            <p><strong>6. Leverage & Control:</strong> "Leverage" in strategy means to use resources to maximum competitive advantage.</p>

            <h3 class="text-base font-bold text-amber-300 border-b border-amber-500/30 pb-1 mt-4">CHAPTER 3: Corporate Finance & Efficiency</h3>
            <p><strong>7. Financial Trust:</strong> "Fiduciary" duties relate to legal trust and ethical financial management.</p>
            <p><strong>8. Operational Friction:</strong> A "Discrepancy" is an inconsistency in data. A "Bottleneck" is a point of congestion or delay in workflow.</p>
            <p><strong>9. Practical Strategy:</strong> "Pragmatic" approaches focus on practical, realistic outcomes over idealist theories.</p>
          </div>
        \`,
        mcqs: generate15kQuestions('Vocabulary', 'VOC', [
          { q: "What does 'Mitigate' mean?", opts: ["Increase severity", "Lessen or reduce harm", "Duplicate records", "Delay execution"], a: 1 },
          { q: "Choose the synonym for 'Synergy'.", opts: ["Isolation", "Combined effectiveness", "Conflict", "Division"], a: 1 },
          { q: "What is the meaning of 'Pivot' in business?", opts: ["Close operations", "Maintain current strategy", "Strategic change in course", "File for bankruptcy"], a: 2 },
          { q: "Define 'Feasible'.", opts: ["Impossible to execute", "Possible and practical", "Expensive", "Theoretical only"], a: 1 }
        ])
      },
      'MS Excel': {
        color: '#059669',
        lesson: \`
          <div class="space-y-4 text-sm text-amber-100/90 leading-relaxed text-left font-sans">
            <h3 class="text-base font-bold text-amber-300 border-b border-amber-500/30 pb-1">CHAPTER 1: Lookup Functions & References</h3>
            <p><strong>1. Lookup Logic:</strong> VLOOKUP searches for values in the leftmost column of a dataset. XLOOKUP is the modern replacement that eliminates leftward lookup constraints and default exact-match issues.</p>
            <p><strong>2. Cell Referencing:</strong> The "$" symbol freezes row/column coordinates ($A$1). The F4 key cycles through relative, absolute, and mixed reference modes.</p>
            <p><strong>3. Index & Match:</strong> Combining INDEX and MATCH provides a robust alternative to VLOOKUP for dynamic, non-contiguous multi-column lookups.</p>

            <h3 class="text-base font-bold text-amber-300 border-b border-amber-500/30 pb-1 mt-4">CHAPTER 2: Data Aggregation & Summarization</h3>
            <p><strong>4. Pivot Tables:</strong> Pivot Tables rapidly aggregate, summarize, and cross-tabulate large datasets without writing complex formulas.</p>
            <p><strong>5. Conditional Functions:</strong> COUNTIF counts cells matching a single condition, while AVERAGEIFS calculates average values meeting multiple criteria.</p>
            <p><strong>6. Logical Statements:</strong> The IF function evaluates expressions (=IF(5>3, 'Yes', 'No') returns 'Yes').</p>

            <h3 class="text-base font-bold text-amber-300 border-b border-amber-500/30 pb-1 mt-4">CHAPTER 3: Error Handling & Text Formatting</h3>
            <p><strong>7. Error Codes:</strong> #N/A indicates a value is not available. #DIV/0! signifies division by zero.</p>
            <p><strong>8. Text Processing:</strong> CONCATENATE / TEXTJOIN merge multiple strings. TRIM() cleans trailing or leading irregular spaces from text.</p>
            <p><strong>9. Data Filtering & Shortcuts:</strong> Filtering isolates specific rows matching rules. CTRL + Z performs undo actions instantly.</p>
          </div>
        \`,
        mcqs: generate15kQuestions('MS Excel', 'EXC', [
          { q: "Which formula searches for a value in the leftmost column of a table?", opts: ["XLOOKUP", "VLOOKUP", "HLOOKUP", "INDEX"], a: 1 },
          { q: "What symbol freezes cell references in Excel (Absolute Reference)?", opts: ["#", "$", "%", "&"], a: 1 },
          { q: "Which feature rapidly summarizes large sets of operational data?", opts: ["Data Validation", "Pivot Table", "Conditional Formatting", "Goal Seek"], a: 1 },
          { q: "What does #N/A mean in Excel?", opts: ["Value not available", "Number overflow", "Column width small", "Division by zero"], a: 0 }
        ])
      },
      'Business analytics': {
        color: '#d97706',
        lesson: \`
          <div class="space-y-4 text-sm text-amber-100/90 leading-relaxed text-left font-sans">
            <h3 class="text-base font-bold text-amber-300 border-b border-amber-500/30 pb-1">CHAPTER 1: Analytics Taxonomies & KPIs</h3>
            <p><strong>1. Analytics Types:</strong> Descriptive analytics focuses on past events ("What happened"), Diagnostic analyzes causes, Predictive forecasts trends, and Prescriptive analytics recommends specific business decisions.</p>
            <p><strong>2. Key Performance Indicators:</strong> KPI stands for Key Performance Indicator. Core metrics include ROI (Return on Investment) and NPS (Net Promoter Score for customer loyalty).</p>
            <p><strong>3. Customer Economics:</strong> CAC is Customer Acquisition Cost. LTV is Customer Lifetime Value. Churn Rate tracks customer loss percentage over time.</p>

            <h3 class="text-base font-bold text-amber-300 border-b border-amber-500/30 pb-1 mt-4">CHAPTER 2: Experimentation & Statistical Concepts</h3>
            <p><strong>4. Controlled Testing:</strong> A/B Testing compares two versions of a variable to determine which performs better statistically.</p>
            <p><strong>5. Correlation & Outliers:</strong> A correlation coefficient of +1 indicates a perfect positive linear relationship. Outliers are extreme data points significantly distant from other observations.</p>
            <p><strong>6. Data Cleaning & Mining:</strong> Data cleaning fixes corrupt, incomplete, or duplicate records. Data mining extracts underlying patterns from large datasets.</p>

            <h3 class="text-base font-bold text-amber-300 border-b border-amber-500/30 pb-1 mt-4">CHAPTER 3: Data Visualization & Longitudinal Analysis</h3>
            <p><strong>7. Trend Visualization:</strong> Line charts represent numeric values over continuous time intervals far better than pie charts.</p>
            <p><strong>8. Cohort Analysis:</strong> Cohort analysis tracks specific user groups sharing common characteristics over predefined timeframes.</p>
          </div>
        \`,
        mcqs: generate15kQuestions('Business analytics', 'BSA', [
          { q: "What type of analytics explains 'What happened in the past'?", opts: ["Predictive", "Descriptive", "Prescriptive", "Diagnostic"], a: 1 },
          { q: "What does KPI stand for?", opts: ["Key Process Integration", "Key Performance Indicator", "Known Program Insight", "Key Profit Index"], a: 1 },
          { q: "What metric tracks customer turnover/loss rate?", opts: ["Churn Rate", "Bounce Rate", "Retention Index", "LTV"], a: 0 },
          { q: "What does LTV stand for in customer analytics?", opts: ["Long Term Value", "Lifetime Value", "Last Transaction Valuation", "Lead Total Value"], a: 1 }
        ])
      }
    };

    function drawRoundedRect(ctx, x, y, width, height, radius, fillStyle, textColor, text) {
      ctx.fillStyle = fillStyle;
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + width - radius, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
      ctx.lineTo(x + width, y + height - radius);
      ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
      ctx.lineTo(x + radius, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
      ctx.fill();

      if (text) {
        ctx.fillStyle = textColor;
        ctx.fillText(text, x + 6, y + 13);
      }
    }

    function switchView(targetView) {
      if (['lobby', 'login', 'admin', 'pwchange', 'deposit', 'withdraw'].includes(targetView)) {
        sound.stopAll();
      }
      state.currentView = targetView;
      render();
    }

    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onmessage = async (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'AVIATOR_STATE') {
        state.aviator = data;
        if (data.status === 'WAITING') {
          if (state.nextRoundBet && state.user) {
            try {
              const res = await fetch('/api/aviator/bet', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: state.user.username, betAmount: state.userBet })
              });
              const bData = await res.json();
              if (res.ok) {
                state.user.balance = bData.newBalance;
                state.hasBetAviator = true;
              } else {
                showPopup(bData.error || 'Bet Failed', 'OK');
              }
            } catch(err) {
              console.error(err);
            }
            state.nextRoundBet = false;
          }
          state.cashedOut = false;
        }
        if (data.status === 'FLYING' && !state.cashedOut) sound.playFly();
        if (data.status === 'CRASHED' && state.hasBetAviator && !state.cashedOut) {
          sound.playLoss();
          if (state.user) {
            try {
              const res = await fetch('/api/aviator/loss', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: state.user.username, betAmount: state.userBet })
              });
              const lData = await res.json();
              if (res.ok) state.user.balance = lData.newBalance;
            } catch(err) {
              console.error(err);
            }
          }
          state.hasBetAviator = false;
        }
        if (state.currentView === 'aviator') renderAviatorOverlay();
      }
    };

    function showPopup(title, btnText, onConfirm = null) {
      state.popup = { title, btnText, onConfirm };
      render();
    }
    function closePopup() { 
      if (state.popup && state.popup.onConfirm) state.popup.onConfirm();
      state.popup = null; 
      render(); 
    }

    async function handleAuth() {
      sound.init();
      const u = document.getElementById('u').value;
      const p = document.getElementById('p').value;
      const endpoint = state.authMode === 'signup' ? '/api/signup' : '/api/login';
      try {
        const res = await fetch(endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u, password: p })
        });
        const data = await res.json();
        if (res.ok) {
          state.user = data;
          if(!state.user.seenQuestions) state.user.seenQuestions = [];
          switchView(state.user.role === 'admin' ? 'admin' : 'lobby');
          if (state.user.role === 'admin') fetchAdminData();
        } else {
          showPopup(data.error || 'Authentication Failed', 'Try again');
        }
      } catch(e) {
        showPopup('Connection Error', 'Try again');
      }
      render();
    }

    async function fetchAdminData() {
      const [uRes, tRes] = await Promise.all([
        fetch('/api/admin/users'),
        fetch('/api/admin/transactions')
      ]);
      if (uRes.ok) state.adminUsers = await uRes.json();
      if (tRes.ok) state.adminTxns = await tRes.json();
      render();
    }

    function checkLoginInputsDirectly() {
      const u = document.getElementById('u')?.value || '';
      const p = document.getElementById('p')?.value || '';
      const btn = document.getElementById('lbtn');
      if (btn) {
        if (u.trim() !== '' && p.trim() !== '') btn.classList.remove('hidden');
        else btn.classList.add('hidden');
      }
    }

    async function changePassword() {
      const oldPassword = document.getElementById('opw').value;
      const newPassword = document.getElementById('npw').value;
      const res = await fetch('/api/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: state.user.username, oldPassword, newPassword })
      });
      const data = await res.json();
      if (res.ok) showPopup(data.message, 'OK');
      else showPopup(data.error || 'Error', 'OK');
    }

    async function submitDeposit() {
      const amount = document.getElementById('depAmt').value;
      const txnId = document.getElementById('depTxn').value;
      const res = await fetch('/api/deposit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: state.user.username, amount, txnId })
      });
      const data = await res.json();
      if (res.ok) showPopup(data.message, 'OK', () => switchView('lobby'));
      else showPopup(data.error || 'Deposit Failed', 'OK');
    }

    async function submitWithdrawal() {
      const amount = document.getElementById('wdAmt').value;
      const upiId = document.getElementById('wdUpi').value;
      const res = await fetch('/api/withdraw', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: state.user.username, amount, upiId })
      });
      const data = await res.json();
      if (res.ok) {
        state.user.balance = data.newBalance;
        showPopup(data.message, 'OK', () => switchView('lobby'));
      } else {
        showPopup(data.error || 'Withdrawal Failed', 'OK');
      }
    }

    async function processTxn(txnId, action) {
      const res = await fetch('/api/admin/process-transaction', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txnId, action })
      });
      if (res.ok) {
        fetchAdminData();
        showPopup('Transaction Processed!', 'OK');
      } else {
        showPopup('Action Failed', 'OK');
      }
    }

    function updateBetAmount(delta) {
      state.userBet = Math.max(10, state.userBet + delta);
      const inputs = document.querySelectorAll('.bet-amt-input');
      inputs.forEach(i => i.value = state.userBet);
      if(state.currentView === 'aviator') renderAviatorOverlay();
      else render();
    }

    function openCustomBetModal() {
      state.showCustomBetModal = true;
      render();
      setTimeout(() => {
        const input = document.getElementById('customBetInput');
        if (input) input.focus();
      }, 50);
    }

    function applyCustomBetAmount() {
      const input = document.getElementById('customBetInput');
      const val = parseFloat(input?.value);
      if (!isNaN(val) && val >= 10) {
        state.userBet = Math.floor(val);
      } else {
        state.userBet = 10;
      }
      state.showCustomBetModal = false;
      render();
    }

    function renderBetControllerUI() {
      return \`
        <div class="flex items-center justify-between bg-black/60 p-2 rounded-2xl border border-amber-500/40 w-full max-w-xs shadow-lg">
          <span class="text-xs text-amber-300 font-bold ml-2">BET AMOUNT:</span>
          <div class="flex items-center gap-2">
            <button onclick="updateBetAmount(-10)" class="w-9 h-9 rounded-xl bg-red-900/80 border border-red-500 text-amber-300 font-black text-lg flex items-center justify-center active:scale-95">-</button>
            <input type="number" readonly onclick="openCustomBetModal()" value="\${state.userBet}" class="bet-amt-input w-20 bg-black/80 border border-amber-500/50 rounded-xl text-center font-mono font-bold text-amber-300 py-1.5 text-sm outline-none cursor-pointer hover:border-amber-400 transition-all">
            <button onclick="updateBetAmount(10)" class="w-9 h-9 rounded-xl bg-emerald-900/80 border border-emerald-500 text-amber-300 font-black text-lg flex items-center justify-center active:scale-95">+</button>
          </div>
        </div>
      \`;
    }

    // --- GAME 1: AVIATOR ---
    async function handleAviatorAction() {
      sound.init();
      if (state.aviator.status === 'WAITING' && !state.hasBetAviator) {
        if(state.user.balance < state.userBet) return showPopup("Insufficient Balance!", "OK");
        try {
          const res = await fetch('/api/aviator/bet', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: state.user.username, betAmount: state.userBet })
          });
          const data = await res.json();
          if (res.ok) {
            state.user.balance = data.newBalance;
            state.hasBetAviator = true;
            renderAviatorOverlay();
          } else {
            showPopup(data.error || 'Bet Failed', 'OK');
          }
        } catch(e) {
          showPopup('Connection Error', 'OK');
        }
      } else if (state.aviator.status === 'FLYING') {
        if (state.hasBetAviator && !state.cashedOut) {
          state.cashedOut = true;
          try {
            const res = await fetch('/api/aviator/cashout', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: state.user.username, betAmount: state.userBet, multiplier: state.aviator.currentX })
            });
            const data = await res.json();
            if (res.ok) {
              state.user.balance = data.newBalance;
              sound.playWin();
              showPopup(\`CASHED OUT AT \${state.aviator.currentX.toFixed(2)}x! WON â‚¹\${data.winAmount}\`, 'Paisa hi Paisa');
            } else {
              showPopup(data.error || 'Cashout Failed', 'OK');
            }
          } catch(e) {
            showPopup('Cashout Connection Error', 'OK');
          }
          state.hasBetAviator = false;
          renderAviatorOverlay();
        } else if (!state.hasBetAviator && !state.nextRoundBet) {
          if(state.user.balance < state.userBet) return showPopup("Insufficient Balance!", "OK");
          state.nextRoundBet = true;
          renderAviatorOverlay();
        }
      }
    }

    function renderAviatorCanvas() {
      const cvs = document.getElementById('aviator-canvas');
      if(!cvs) return;
      const ctx = cvs.getContext('2d');
      const w = cvs.width = cvs.clientWidth;
      const h = cvs.height = cvs.clientHeight;

      ctx.clearRect(0, 0, w, h);
      
      ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 1;
      for(let x=0; x<w; x+=30) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
      for(let y=0; y<h; y+=30) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }

      if(state.aviator.status === 'FLYING' || state.aviator.status === 'CRASHED') {
        const progress = Math.min((state.aviator.currentX - 1) / 8, 1);
        const endX = 30 + (w - 70) * progress;
        const endY = (h - 30) - (h - 70) * Math.pow(progress, 0.8);

        ctx.beginPath();
        ctx.moveTo(30, h - 30);
        ctx.quadraticCurveTo(w * 0.35, h - 30, endX, endY);
        ctx.strokeStyle = state.aviator.status === 'CRASHED' ? '#ef4444' : '#eab308';
        ctx.lineWidth = 4;
        ctx.stroke();

        ctx.lineTo(endX, h - 30); ctx.lineTo(30, h - 30);
        ctx.fillStyle = state.aviator.status === 'CRASHED' ? 'rgba(239, 68, 68, 0.2)' : 'rgba(234, 179, 8, 0.2)';
        ctx.fill();

        ctx.save();
        ctx.translate(endX, endY);
        if(state.aviator.status === 'CRASHED') {
          ctx.font = '32px sans-serif';
          ctx.fillText('ðŸ’¥', -16, 12);
        } else {
          ctx.rotate(-Math.PI / 8);
          ctx.fillStyle = '#ef4444';
          ctx.beginPath();
          ctx.ellipse(0, 0, 16, 7, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.moveTo(8, -2); ctx.lineTo(-4, -12); ctx.lineTo(-8, -2);
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(-10, 0); ctx.lineTo(-16, -6); ctx.lineTo(-16, 6);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    function renderAviatorOverlay() {
      renderAviatorCanvas();
      const xElem = document.getElementById('aviator-x');
      const statusElem = document.getElementById('aviator-status');
      const actionBtn = document.getElementById('aviator-btn');

      if (xElem) {
        xElem.innerText = state.aviator.currentX.toFixed(2) + 'x';
        xElem.className = \`text-5xl font-black font-mono \${state.aviator.status === 'CRASHED' ? 'text-red-500' : 'text-amber-400'}\`;
      }
      if (statusElem) {
        statusElem.innerText = state.aviator.status === 'WAITING' ? 'WAITING FOR NEXT ROUND (5s)' : (state.aviator.status === 'FLYING' ? 'FLYING' : 'FLEW AWAY!');
        statusElem.className = \`text-xs font-bold px-3 py-1 rounded-full \${state.aviator.status === 'FLYING' ? 'bg-amber-900/80 text-amber-300 border border-amber-500' : 'bg-red-900/80 text-red-300 border border-red-500'}\`;
      }

      if (actionBtn) {
        if (state.aviator.status === 'WAITING') {
          actionBtn.disabled = state.hasBetAviator;
          actionBtn.innerHTML = state.hasBetAviator ? 'BET PLACED FOR NEXT ROUND' : \`BET â‚¹\${state.userBet}\`;
          actionBtn.className = \`w-full h-14 rounded-2xl font-black text-xl tracking-wider transition-all shadow-lg \${state.hasBetAviator ? 'bg-gray-700 text-gray-400' : 'bg-red-600 text-white border-2 border-red-400'}\`;
        } else if (state.aviator.status === 'FLYING') {
          if (state.hasBetAviator && !state.cashedOut) {
            actionBtn.disabled = false;
            actionBtn.innerHTML = \`CASH OUT (â‚¹\${(state.userBet * state.aviator.currentX).toFixed(2)})\`;
            actionBtn.className = 'w-full h-14 rounded-2xl font-black text-xl tracking-wider shadow-lg bg-emerald-500 text-black border-2 border-green-300 animate-pulse';
          } else if (state.nextRoundBet) {
            actionBtn.disabled = true;
            actionBtn.innerHTML = 'BET QUEUED FOR NEXT ROUND';
            actionBtn.className = 'w-full h-14 rounded-2xl font-black text-lg tracking-wider shadow-lg bg-amber-700 text-amber-200 border border-amber-500';
          } else {
            actionBtn.disabled = false;
            actionBtn.innerHTML = \`BET FOR NEXT ROUND (â‚¹\${state.userBet})\`;
            actionBtn.className = 'w-full h-14 rounded-2xl font-black text-lg tracking-wider shadow-lg bg-red-700 text-white border border-red-400';
          }
        } else {
          actionBtn.disabled = true;
          actionBtn.innerHTML = 'ROUND ENDED';
          actionBtn.className = 'w-full h-14 rounded-2xl font-black text-xl tracking-wider shadow-lg bg-gray-800 text-gray-500';
        }
      }
    }

    // --- GAME 2: GUESS CORRECT (DICE) ---
    async function playDiceGame(choice) {
      sound.init();
      if(state.user.balance < state.userBet) return showPopup("Insufficient Balance!", "OK");
      if(state.diceRolling) return;

      state.diceRolling = true;
      let animInterval = setInterval(() => {
        state.diceResults = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1];
        sound.playCoinFlip();
        render();
      }, 100);

      const res = await fetch('/api/play-instant', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: state.user.username, game: 'dice', betAmount: state.userBet, choice })
      });
      const data = await res.json();

      setTimeout(() => {
        clearInterval(animInterval);
        state.diceRolling = false;
        if (res.ok) {
          state.diceResults = [data.resultMeta.dice1, data.resultMeta.dice2];
          state.user.balance = data.newBalance;
          render();
          
          setTimeout(() => {
            if (data.won) {
              sound.playWin();
              showPopup(\`MATCHED! Sum is \${data.resultMeta.sum}. WON â‚¹\${(state.userBet * data.rewardMultiplier).toFixed(2)} (\${data.rewardMultiplier}x)!\`, 'Paisa hi Paisa');
            } else {
              sound.playLoss();
              showPopup(\`MISMATCH! Sum is \${data.resultMeta.sum}. YOU LOST!\`, 'Try Again');
            }
          }, 500);
        } else {
          showPopup(data.error || 'Error', 'OK');
        }
      }, 1500);
    }

    // --- GAME 3: PREDICTION GRAPH ---
    async function playPrediction(dir) {
      sound.init();
      if(state.user.balance < state.userBet) return showPopup("Insufficient Balance!", "OK");
      if(state.predictionTimer > 0) return;

      const startVal = state.marketHistory[state.marketHistory.length - 1];
      state.predictionMark1 = startVal;
      state.predictionMark2 = null;
      state.predictionTimer = 6;

      let timerInterval = setInterval(() => {
        state.predictionTimer--;
        sound.playMarketBeep();
        render();
        if(state.predictionTimer <= 0) {
          clearInterval(timerInterval);
          finishPrediction(dir, startVal);
        }
      }, 1000);
    }

    async function finishPrediction(dir, startVal) {
      const endVal = state.marketHistory[state.marketHistory.length - 1];
      state.predictionMark2 = endVal;
      render();

      const res = await fetch('/api/play-instant', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: state.user.username, game: 'prediction', betAmount: state.userBet, choice: { startVal, endVal, direction: dir } })
      });
      const data = await res.json();

      setTimeout(() => {
        if (res.ok) {
          state.user.balance = data.newBalance;
          if (data.won) {
            sound.playWin();
            showPopup(\`SUCCESS! Entry: â‚¹\${startVal} | Exit: â‚¹\${endVal}. WON â‚¹\${(state.userBet * 2).toFixed(2)}!\`, 'Paisa hi Paisa', () => {
              state.predictionMark1 = null; state.predictionMark2 = null;
            });
          } else {
            sound.playLoss();
            showPopup(\`FAILED! Entry: â‚¹\${startVal} | Exit: â‚¹\${endVal}. YOU LOST!\`, 'Try Again', () => {
              state.predictionMark1 = null; state.predictionMark2 = null;
            });
          }
        } else {
          showPopup(data.error || 'Error', 'OK');
          state.predictionMark1 = null; state.predictionMark2 = null;
        }
        render();
      }, 1000);
    }

    // --- GAME 4: CAREERBOOT ENGINE ---
    function renderCareerBootWheelCanvas() {
      const cvs = document.getElementById('cb-wheel-canvas');
      if (!cvs) return;
      const ctx = cvs.getContext('2d');
      const dpr = window.devicePixelRatio || 2;
      const rect = cvs.getBoundingClientRect();

      cvs.width = rect.width * dpr;
      cvs.height = rect.height * dpr;
      ctx.scale(dpr, dpr);

      const w = rect.width;
      const h = rect.height;
      const r = Math.min(w, h) / 2 - 12;
      const cx = w / 2;
      const cy = h / 2;

      ctx.clearRect(0, 0, w, h);

      const slices = Object.keys(CAREERBOOT_DATA);
      const arc = (Math.PI * 2) / slices.length;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(state.careerboot.wheelAngle);

      slices.forEach((sliceKey, i) => {
        const sliceStartAngle = i * arc;
        const sliceEndAngle = sliceStartAngle + arc;

        ctx.beginPath();
        ctx.fillStyle = CAREERBOOT_DATA[sliceKey].color;
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, r, sliceStartAngle, sliceEndAngle);
        ctx.lineTo(0, 0);
        ctx.fill();

        ctx.strokeStyle = '#d4af37';
        ctx.lineWidth = 3;
        ctx.stroke();

        const labelText = sliceKey.toUpperCase();
        const textRadius = r * 0.62;
        const sliceMidAngle = sliceStartAngle + arc / 2;

        let fontSize = 13;
        ctx.font = \`900 \${fontSize}px ui-sans-serif, system-ui, sans-serif\`;
        let totalWidth = ctx.measureText(labelText).width;
        
        const maxAllowedArcWidth = textRadius * arc * 0.82;
        if (totalWidth > maxAllowedArcWidth) {
          fontSize = Math.floor(fontSize * (maxAllowedArcWidth / totalWidth));
          ctx.font = \`900 \${Math.max(fontSize, 9)}px ui-sans-serif, system-ui, sans-serif\`;
          totalWidth = ctx.measureText(labelText).width;
        }

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = 6;

        let currentAngle = sliceMidAngle - (totalWidth / textRadius) / 2;

        for (let j = 0; j < labelText.length; j++) {
          const char = labelText[j];
          const charWidth = ctx.measureText(char).width;
          const charAngle = currentAngle + (charWidth / 2) / textRadius;

          ctx.save();
          ctx.rotate(charAngle);
          ctx.translate(textRadius, 0);
          ctx.rotate(Math.PI / 2);
          ctx.fillText(char, 0, 0);
          ctx.restore();

          currentAngle += charWidth / textRadius;
        }
      });

      ctx.restore();

      ctx.fillStyle = '#fcf6ba';
      ctx.beginPath();
      ctx.moveTo(cx - 12, cy - r - 6);
      ctx.lineTo(cx + 12, cy - r - 6);
      ctx.lineTo(cx, cy - r + 18);
      ctx.fill();
      ctx.strokeStyle = '#800a0a';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    async function spinCareerBootWheel() {
      sound.init();
      if (state.user.balance < state.userBet) return showPopup("Insufficient Balance!", "OK");
      if (state.careerboot.spinning) return;

      state.careerboot.spinning = true;
      const slices = Object.keys(CAREERBOOT_DATA);
      const chosenIndex = Math.floor(Math.random() * slices.length);
      const chosenSlice = slices[chosenIndex];

      const arc = (Math.PI * 2) / slices.length;
      const targetSliceCenter = chosenIndex * arc + (arc / 2);
      let targetAngle = (Math.PI * 1.5) - targetSliceCenter;
      if (targetAngle < 0) targetAngle += Math.PI * 2;

      const totalSpins = 5 * Math.PI * 2;
      const finalAngle = state.careerboot.wheelAngle + totalSpins + targetAngle - (state.careerboot.wheelAngle % (Math.PI * 2));

      let startTime = null;
      const duration = 3000;

      function animateSpin(timestamp) {
        if (!startTime) startTime = timestamp;
        let elapsed = timestamp - startTime;
        let progress = Math.min(elapsed / duration, 1);
        let easeOut = 1 - Math.pow(1 - progress, 3);

        state.careerboot.wheelAngle = easeOut * finalAngle;
        sound.playCoinFlip();
        renderCareerBootWheelCanvas();

        if (progress < 1) {
          requestAnimationFrame(animateSpin);
        } else {
          state.careerboot.spinning = false;
          state.careerboot.selectedSlice = chosenSlice;
          state.careerboot.stage = 'LESSON';
          render();
        }
      }

      requestAnimationFrame(animateSpin);
    }

    function startCareerBootMCQs() {
      const sliceObj = CAREERBOOT_DATA[state.careerboot.selectedSlice];
      state.careerboot.round = 1;
      state.careerboot.questionIndex = 0;
      state.careerboot.accumulatedMultiplier = 0;
      state.careerboot.selectedAnswer = null;
      state.careerboot.isAnswered = false;
      state.careerboot.askedQuestionIdsThisGame = [];

      const seenSet = new Set(state.user.seenQuestions || []);
      
      let availableMCQs = sliceObj.mcqs.filter(m => !seenSet.has(m.id));

      if (availableMCQs.length < 15) {
        const catPrefixes = { 'Grammar': 'GMR_', 'Vocabulary': 'VOC_', 'MS Excel': 'EXC_', 'Business analytics': 'BSA_' };
        const prefix = catPrefixes[state.careerboot.selectedSlice];
        if (prefix) {
          state.user.seenQuestions = (state.user.seenQuestions || []).filter(id => !id.startsWith(prefix));
        }
        availableMCQs = [...sliceObj.mcqs];
      }

      const shuffled = [...availableMCQs];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      state.careerboot.activeQuestions = shuffled.slice(0, 15);
      state.careerboot.askedQuestionIdsThisGame = state.careerboot.activeQuestions.map(q => q.id);

      state.careerboot.stage = 'MCQ';
      render();
    }

    async function handleCareerBootAnswer(selectedOptIndex) {
      if (state.careerboot.isAnswered) return;

      state.careerboot.selectedAnswer = selectedOptIndex;
      state.careerboot.isAnswered = true;

      const currentRound = state.careerboot.round;
      const qIdx = (currentRound - 1) * 5 + state.careerboot.questionIndex;
      const currentQ = state.careerboot.activeQuestions[qIdx];

      render();

      if (selectedOptIndex === currentQ.a) {
        sound.playWin();
        const roundMult = currentRound === 1 ? 1.40 : (currentRound === 2 ? 1.60 : 2.00);
        state.careerboot.accumulatedMultiplier += roundMult;

        setTimeout(async () => {
          state.careerboot.selectedAnswer = null;
          state.careerboot.isAnswered = false;

          if (state.careerboot.questionIndex < 4) {
            state.careerboot.questionIndex++;
          } else {
            if (currentRound < 3) {
              state.careerboot.round++;
              state.careerboot.questionIndex = 0;
              showPopup(\`ROUND \${currentRound} COMPLETED! Next Round Multiplier Unlocked!\`, 'Continue');
            } else {
              const finalMult = state.careerboot.accumulatedMultiplier;
              const res = await fetch('/api/play-instant', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  username: state.user.username,
                  game: 'careerboot',
                  betAmount: state.userBet,
                  choice: {
                    won: true,
                    multiplier: finalMult,
                    askedQuestionIds: state.careerboot.askedQuestionIdsThisGame
                  }
                })
              });
              const data = await res.json();
              if (res.ok) {
                state.user.balance = data.newBalance;
                state.user.seenQuestions = data.seenQuestions || [];
              }

              sound.playWin();
              showPopup(\`ALL ROUNDS PASSED! Total Multiplier \${finalMult.toFixed(2)}x! WON â‚¹\${(state.userBet * finalMult).toFixed(2)}!\`, 'Paisa hi Paisa', () => {
                state.careerboot.stage = 'WHEEL';
              });
            }
          }
          render();
        }, 1000);

      } else {
        sound.playLoss();
        const res = await fetch('/api/play-instant', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: state.user.username,
            game: 'careerboot',
            betAmount: state.userBet,
            choice: {
              won: false,
              multiplier: 0,
              askedQuestionIds: state.careerboot.askedQuestionIdsThisGame
            }
          })
        });
        const data = await res.json();
        if (res.ok) {
          state.user.balance = data.newBalance;
          state.user.seenQuestions = data.seenQuestions || [];
        }

        setTimeout(() => {
          showPopup(\`WRONG ANSWER! Correct answer highlighted in green. YOU LOST â‚¹\${state.userBet}.\`, 'Try Again', () => {
            state.careerboot.selectedAnswer = null;
            state.careerboot.isAnswered = false;
            state.careerboot.stage = 'WHEEL';
          });
        }, 1600);
      }
    }

    setInterval(() => {
      let lastVal = state.marketHistory[state.marketHistory.length - 1] || 120;
      let change = (Math.random() - 0.48) * 12;
      let nextVal = Math.max(20, Math.min(300, Math.round(lastVal + change)));
      state.marketHistory.push(nextVal);
      if (state.marketHistory.length > 25) state.marketHistory.shift();
      if (state.currentView === 'prediction') renderPredictionGraph();
    }, 1000);

    function renderPredictionGraph() {
      const cvs = document.getElementById('market-canvas');
      if(!cvs) return;
      const ctx = cvs.getContext('2d');
      const w = cvs.width = cvs.clientWidth;
      const h = cvs.height = cvs.clientHeight;

      ctx.clearRect(0, 0, w, h);
      
      const pts = state.marketHistory;
      let minVal = Math.min(...pts, state.predictionMark1 || Infinity, state.predictionMark2 || Infinity) - 15;
      let maxVal = Math.max(...pts, state.predictionMark1 || -Infinity, state.predictionMark2 || -Infinity) + 15;
      if (minVal === Infinity) minVal = 40;
      if (maxVal === -Infinity) maxVal = 220;
      let range = maxVal - minVal || 1;

      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 0.5;
      for (let y = 0; y < h; y += 25) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
      for (let x = 0; x < w; x += 35) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }

      const step = w / (pts.length - 1);

      let fillGrad = ctx.createLinearGradient(0, 0, 0, h);
      fillGrad.addColorStop(0, 'rgba(34, 197, 94, 0.35)');
      fillGrad.addColorStop(1, 'rgba(34, 197, 94, 0.00)');

      ctx.beginPath();
      for(let i = 0; i < pts.length; i++) {
        let y = h - ((pts[i] - minVal) / range) * (h - 30) - 15;
        let x = i * step;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      
      let lastVal = pts[pts.length - 1];
      let lastX = w;
      let lastY = h - ((lastVal - minVal) / range) * (h - 30) - 15;

      ctx.lineTo(lastX, h);
      ctx.lineTo(0, h);
      ctx.fillStyle = fillGrad;
      ctx.fill();

      ctx.beginPath();
      for(let i = 0; i < pts.length; i++) {
        let y = h - ((pts[i] - minVal) / range) * (h - 30) - 15;
        let x = i * step;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.shadowColor = '#22c55e';
      ctx.shadowBlur = 12;
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 3.5;
      ctx.stroke();
      ctx.shadowBlur = 0;

      state.pulseRadius = (state.pulseRadius + 0.3) % 12;
      ctx.beginPath();
      ctx.arc(lastX - 4, lastY, 4 + state.pulseRadius, 0, Math.PI * 2);
      ctx.strokeStyle = \`rgba(34, 197, 94, \${1 - state.pulseRadius / 12})\`;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(lastX - 4, lastY, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      drawRoundedRect(ctx, lastX - 68, lastY - 26, 62, 20, 6, '#22c55e', '#000000', 'â‚¹' + lastVal);

      if (state.predictionMark1) {
        let y1 = h - ((state.predictionMark1 - minVal) / range) * (h - 30) - 15;
        ctx.beginPath();
        ctx.shadowColor = '#eab308';
        ctx.shadowBlur = 8;
        ctx.strokeStyle = '#eab308';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.moveTo(0, y1); ctx.lineTo(w, y1);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;

        drawRoundedRect(ctx, 8, y1 - 20, 100, 18, 4, '#eab308', '#000000', 'ENTRY: â‚¹' + state.predictionMark1);
      }

      if (state.predictionMark2) {
        let y2 = h - ((state.predictionMark2 - minVal) / range) * (h - 30) - 15;
        ctx.beginPath();
        ctx.shadowColor = '#06b6d4';
        ctx.shadowBlur = 8;
        ctx.strokeStyle = '#06b6d4';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.moveTo(0, y2); ctx.lineTo(w, y2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;

        drawRoundedRect(ctx, w - 108, y2 - 20, 100, 18, 4, '#06b6d4', '#000000', 'EXIT: â‚¹' + state.predictionMark2);
      }
    }

    // ==========================================
    // UI RENDER ENGINE
    // ==========================================
    function render() {
      const app = document.getElementById('app');
      let html = '';

      let popupHtml = '';
      if (state.popup) {
        popupHtml = \`
          <div class="absolute inset-0 bg-black/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
            <div class="tomato-card p-6 rounded-3xl max-w-xs w-full text-center space-y-4 popup-anim">
              <h2 class="text-xl font-black text-amber-300 tracking-wide">\${state.popup.title}</h2>
              <button onclick="closePopup()" class="w-full gold-gradient text-black font-black py-3 rounded-2xl shadow-xl active:scale-95">
                \${state.popup.btnText}
              </button>
            </div>
          </div>
        \`;
      }

      let customBetModalHtml = '';
      if (state.showCustomBetModal) {
        customBetModalHtml = \`
          <div class="absolute inset-0 bg-black/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
            <div class="tomato-card p-6 rounded-3xl max-w-xs w-full text-center space-y-4 popup-anim">
              <h2 class="text-lg font-black text-amber-300 tracking-wide">Enter Custom Bet Amount</h2>
              <input id="customBetInput" type="number" min="10" value="\${state.userBet}" placeholder="Enter amount (Min â‚¹10)" class="w-full p-3 rounded-2xl bg-black/80 border border-amber-500/50 text-amber-300 text-center font-mono font-bold text-lg outline-none">
              <div class="flex gap-2">
                <button onclick="state.showCustomBetModal=false; render();" class="w-1/2 py-3 bg-gray-800 text-gray-300 font-bold rounded-2xl active:scale-95 text-xs">Cancel</button>
                <button onclick="applyCustomBetAmount()" class="w-1/2 gold-gradient text-black font-black py-3 rounded-2xl shadow-xl active:scale-95 text-xs">Set Bet</button>
              </div>
            </div>
          </div>
        \`;
      }

      if (state.currentView === 'login') {
        const isSignUp = state.authMode === 'signup';
        html = \`
          <div class="h-full w-full flex flex-col items-center justify-center p-6 bg-gradient-to-b from-[#2a0404] to-[#0d0202]">
            <div class="tomato-card p-8 rounded-3xl w-full text-center space-y-5">
              <div class="text-6xl">ðŸ¤‘</div>
              <div>
                <h1 class="text-3xl font-black gold-text tracking-wider">Skilled Old Hand</h1>
                <p class="text-xs font-semibold text-amber-200/70 mt-1">\${isSignUp ? 'Create New Account' : 'Shree Ganesh Karte Hai'}</p>
              </div>

              <div class="flex bg-black/50 p-1 rounded-xl border border-amber-500/30">
                <button onclick="state.authMode='login'; render();" class="w-1/2 py-2 rounded-lg text-xs font-bold \${!isSignUp ? 'gold-gradient text-black' : 'text-amber-300/60'}\">LOGIN</button>
                <button onclick="state.authMode='signup'; render();" class="w-1/2 py-2 rounded-lg text-xs font-bold \${isSignUp ? 'gold-gradient text-black' : 'text-amber-300/60'}\">CREATE ACCOUNT</button>
              </div>

              <div class="space-y-3">
                <input id="u" oninput="checkLoginInputsDirectly()" type="text" placeholder="Username" class="w-full p-4 rounded-2xl bg-black/60 border border-amber-500/40 text-white placeholder-amber-200/40 text-sm outline-none">
                <input id="p" oninput="checkLoginInputsDirectly()" type="password" placeholder="Password" class="w-full p-4 rounded-2xl bg-black/60 border border-amber-500/40 text-white placeholder-amber-200/40 text-sm outline-none">
              </div>
              <button id="lbtn" onclick="handleAuth()" class="hidden w-full gold-gradient text-black font-black py-4 rounded-2xl shadow-xl text-lg">
                \${isSignUp ? 'REGISTER NOW ðŸš€' : 'Paisa hi Paisa Hoga ðŸ’°'}
              </button>
            </div>
          </div>
        \`;
      }

      else if (state.currentView === 'lobby') {
        html = \`
          <div class="h-full w-full flex flex-col bg-[#120303]">
            <div class="h-16 px-4 bg-gradient-to-r from-red-950 via-black to-red-950 border-b border-amber-500/40 flex items-center justify-between shadow-lg shrink-0">
              <span class="font-black text-lg gold-text">Skilled Old Hand ðŸ¤‘</span>
              <div class="flex items-center gap-2">
                <div class="bg-black/60 px-3 py-1.5 rounded-full border border-amber-500/40">
                  <span class="text-xs text-amber-300 font-bold">â‚¹</span>
                  <span class="text-sm font-mono font-bold text-green-400">\${state.user.balance.toFixed(2)}</span>
                </div>
                <button onclick="switchView('pwchange')" class="px-2.5 py-1 bg-amber-600/30 border border-amber-500/50 rounded-lg text-[10px] font-bold text-amber-300">Password</button>
                <button onclick="switchView('login')" class="px-2.5 py-1 bg-red-900/50 border border-red-500/50 rounded-lg text-[10px] font-bold text-red-300">Logout</button>
              </div>
            </div>

            <!-- WALLET ACTIONS BAR -->
            <div class="p-3 bg-black/40 border-b border-amber-500/20 flex gap-3 shrink-0">
              <button onclick="switchView('deposit')" class="w-1/2 py-2.5 bg-emerald-700/80 border border-emerald-400/60 rounded-xl font-bold text-white text-xs flex items-center justify-center gap-2 active:scale-95">
                <span>âž• DEPOSIT</span>
              </button>
              <button onclick="switchView('withdraw')" class="w-1/2 py-2.5 bg-amber-700/80 border border-amber-400/60 rounded-xl font-bold text-white text-xs flex items-center justify-center gap-2 active:scale-95">
                <span>ðŸ’¸ WITHDRAW</span>
              </button>
            </div>

            <div class="flex-1 p-4 grid grid-cols-2 gap-4 overflow-y-auto">
              \${[
                { id: 'careerboot', name: 'CareerBoot', icon: 'ðŸŽ“', desc: 'Wheel & MCQ Rounds' },
                { id: 'aviator', name: 'Aviator', icon: 'ðŸš€', desc: 'Realtime Multiplier' },
                { id: 'guesscorrect', name: 'Guess Correct', icon: 'ðŸŽ²', desc: 'Big vs Small Dice' },
                { id: 'prediction', name: 'Prediction', icon: 'ðŸ“ˆ', desc: 'Live Market Line' }
              ].map(g => \`
                <button onclick="switchView('\${g.id}')" class="tomato-card p-4 rounded-3xl flex flex-col items-center justify-center text-center space-y-2 active:scale-95 transition-all">
                  <span class="text-4xl">\${g.icon}</span>
                  <div>
                    <div class="font-black text-amber-300 text-sm">\${g.name}</div>
                    <div class="text-[10px] text-amber-100/60">\${g.desc}</div>
                  </div>
                </button>
              \`).join('')}
            </div>
          </div>
        \`;
      }

      else if (state.currentView === 'deposit') {
        html = \`
          <div class="h-full w-full flex flex-col bg-[#120303] p-6 justify-center">
            <div class="tomato-card p-6 rounded-3xl space-y-4">
              <div class="flex justify-between items-center border-b border-amber-500/40 pb-2">
                <h2 class="text-xl font-black text-amber-300">Deposit Money</h2>
                <button onclick="switchView('lobby')" class="text-xs font-bold text-amber-200">Back</button>
              </div>
              <div class="bg-black/60 p-4 rounded-2xl border border-amber-500/30 text-center space-y-1">
                <span class="text-xs text-amber-200/70">Pay via UPI to Official ID:</span>
                <div class="text-lg font-mono font-black text-amber-300 select-all">kismat420@airtel</div>
              </div>
              <input id="depAmt" type="number" placeholder="Enter Amount (â‚¹)" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
              <input id="depTxn" type="text" placeholder="Transaction Reference / UTR ID" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
              <button onclick="submitDeposit()" class="w-full gold-gradient text-black font-black py-3 rounded-xl text-sm">Submit Deposit</button>
            </div>
          </div>
        \`;
      }

      else if (state.currentView === 'withdraw') {
        html = \`
          <div class="h-full w-full flex flex-col bg-[#120303] p-6 justify-center">
            <div class="tomato-card p-6 rounded-3xl space-y-4">
              <div class="flex justify-between items-center border-b border-amber-500/40 pb-2">
                <h2 class="text-xl font-black text-amber-300">Withdraw Funds</h2>
                <button onclick="switchView('lobby')" class="text-xs font-bold text-amber-200">Back</button>
              </div>
              <div class="text-xs text-amber-200/80">Available Balance: <span class="font-mono text-green-400 font-bold">â‚¹\${state.user.balance.toFixed(2)}</span></div>
              <input id="wdAmt" type="number" placeholder="Enter Amount (â‚¹)" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
              <input id="wdUpi" type="text" placeholder="Your Receiving UPI ID" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
              <button onclick="submitWithdrawal()" class="w-full bg-amber-600 border border-amber-400 text-black font-black py-3 rounded-xl text-sm">Request Withdrawal</button>
            </div>
          </div>
        \`;
      }

      else if (state.currentView === 'careerboot') {
        const cb = state.careerboot;
        if (cb.stage === 'WHEEL') {
          html = \`
            <div class="h-full w-full flex flex-col bg-[#120303]">
              <div class="h-14 px-3 bg-red-950 border-b border-amber-500/40 flex items-center justify-between">
                <button onclick="switchView('lobby')" class="px-3 py-1 bg-red-900 border border-amber-500/40 rounded-xl text-xs font-bold text-white">Lobby</button>
                <span class="font-black gold-text">CAREERBOOT WHEEL</span>
                <span class="font-mono text-sm text-green-400 font-bold">â‚¹\${state.user.balance.toFixed(2)}</span>
              </div>
              <div class="flex-1 flex flex-col items-center justify-center p-4 space-y-4">
                <div class="relative w-72 h-72 flex items-center justify-center">
                  <canvas id="cb-wheel-canvas" class="w-full h-full"></canvas>
                </div>
                \${renderBetControllerUI()}
                <button onclick="spinCareerBootWheel()" \${cb.spinning ? 'disabled' : ''} class="w-full max-w-xs h-14 rounded-2xl font-black text-xl tracking-wider gold-gradient text-black shadow-xl active:scale-95 transition-all">
                  \${cb.spinning ? 'SPINNING...' : 'SPIN THE WHEEL ðŸŽ¡'}
                </button>
              </div>
            </div>
          \`;
        } else if (cb.stage === 'LESSON') {
          const sliceData = CAREERBOOT_DATA[cb.selectedSlice];
          html = \`
            <div class="h-full w-full flex flex-col bg-[#120303] animate-expand">
              <div class="h-14 px-3 bg-red-950 border-b border-amber-500/40 flex items-center justify-between shrink-0">
                <button onclick="state.careerboot.stage='WHEEL'; render();" class="px-3 py-1 bg-red-900 border border-amber-500/40 rounded-xl text-xs font-bold text-white">Wheel</button>
                <span class="font-black gold-text uppercase">\${cb.selectedSlice} MASTER CLASS</span>
                <span class="font-mono text-sm text-green-400 font-bold">â‚¹\${state.user.balance.toFixed(2)}</span>
              </div>
              <div class="flex-1 p-5 overflow-y-auto space-y-4">
                <div class="tomato-card p-6 rounded-3xl space-y-3">
                  <div class="flex items-center gap-2">
                    <span class="text-2xl">ðŸ“–</span>
                    <h2 class="text-xl font-black text-amber-300 uppercase">\${cb.selectedSlice} Deep Detailed Chapter</h2>
                  </div>
                  \${sliceData.lesson}
                </div>
              </div>
              <div class="p-4 bg-red-950 border-t border-amber-500/40 shrink-0 flex justify-center">
                <button onclick="startCareerBootMCQs()" class="w-full max-w-xs h-14 rounded-2xl font-black text-lg gold-gradient text-black shadow-xl active:scale-95">
                  START MCQ QUIZ ðŸš€
                </button>
              </div>
            </div>
          \`;
        } else if (cb.stage === 'MCQ') {
          const qIdx = (cb.round - 1) * 5 + cb.questionIndex;
          const qObj = cb.activeQuestions[qIdx];
          const roundMultText = cb.round === 1 ? '+1.40x' : (cb.round === 2 ? '+1.60x' : '+2.00x');

          html = \`
            <div class="h-full w-full flex flex-col bg-[#120303]">
              <div class="h-14 px-3 bg-red-950 border-b border-amber-500/40 flex items-center justify-between shrink-0">
                <span class="text-xs font-bold text-amber-300">ROUND \${cb.round}/3</span>
                <span class="font-black gold-text uppercase">\${cb.selectedSlice}</span>
                <span class="text-xs font-mono font-bold text-green-400">MULT: \${roundMultText}</span>
              </div>
              <div class="p-3 bg-black/40 border-b border-amber-500/20 flex justify-between items-center shrink-0">
                <span class="text-xs text-amber-200/70 font-semibold">Question \${cb.questionIndex + 1} of 5 (Total 15)</span>
                <span class="text-xs font-mono text-amber-300 font-bold">ACCUMULATED: \${cb.accumulatedMultiplier.toFixed(2)}x</span>
              </div>
              <div class="flex-1 p-5 flex flex-col justify-between overflow-y-auto">
                <div class="tomato-card p-6 rounded-3xl space-y-4">
                  <h3 class="text-base font-bold text-amber-300 leading-snug">\${qObj.q}</h3>
                </div>
                <div class="space-y-3 my-4">
                  \${qObj.opts.map((opt, idx) => {
                    let btnStyle = 'bg-black/70 border-amber-500/40 text-white';

                    if (cb.isAnswered) {
                      if (idx === qObj.a) {
                        btnStyle = 'bg-emerald-600 border-emerald-400 text-white font-bold ring-2 ring-emerald-300';
                      } else if (idx === cb.selectedAnswer && cb.selectedAnswer !== qObj.a) {
                        btnStyle = 'bg-red-600 border-red-400 text-white font-bold';
                      }
                    }

                    return \`
                      <button onclick="handleCareerBootAnswer(\${idx})" \${cb.isAnswered ? 'disabled' : ''} class="w-full p-4 rounded-2xl border text-left text-sm font-semibold transition-all shadow-md \${btnStyle}">
                        <span class="text-amber-300 font-black mr-2">\${['A','B','C','D'][idx]}.</span> \${opt}
                      </button>
                    \`;
                  }).join('')}
                </div>
              </div>
            </div>
          \`;
        }
      }

      else if (state.currentView === 'pwchange') {
        html = \`
          <div class="h-full w-full flex flex-col bg-[#120303] p-6 justify-center">
            <div class="tomato-card p-6 rounded-3xl space-y-4">
              <h2 class="text-xl font-black text-amber-300 text-center">Change Password</h2>
              <input id="opw" type="password" placeholder="Old Password" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
              <input id="npw" type="password" placeholder="New Password" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
              <div class="flex gap-2">
                <button onclick="switchView('lobby')" class="w-1/2 bg-gray-800 text-gray-300 font-bold py-3 rounded-xl text-sm">Cancel</button>
                <button onclick="changePassword()" class="w-1/2 gold-gradient text-black font-black py-3 rounded-xl text-sm">Update</button>
              </div>
            </div>
          </div>
        \`;
      }

      else if (state.currentView === 'aviator') {
        html = \`
          <div class="h-full w-full flex flex-col bg-[#0b0e14]">
            <div class="h-14 px-3 bg-[#141822] border-b border-gray-800 flex items-center justify-between shrink-0">
              <button onclick="switchView('lobby')" class="px-3 py-1 bg-red-900/80 border border-red-500/50 rounded-xl text-xs font-bold text-white">Lobby</button>
              <span class="font-black text-amber-400 text-sm tracking-wider">AVIATOR 24x7</span>
              <span class="font-mono text-sm text-green-400 font-bold">â‚¹\${state.user.balance.toFixed(2)}</span>
            </div>
            <div class="h-10 px-2 bg-black/60 border-b border-gray-800/80 flex items-center gap-1.5 overflow-x-auto shrink-0 no-scrollbar">
              \${state.aviator.history.slice(0, 20).map(h => \`<span class="px-2.5 py-0.5 text-[11px] font-mono font-bold rounded-full bg-gray-800 text-purple-300 border border-purple-500/30 shrink-0">\${h}x</span>\`).join('')}
            </div>
            <div class="flex-1 relative bg-gradient-to-b from-[#0b0e14] to-[#161c27] flex items-center justify-center overflow-hidden">
              <canvas id="aviator-canvas" class="absolute inset-0 w-full h-full"></canvas>
              <div class="relative z-10 flex flex-col items-center text-center space-y-2 pointer-events-none">
                <div id="aviator-x" class="text-5xl font-black font-mono gold-text">\${state.aviator.currentX.toFixed(2)}x</div>
                <div id="aviator-status" class="text-xs font-bold px-3 py-1 rounded-full bg-amber-900/80 text-amber-300 border border-amber-500">CONNECTING...</div>
              </div>
            </div>
            <div class="p-4 bg-[#141822] border-t border-gray-800 shrink-0 space-y-3 flex flex-col items-center">
              \${renderBetControllerUI()}
              <button id="aviator-btn" onclick="handleAviatorAction()" class="w-full max-w-xs h-14 rounded-2xl font-black text-xl tracking-wider bg-red-600 text-white shadow-lg">
                BET â‚¹\${state.userBet}
              </button>
            </div>
          </div>
        \`;
      }

      else if (state.currentView === 'guesscorrect') {
        const diceDots = {
          1: ['bg-red-500 flex items-center justify-center col-span-3 row-span-3 justify-self-center self-center'],
          2: ['col-start-1 row-start-1 bg-white', 'col-start-3 row-start-3 bg-white'],
          3: ['col-start-1 row-start-1 bg-white', 'col-start-2 row-start-2 bg-white', 'col-start-3 row-start-3 bg-white'],
          4: ['col-start-1 row-start-1 bg-white', 'col-start-3 row-start-1 bg-white', 'col-start-1 row-start-3 bg-white', 'col-start-3 row-start-3 bg-white'],
          5: ['col-start-1 row-start-1 bg-white', 'col-start-3 row-start-1 bg-white', 'col-start-2 row-start-2 bg-white', 'col-start-1 row-start-3 bg-white', 'col-start-3 row-start-3 bg-white'],
          6: ['col-start-1 row-start-1 bg-white', 'col-start-3 row-start-1 bg-white', 'col-start-1 row-start-2 bg-white', 'col-start-3 row-start-2 bg-white', 'col-start-1 row-start-3 bg-white', 'col-start-3 row-start-3 bg-white']
        };

        const renderDice = (val) => \`
          <div class="w-20 h-20 bg-gradient-to-br from-red-600 to-red-950 border-2 border-amber-400 rounded-2xl shadow-xl grid grid-cols-3 grid-rows-3 p-3 gap-1">
            \${(diceDots[val] || []).map(cls => \`<div class="w-3.5 h-3.5 rounded-full shadow-inner \${cls}"></div>\`).join('')}
          </div>
        \`;

        html = \`
          <div class="h-full w-full flex flex-col bg-[#120303]">
            <div class="h-14 px-3 bg-red-950 border-b border-amber-500/40 flex items-center justify-between">
              <button onclick="switchView('lobby')" class="px-3 py-1 bg-red-900 border border-amber-500/40 rounded-xl text-xs font-bold text-white">Lobby</button>
              <span class="font-black gold-text">GUESS CORRECT</span>
              <span class="font-mono text-sm text-green-400 font-bold">â‚¹\${state.user.balance.toFixed(2)}</span>
            </div>
            <div class="flex-1 flex flex-col items-center justify-center p-6 space-y-6">
              <div class="tomato-card p-6 rounded-3xl w-full max-w-xs text-center space-y-3">
                <div class="flex justify-center gap-6">
                  \${renderDice(state.diceResults[0])}
                  \${renderDice(state.diceResults[1])}
                </div>
                <p class="text-xs text-amber-200/70 font-bold">Predict Dice Total Sum</p>
              </div>
              \${renderBetControllerUI()}
              <div class="grid grid-cols-2 gap-4 w-full max-w-xs">
                <button onclick="playDiceGame('small')" class="tomato-card h-16 rounded-2xl flex flex-col items-center justify-center space-y-0.5 active:scale-95">
                  <span class="font-black text-lg text-amber-300">SMALL</span>
                  <span class="text-[10px] text-amber-100/60">Sum 2 to 6</span>
                </button>
                <button onclick="playDiceGame('big')" class="tomato-card h-16 rounded-2xl flex flex-col items-center justify-center space-y-0.5 active:scale-95">
                  <span class="font-black text-lg text-amber-300">BIG</span>
                  <span class="text-[10px] text-amber-100/60">Sum 7 to 12</span>
                </button>
              </div>
            </div>
          </div>
        \`;
      }

      else if (state.currentView === 'prediction') {
        html = \`
          <div class="h-full w-full flex flex-col bg-[#0b0404]">
            <div class="h-14 px-3 bg-red-950 border-b border-amber-500/40 flex items-center justify-between">
              <button onclick="switchView('lobby')" class="px-3 py-1 bg-red-900/80 border border-amber-500/40 rounded-xl text-xs font-bold text-white">Lobby</button>
              <span class="font-black gold-text tracking-wider">PREDICTION PRO</span>
              <span class="font-mono text-sm text-green-400 font-bold">â‚¹\${state.user.balance.toFixed(2)}</span>
            </div>
            <div class="flex-1 flex flex-col items-center justify-between p-3 space-y-3">
              <div class="w-full flex-1 bg-gradient-to-b from-[#090d16] to-[#04060a] border-2 border-emerald-500/30 rounded-3xl relative overflow-hidden flex flex-col p-2 min-h-[280px] shadow-[0_0_20px_rgba(16,185,129,0.15)]">
                <canvas id="market-canvas" class="absolute inset-0 w-full h-full"></canvas>
                <div class="relative z-10 flex justify-between items-center p-2 pointer-events-none">
                  <div class="flex items-center gap-2 bg-black/80 backdrop-blur-md px-3 py-1.5 rounded-2xl border border-emerald-500/40 shadow-lg">
                    <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping"></span>
                    <span class="text-xs font-bold text-emerald-400 uppercase tracking-widest">LIVE</span>
                    <span class="text-sm font-mono font-black text-white ml-1">â‚¹\${state.marketHistory[state.marketHistory.length - 1]}</span>
                  </div>
                  \${state.predictionTimer > 0 ? \`
                    <div class="text-xs font-mono font-black text-amber-300 bg-amber-950/90 backdrop-blur-md px-3 py-1.5 rounded-2xl border border-amber-500/60 animate-pulse shadow-lg">
                      LOCKING IN \${state.predictionTimer}s
                    </div>
                  \` : ''}
                </div>
              </div>
              \${renderBetControllerUI()}
              <div class="grid grid-cols-2 gap-4 w-full max-w-xs shrink-0">
                <button onclick="playPrediction('up')" class="bg-gradient-to-b from-emerald-500 to-emerald-700 border-2 border-emerald-400 h-14 rounded-2xl font-black text-lg active:scale-95 text-white shadow-[0_0_15px_rgba(16,185,129,0.4)] flex items-center justify-center gap-2">
                  <span>UP</span>
                  <span class="text-xl">ðŸ“ˆ</span>
                </button>
                <button onclick="playPrediction('down')" class="bg-gradient-to-b from-red-600 to-red-800 border-2 border-red-400 h-14 rounded-2xl font-black text-lg active:scale-95 text-white shadow-[0_0_15px_rgba(239,68,68,0.4)] flex items-center justify-center gap-2">
                  <span>DOWN</span>
                  <span class="text-xl">ðŸ“‰</span>
                </button>
              </div>
            </div>
          </div>
        \`;
      }

      else if (state.currentView === 'admin') {
        html = \`
          <div class="h-full w-full flex flex-col bg-[#0b0202] p-4 overflow-hidden">
            <div class="flex justify-between items-center border-b border-amber-500/40 pb-3 shrink-0">
              <h1 class="text-lg font-black gold-text">Admin Panel (Boss)</h1>
              <div class="flex gap-2">
                <button onclick="switchView('pwchange')" class="bg-amber-800 border border-amber-500 px-2 py-1 rounded-xl text-xs font-bold text-white">Password</button>
                <button onclick="switchView('login')" class="bg-red-900 border border-red-500 px-2 py-1 rounded-xl text-xs font-bold text-white">Logout</button>
              </div>
            </div>

            <div class="flex gap-1 my-3 shrink-0">
              <button onclick="state.adminSubTab='users'; render();" class="w-1/3 py-2 rounded-xl font-bold text-[10px] \${state.adminSubTab==='users' ? 'gold-gradient text-black' : 'bg-gray-800 text-gray-400'}">Users</button>
              <button onclick="state.adminSubTab='txns'; render();" class="w-1/3 py-2 rounded-xl font-bold text-[10px] \${state.adminSubTab==='txns' ? 'gold-gradient text-black' : 'bg-gray-800 text-gray-400'}">Requests</button>
              <button onclick="state.adminSubTab='create'; render();" class="w-1/3 py-2 rounded-xl font-bold text-[10px] \${state.adminSubTab==='create' ? 'gold-gradient text-black' : 'bg-gray-800 text-gray-400'}">Create User</button>
            </div>

            <div class="flex-1 overflow-y-auto space-y-4">
              \${state.adminSubTab === 'create' ? \`
                <div class="tomato-card p-4 rounded-2xl space-y-3">
                  <h3 class="font-bold text-sm text-amber-300">Create Player Account</h3>
                  <input id="nu" placeholder="New Username" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
                  <input id="np" placeholder="New Password" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
                  <button onclick="createPlayer()" class="w-full gold-gradient text-black font-black py-3 rounded-xl text-sm">Create Account</button>
                </div>
              \` : state.adminSubTab === 'txns' ? \`
                <div class="space-y-2">
                  <h3 class="font-bold text-xs text-amber-300/80">DEPOSIT & WITHDRAWAL REQUESTS</h3>
                  \${state.adminTxns.map(t => \`
                    <div class="bg-black/60 p-3 rounded-xl border border-amber-500/30 text-xs space-y-2">
                      <div class="flex justify-between font-bold">
                        <span class="text-amber-300 uppercase">\${t.type} - â‚¹\${t.amount}</span>
                        <span class="\${t.status==='approved'?'text-green-400':t.status==='rejected'?'text-red-400':'text-amber-400'} font-bold uppercase">\${t.status}</span>
                      </div>
                      <div class="text-[11px] text-gray-300">User: <span class="text-white font-bold">\${t.username}</span></div>
                      \${t.type === 'deposit' ? \`<div class="text-[10px] font-mono text-gray-400">Txn/UTR ID: \${t.txnId}</div>\` : \`<div class="text-[10px] font-mono text-gray-400">UPI ID: \${t.upiId}</div>\`}
                      \${t.status === 'pending' ? \`
                        <div class="flex gap-2 pt-1">
                          <button onclick="processTxn('\${t._id}', 'approve')" class="w-1/2 py-1.5 bg-emerald-600 rounded-lg text-white font-bold">Approve</button>
                          <button onclick="processTxn('\${t._id}', 'reject')" class="w-1/2 py-1.5 bg-red-600 rounded-lg text-white font-bold">Reject</button>
                        </div>
                      \` : ''}
                    </div>
                  \`).join('')}
                </div>
              \` : \`
                <div class="tomato-card p-4 rounded-2xl space-y-3">
                  <h3 class="font-bold text-sm text-amber-300">Modify User Balance</h3>
                  <input id="bu" placeholder="Player Username" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
                  <input id="ba" type="number" placeholder="Amount (+1000 or -500)" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
                  <button onclick="modifyBalance()" class="w-full bg-emerald-600 text-white font-black py-3 rounded-xl text-sm">Update Balance</button>
                </div>

                <div class="space-y-2">
                  <h3 class="font-bold text-xs text-amber-300/80">ALL REGISTERED PLAYERS STATISTICS</h3>
                  \${state.adminUsers.map(u => \`
                    <div class="bg-black/60 p-3 rounded-xl border border-amber-500/30 text-xs space-y-1">
                      <div class="flex justify-between font-bold text-amber-300">
                        <span>ðŸ‘¤ \${u.username}</span>
                        <span class="text-green-400 font-mono">â‚¹\${u.balance.toFixed(2)}</span>
                      </div>
                      <div class="grid grid-cols-3 gap-1 text-[10px] text-gray-400 font-mono mt-1">
                        <div>Won: <span class="text-green-400">â‚¹\${u.totalWon}</span></div>
                        <div>Lost: <span class="text-red-400">â‚¹\${u.totalLost}</span></div>
                        <div>Placed: <span class="text-amber-200">â‚¹\${u.totalBetPlaced}</span></div>
                      </div>
                    </div>
                  \`).join('')}
                </div>
              \`}
            </div>
          </div>
        \`;
      }

      app.innerHTML = html + popupHtml + customBetModalHtml;

      if(state.currentView === 'aviator') renderAviatorOverlay();
      if(state.currentView === 'prediction') renderPredictionGraph();
      if(state.currentView === 'careerboot' && state.careerboot.stage === 'WHEEL') renderCareerBootWheelCanvas();
    }

    async function createPlayer() {
      const username = document.getElementById('nu').value;
      const password = document.getElementById('np').value;
      const res = await fetch('/api/admin/create-user', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      if (res.ok) { fetchAdminData(); showPopup('User Created Successfully', 'OK'); }
      else showPopup('Error Creating User', 'try again');
    }

    async function modifyBalance() {
      const username = document.getElementById('bu').value;
      const amount = parseFloat(document.getElementById('ba').value);
      const res = await fetch('/api/admin/update-balance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, amount })
      });
      if (res.ok) { fetchAdminData(); showPopup('Balance Updated!', 'OK'); }
      else showPopup('User Not Found', 'try again');
    }

    render();
  </script>
</body>
</html>
  `);
});

// ==========================================
// SERVER INITIALIZATION ENGINE
// ==========================================
const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGODB_URI;

async function startServer() {
  if (!MONGO_URI) {
    console.error("CRITICAL ERROR: MONGODB_URI environment variable missing!");
    process.exit(1);
  }
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    console.log("MongoDB Connected Successfully");
    
    const boss = await User.findOne({ username: 'Boss' });
    if (!boss) {
      const hashedPassword = await bcrypt.hash('BigBoss', 10);
      await User.create({ username: 'Boss', password: hashedPassword, role: 'admin', balance: 999999 });
      console.log("Default Admin Account Created: Boss / BigBoss");
    }

    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      startAviatorLoop();
    });
  } catch (err) {
    console.error("Database connection error:", err.message);
    process.exit(1);
  }
}

startServer();
