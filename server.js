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
  balance: { type: Number, default: 1000 },
  totalWon: { type: Number, default: 0 },
  totalLost: { type: Number, default: 0 },
  totalBetPlaced: { type: Number, default: 0 },
  seenQuestions: { type: [String], default: [] }
});
const User = mongoose.model('User', userSchema);

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
  const users = await User.find({ role: 'player' });
  res.json(users);
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
    
    // Save only unique asked question IDs using $addToSet
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
  <title>Skilled Old Hand 🤑</title>
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
        if (['lobby', 'login', 'admin', 'pwchange'].includes(state.currentView)) return;
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
        if (['lobby', 'login', 'admin', 'pwchange'].includes(state.currentView)) return;
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
      currentView: 'login',
      adminSubTab: 'users',
      aviator: { status: 'WAITING', currentX: 1.00, history: [] },
      userBet: 100,
      hasBetAviator: false,
      nextRoundBet: false,
      cashedOut: false,
      popup: null,
      adminUsers: [],
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
          { q: "Which phrase contains a dangling modifier?", opts: ["Having finished the report, the computer crashed.", "After completing the audit, she left.", "To succeed, practice daily.", "While reviewing numbers, we saw mistakes."], a: 0 },
          { q: "Identify the correct pronoun: 'Send the final document to Sarah and ___.'", opts: ["I", "me", "myself", "mine"], a: 1 },
          { q: "Choose the correct option: '___ policy has been updated recently.'", opts: ["Its", "It's", "Its'", "It-is"], a: 0 },
          { q: "Select the parallel sentence.", opts: ["He enjoys reading, writing, and to edit.", "He enjoys reading, writing, and editing.", "He enjoys to read, writing, and editing.", "He enjoys reading, write, and edit."], a: 1 },
          { q: "Which sentence uses passive voice?", opts: ["The board approved the plan.", "The manager led the discussion.", "The report was finalized by the team.", "We updated the records."], a: 2 },
          { q: "Fill in the blank: 'If I ___ in your position, I would accept the offer.'", opts: ["was", "were", "am", "be"], a: 1 },
          { q: "Choose the correct word: 'The new regulation will ___ our operations.'", opts: ["effect", "affect", "effected", "affects"], a: 1 },
          { q: "Which option avoids a double comparative?", opts: ["More smarter", "Smarter", "Most smartest", "More easy"], a: 1 },
          { q: "Identify the correct relative pronoun: 'The executive ___ presentation won the bid.'", opts: ["who", "whom", "whose", "which"], a: 2 },
          { q: "Choose the sentence with proper comma usage.", opts: ["Although it rained we went.", "Although it rained, we went.", "Although, it rained we went.", "Although it rained we went,."], a: 1 },
          { q: "Which is a independent clause?", opts: ["Because sales grew", "When the bell rang", "The quarterly revenue increased", "If the market opens"], a: 2 },
          { q: "Select the sentence with correct pronoun reference.", opts: ["Each manager should submit their report.", "Every employee must submit his or her report.", "Employees should submit his report.", "All team members must submit its report."], a: 1 },
          { q: "Choose the sentence without a comma splice.", opts: ["I came, I saw, I conquered.", "The sales rose, the profits fell.", "The report was long, but it was accurate.", "She worked hard, she succeeded."], a: 2 },
          { q: "Which sentence correctly uses 'fewer'?", opts: ["We have fewer time today.", "There are fewer errors in this draft.", "Fewer traffic was on the road.", "He made fewer money."], a: 1 },
          { q: "Choose the correct word: 'The committee has made ___ decision.'", opts: ["their", "its", "it's", "they're"], a: 1 },
          { q: "Identify the sentence with correct apostrophe use.", opts: ["The cat licked it's paw.", "The directors' meeting is at 10 AM.", "The company's are expanding.", "Two box's arrived."], a: 1 },
          { q: "Fill in the blank: 'Between you and ___, the proposal needs work.'", opts: ["I", "me", "myself", "he"], a: 1 },
          { q: "Identify the correctly formed adverb.", opts: ["Quick", "Quickly", "Quicker", "Quickest"], a: 1 },
          { q: "Select the sentence using subjunctive mood correctly.", opts: ["I wish I was taller.", "I wish I were taller.", "I wish I am taller.", "I wish I be taller."], a: 1 },
          { q: "Which word completes: 'Everyone must complete ___ assignment.'", opts: ["their", "his or her", "they're", "our"], a: 1 },
          { q: "Identify the sentence with misplaced modifier.", opts: ["Running fast, the bus was caught by him.", "Running fast, he caught the bus.", "He caught the bus by running fast.", "Fast running, he caught the bus."], a: 0 },
          { q: "Choose the sentence with correct capitalization.", opts: ["the President visited India.", "The President visited India.", "The president visited india.", "the president visited India."], a: 1 },
          { q: "Which sentence uses semi-colon correctly?", opts: ["We had a great quarter; sales went up 20%.", "We had; a great quarter sales went up.", "We had a great quarter sales; went up.", "We had a great quarter,; sales went up."], a: 0 },
          { q: "Select the correct form: 'Neither the CEO nor the directors ___ present.'", opts: ["was", "were", "is", "am"], a: 1 },
          { q: "Choose the correct usage: 'The result had a positive ___.'", opts: ["affect", "effect", "affected", "effects"], a: 1 },
          { q: "Which word correctly completes: 'She is the person ___ I spoke to.'", opts: ["who", "whom", "whose", "which"], a: 1 },
          { q: "Identify the redundant phrase.", opts: ["Past history", "History", "Past records", "Recent events"], a: 0 },
          { q: "Choose the grammatically correct option.", opts: ["She sings good.", "She sings well.", "She sings bestly.", "She sings wellness."], a: 1 },
          { q: "Which sentence is written in active voice?", opts: ["The code was written by Alex.", "Alex wrote the code.", "The code has been edited.", "Errors were found."], a: 1 },
          { q: "Select the correctly formatted list sentence.", opts: ["Bring: pens, paper, and ink.", "Bring pens, paper, and ink.", "Bring pens, paper, and, ink.", "Bring: pens paper and ink."], a: 1 },
          { q: "Choose the correct preposition: 'He is proficient ___ Excel.'", opts: ["at", "in", "with", "on"], a: 1 },
          { q: "Which phrase is grammatically correct?", opts: ["Different than", "Different from", "Different to", "Different with"], a: 1 },
          { q: "Identify the sentence with clear antecedent reference.", opts: ["When John met Mark, he smiled.", "John smiled when he met Mark.", "He met Mark and John smiled.", "When John met Mark he was happy."], a: 1 },
          { q: "Select the correct spelling.", opts: ["Accommodate", "Acommodate", "Accomodate", "Acomodate"], a: 0 },
          { q: "Which word completes: 'He ran ___ than expected.'", opts: ["faster", "more fast", "fastly", "more faster"], a: 0 },
          { q: "Choose the correct expression: 'Irregardless of the outcome...'", opts: ["Irregardless of", "Regardless of", "Disregardless of", "Unregardless of"], a: 1 },
          { q: "Identify the sentence that uses a colon correctly.", opts: ["We need three items: paper, pens, and tape.", "We need: paper, pens, and tape.", "We need paper: pens, and tape.", "We: need paper, pens, and tape."], a: 0 },
          { q: "Which pronoun completes: 'It was ___ who called you.'", opts: ["he", "him", "his", "himself"], a: 0 },
          { q: "Identify the correct usage of 'lay' vs 'lie'.", opts: ["Please lie the books on the table.", "Please lay the books on the table.", "Please laid the books on table.", "Please lain the books."], a: 1 },
          { q: "Select the correct sentence.", opts: ["She works more harder than him.", "She works harder than he does.", "She works harder than him does.", "She work harder than he."], a: 1 },
          { q: "Choose the sentence with correct verb tense.", opts: ["By next year, I will finish the project.", "By next year, I will have finished the project.", "By next year, I finished the project.", "By next year, I am finishing."], a: 1 },
          { q: "Which sentence contains a tautology?", opts: ["He added extra additions.", "He added details.", "He provided info.", "He sent files."], a: 0 },
          { q: "Identify the correct word: 'The company will ___ its new product line.'", opts: ["launch", "lunch", "lauch", "lanch"], a: 0 },
          { q: "Select the sentence that avoids fragment structure.", opts: ["Because he was late.", "Since the meeting ended early.", "The team completed the assignment on time.", "Although they tried."], a: 2 },
          { q: "Choose the correct form: 'The team members argued among ___.'", opts: ["themselves", "theirselves", "themself", "each other"], a: 0 },
          { q: "Which sentence uses quotation marks correctly?", opts: ["'Hello,' said the manager.", "\"Hello,\" said the manager.", "\"Hello\", said the manager.", "'Hello', said manager."], a: 1 },
          { q: "Identify the subject in: 'Under the tree sat the old man.'", opts: ["tree", "sat", "old man", "under"], a: 2 },
          { q: "Choose the correct sentence.", opts: ["Neither John nor his friends are coming.", "Neither John nor his friends is coming.", "Neither John or his friends are coming.", "Neither John nor his friends be coming."], a: 0 },
          { q: "Which word completes: 'The data ___ analyzed yesterday.'", opts: ["was", "were", "is", "are"], a: 0 },
          { q: "Identify the superlative form.", opts: ["Good", "Better", "Best", "Well"], a: 2 },
          { q: "Select the correctly formatted abbreviation.", opts: ["e.g.,", "eg,", "e.g.", "eg."], a: 0 },
          { q: "Choose the sentence with proper hyphenation.", opts: ["A well known author", "A well-known author", "A well-known-author", "A well known-author"], a: 1 },
          { q: "Which word correctly fills: 'She is senior ___ me in rank.'", opts: ["than", "to", "from", "with"], a: 1 },
          { q: "Identify the correct sentence.", opts: ["Scarcely had he arrived when it started raining.", "Scarcely had he arrived than it started raining.", "Scarcely he arrived when it started raining.", "Scarcely did he arrived when it started."], a: 0 },
          { q: "Choose the correct conditional form.", opts: ["If I study, I will pass.", "If I study, I passed.", "If I studied, I will pass.", "If I study, I would pass."], a: 0 },
          { q: "Which phrase is free of errors?", opts: ["One of my friend is", "One of my friends is", "One of my friends are", "One of my friend are"], a: 1 },
          { q: "Identify the past participle of 'write'.", opts: ["Wrote", "Written", "Writing", "Writes"], a: 1 }
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
          { q: "Define 'Feasible'.", opts: ["Impossible to execute", "Possible and practical", "Expensive", "Theoretical only"], a: 1 },
          { q: "What does 'Paradigm' mean?", opts: ["Standard model or pattern", "Temporary error", "Financial loss", "Unexplained delay"], a: 0 },
          { q: "Choose the synonym for 'Benchmark'.", opts: ["Standard of reference", "Random guess", "Bottom line", "Outdated model"], a: 0 },
          { q: "What is the antonym of 'Transparent'?", opts: ["Clear", "Opaque", "Lucid", "Visible"], a: 1 },
          { q: "Define 'Consensus'.", opts: ["Disagreement", "General agreement", "Single vote", "Forced decision"], a: 1 },
          { q: "What does 'Disruptive' mean in business context?", opts: ["Radically altering industry standards", "Maintaining status quo", "Slowing operations", "Reducing workforce"], a: 0 },
          { q: "Choose the definition of 'Scalable'.", opts: ["Capable of expanding without structural failure", "Fixed size", "Decreasing over time", "Complex to operate"], a: 0 },
          { q: "What does 'Leverage' mean strategically?", opts: ["Use resources for maximum advantage", "Give up control", "Borrow without interest", "Discard unused assets"], a: 0 },
          { q: "Define 'Fiduciary'.", opts: ["Relating to legal or financial trust", "Casual agreement", "High risk investment", "Short-term debt"], a: 0 },
          { q: "What is a 'Discrepancy'?", opts: ["An inconsistency in data", "A confirmed agreement", "A financial profit", "A smooth workflow"], a: 0 },
          { q: "Define 'Bottleneck'.", opts: ["Point of congestion or delay", "Smooth execution", "High speed growth", "Maximum yield"], a: 0 },
          { q: "What does 'Pragmatic' mean?", opts: ["Idealistic", "Practical and realistic", "Theoretical", "Emotional"], a: 1 },
          { q: "Choose the synonym for 'Acumen'.", opts: ["Keen insight and sharp judgment", "Ignorance", "Hesitation", "Clumsiness"], a: 0 },
          { q: "What does 'Benevolent' mean?", opts: ["Hostile", "Kind and generous", "Greedy", "Cynical"], a: 1 },
          { q: "Choose the antonym for 'Lucrative'.", opts: ["Profitable", "Unprofitable", "Rewarding", "Gainful"], a: 1 },
          { q: "Define 'Attrition'.", opts: ["Gradual reduction of staff", "Rapid recruitment", "Salary hike", "Promotion"], a: 0 },
          { q: "What does 'Consolidate' mean?", opts: ["Separate into parts", "Combine into a single unified whole", "Liquidate assets", "Cancel agreements"], a: 1 },
          { q: "Choose the synonym for 'Empirical'.", opts: ["Based on observation or experiment", "Theoretical", "Fictional", "Speculative"], a: 0 },
          { q: "What does 'Exemplary' mean?", opts: ["Serving as a desirable model", "Poor quality", "Mediocre", "Flawed"], a: 0 },
          { q: "Define 'Lethargic'.", opts: ["Energetic", "Sluggish and slow", "Alert", "Motivated"], a: 1 },
          { q: "What is the meaning of 'Obsolete'?", opts: ["Modern", "Out of date and no longer useful", "Essential", "Innovative"], a: 1 },
          { q: "Choose the synonym for 'Pivotal'.", opts: ["Crucial / Central", "Minor", "Irrelevant", "Secondary"], a: 0 },
          { q: "Define 'Resilience'.", opts: ["Inability to recover", "Capacity to recover quickly from difficulty", "Rigidity", "Fragility"], a: 1 },
          { q: "What does 'Scrutinize' mean?", opts: ["Examine closely and critically", "Ignore completely", "Skim through", "Approve blindly"], a: 0 },
          { q: "Choose the antonym of 'Ambigous'.", opts: ["Unclear", "Vague", "Explicit", "Doubtful"], a: 2 },
          { q: "What does 'Ubiquitous' mean?", opts: ["Rare", "Present everywhere", "Unique", "Hidden"], a: 1 },
          { q: "Define 'Volatile'.", opts: ["Stable", "Liable to change rapidly and unpredictably", "Calm", "Constant"], a: 1 },
          { q: "Choose the synonym for 'Alacrity'.", opts: ["Reluctance", "Brisk and cheerful readiness", "Apathy", "Sorrow"], a: 1 },
          { q: "What does 'Coercion' mean?", opts: ["Persuasion by force or threat", "Free choice", "Voluntary agreement", "Mutual respect"], a: 0 },
          { q: "Define 'Deterrent'.", opts: ["Encouragement", "Thing that discourages an action", "Incentive", "Catalyst"], a: 1 },
          { q: "Choose the meaning of 'Exacerbate'.", opts: ["Make something better", "Make a problem worse", "Solve an issue", "Calm down"], a: 1 },
          { q: "What does 'Fastidious' mean?", opts: ["Careless", "Very attentive to detail and accuracy", "Easygoing", "Sloppy"], a: 1 },
          { q: "Choose the synonym for 'Gregarious'.", opts: ["Sociable", "Reserved", "Introverted", "Solitary"], a: 0 },
          { q: "Define 'Impediment'.", opts: ["Hinderance or obstacle", "Assistance", "Advantage", "Support"], a: 0 },
          { q: "What does 'Meticulous' mean?", opts: ["Sloppy", "Showing great attention to detail", "Hasty", "Careless"], a: 1 },
          { q: "Choose the antonym of 'Optimistic'.", opts: ["Positive", "Pessimistic", "Hopeful", "Confident"], a: 1 },
          { q: "What does 'Prevalent' mean?", opts: ["Widespread in a particular area", "Rare", "Unknown", "Isolated"], a: 0 },
          { q: "Define 'Redundant'.", opts: ["Necessary", "Not or no longer needed or useful", "Essential", "Crucial"], a: 1 },
          { q: "Choose the synonym for 'Substantial'.", opts: ["Minor", "Considerable in importance or amount", "Small", "Insignificant"], a: 1 },
          { q: "What does 'Tenacious' mean?", opts: ["Giving up easily", "Persistent and determined", "Weak", "Hesitant"], a: 1 },
          { q: "Define 'Unprecedented'.", opts: ["Never done or known before", "Common", "Standard", "Routine"], a: 0 },
          { q: "Choose the meaning of 'Vindicate'.", opts: ["Clear someone of blame", "Accuse", "Convict", "Punish"], a: 0 },
          { q: "What does 'Adversity' mean?", opts: ["Good fortune", "Difficulties or hardship", "Success", "Comfort"], a: 1 },
          { q: "Choose the synonym for 'Brevity'.", opts: ["Conciseness in word choice", "Lengthiness", "Verbosity", "Expansion"], a: 0 },
          { q: "Define 'Candid'.", opts: ["Deceitful", "Truthful and straightforward", "Secretive", "Shy"], a: 1 },
          { q: "What does 'Diligent' mean?", opts: ["Lazy", "Showing care and effort in work", "Careless", "Unmotivated"], a: 1 },
          { q: "Choose the antonym of 'Ephemeral'.", opts: ["Short-lived", "Permanent", "Transient", "Brief"], a: 1 },
          { q: "What does 'Frugal' mean?", opts: ["Extravagant", "Economical and sparing with money", "Wasteful", "Generous"], a: 1 },
          { q: "Define 'Guile'.", opts: ["Sincerity", "Sly or cunning intelligence", "Honesty", "Innocence"], a: 1 },
          { q: "Choose the synonym for 'Hypothetical'.", opts: ["Proven", "Supposed or theoretical", "Factual", "Real"], a: 1 },
          { q: "What does 'Inadvertent' mean?", opts: ["Intentional", "Unintentional or accidental", "Planned", "Deliberate"], a: 1 },
          { q: "Define 'Juxtapose'.", opts: ["Place close together for comparison", "Separate far apart", "Hide away", "Discard"], a: 0 },
          { q: "Choose the meaning of 'Kudos'.", opts: ["Praise and honor received for achievement", "Criticism", "Blame", "Penalty"], a: 0 },
          { q: "What does 'Lucid' mean?", opts: ["Confused", "Expressed clearly and easy to understand", "Dark", "Vague"], a: 1 },
          { q: "Define 'Nefarious'.", opts: ["Wicked or criminal", "Noble", "Virtuous", "Honorable"], a: 0 },
          { q: "Choose the synonym for 'Ostracize'.", opts: ["Exclude from a group", "Welcome warmly", "Include", "Invite"], a: 0 },
          { q: "What does 'Prudent' mean?", opts: ["Reckless", "Acting with or showing care for the future", "Foolish", "Rash"], a: 1 }
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
          { q: "What does #N/A mean in Excel?", opts: ["Value not available", "Number overflow", "Column width small", "Division by zero"], a: 0 },
          { q: "Which function converts lowercase text to all capital letters?", opts: ["LOWER", "UPPER", "PROPER", "CAPITAL"], a: 1 },
          { q: "What is the shortcut to select an entire column in Excel?", opts: ["CTRL + SPACE", "SHIFT + SPACE", "CTRL + A", "ALT + SPACE"], a: 0 },
          { q: "Which Excel function counts non-empty cells in a range?", opts: ["COUNT", "COUNTA", "COUNTBLANK", "COUNTIF"], a: 1 },
          { q: "What error appears when Excel does not recognize text in a formula?", opts: ["#VALUE!", "#NAME?", "#REF!", "#NULL!"], a: 1 },
          { q: "Which function joins multiple strings together into one string?", opts: ["TEXTJOIN", "SPLIT", "SEPARATE", "CUT"], a: 0 },
          { q: "What key is pressed to edit the active cell in Excel?", opts: ["F1", "F2", "F4", "F7"], a: 1 },
          { q: "Which function calculates the statistical middle value of a dataset?", opts: ["AVERAGE", "MEDIAN", "MODE", "SUM"], a: 1 },
          { q: "What shortcut inserts the current date into a cell?", opts: ["CTRL + ;", "CTRL + SHIFT + ;", "ALT + D", "CTRL + D"], a: 0 },
          { q: "Which chart type is best for displaying trends over time?", opts: ["Pie Chart", "Line Chart", "Donut Chart", "Scatter Plot"], a: 1 },
          { q: "What does the TRIM function do in Excel?", opts: ["Removes all spaces", "Removes leading/trailing spaces", "Truncates numbers", "Shortens formulas"], a: 1 },
          { q: "Which function returns the current date and time?", opts: ["TODAY()", "NOW()", "DATE()", "TIME()"], a: 1 },
          { q: "What does #REF! error indicate in Excel?", opts: ["Invalid cell reference", "Value missing", "Formula syntax error", "Division by zero"], a: 0 },
          { q: "Which feature restricts the type of data user can enter into a cell?", opts: ["Conditional Formatting", "Data Validation", "Protect Sheet", "Filter"], a: 1 },
          { q: "What shortcut key toggles absolute/relative references in a formula?", opts: ["F2", "F4", "F9", "F12"], a: 1 },
          { q: "Which function returns the remainder after division?", opts: ["MOD", "ROUND", "INT", "DIV"], a: 0 },
          { q: "What is the result of =IF(10>5, 'High', 'Low')?", opts: ["Low", "High", "TRUE", "FALSE"], a: 1 },
          { q: "Which keyboard shortcut selects an entire row in Excel?", opts: ["SHIFT + SPACE", "CTRL + SPACE", "ALT + SPACE", "CTRL + SHIFT + L"], a: 0 },
          { q: "What does #DIV/0! mean?", opts: ["Division by zero", "Formula name error", "Reference lost", "Null intersection"], a: 0 },
          { q: "Which logical function returns TRUE if ALL conditions are true?", opts: ["OR", "AND", "NOT", "XOR"], a: 1 },
          { q: "Which Excel tool allows you to find a specific target result by altering an input value?", opts: ["Goal Seek", "Solver", "Data Table", "PivotTable"], a: 0 },
          { q: "Which function highlights cells based on rules like cell value or duplicate check?", opts: ["Data Validation", "Conditional Formatting", "Format Cells", "Styles"], a: 1 },
          { q: "What function removes all non-printable characters from text?", opts: ["TRIM", "CLEAN", "CLEAR", "ERASE"], a: 1 },
          { q: "What function adds all numbers in a specified range matching multiple criteria?", opts: ["SUMIF", "SUMIFS", "DSUM", "TOTALIF"], a: 1 },
          { q: "Which shortcut key opens the 'Find and Replace' dialog box?", opts: ["CTRL + F", "CTRL + H", "CTRL + R", "CTRL + G"], a: 1 },
          { q: "In Excel, what does the LEN function return?", opts: ["Length of a string", "Line number", "List index", "Logarithm value"], a: 0 },
          { q: "Which lookup function can search both vertically and horizontally?", opts: ["VLOOKUP", "HLOOKUP", "XLOOKUP", "LOOKUP"], a: 2 },
          { q: "What key combination opens the Format Cells dialog?", opts: ["CTRL + 1", "ALT + 1", "SHIFT + 1", "CTRL + F1"], a: 0 },
          { q: "Which function capitalizes the first letter of each word in a string?", opts: ["UPPER", "PROPER", "LOWER", "CAPITALIZE"], a: 1 },
          { q: "What keyboard shortcut copies content from the cell directly above?", opts: ["CTRL + D", "CTRL + R", "CTRL + U", "CTRL + J"], a: 0 },
          { q: "What shortcut applies or removes AutoFilter to a data range?", opts: ["CTRL + SHIFT + L", "ALT + F", "CTRL + F", "SHIFT + F3"], a: 0 },
          { q: "Which function extracts a specific number of characters from the left side of text?", opts: ["LEFT", "MID", "RIGHT", "SUBSTRING"], a: 0 },
          { q: "What does the ISERROR function return if a cell contains an error?", opts: ["TRUE", "FALSE", "1", "#ERR"], a: 0 },
          { q: "Which tab in Excel contains the PivotTable command?", opts: ["Home", "Insert", "Data", "Page Layout"], a: 1 },
          { q: "What function is used to convert text representing a number into a number?", opts: ["VALUE", "NUMBER", "TEXT", "N"], a: 0 },
          { q: "Which shortcut inserts a new worksheet into current workbook?", opts: ["SHIFT + F11", "ALT + F11", "CTRL + N", "CTRL + W"], a: 0 },
          { q: "What function rounds a number to a specified number of digits?", opts: ["ROUND", "TRUNC", "INT", "CEILING"], a: 0 },
          { q: "Which wildcard character represents any single character in Excel lookups?", opts: ["*", "?", "#", "~"], a: 1 },
          { q: "Which function returns the row number of a cell reference?", opts: ["ROW", "ROWS", "COLUMN", "COLUMNS"], a: 0 },
          { q: "What does Flash Fill do in Excel?", opts: ["Fills cells automatically based on identified patterns", "Fills background color", "Highlights errors", "Calculates formulas"], a: 0 },
          { q: "Which key combination creates an instant column chart from selected data?", opts: ["ALT + F1", "F11", "CTRL + F1", "SHIFT + F1"], a: 0 },
          { q: "What does the CONCAT function do?", opts: ["Combines text from multiple ranges/strings", "Divides text", "Calculates percentages", "Converts values"], a: 0 },
          { q: "Which function calculates compound interest rate?", opts: ["PMT", "RATE", "FV", "NPER"], a: 1 },
          { q: "What does the IFERROR function do?", opts: ["Returns custom value if formula evaluates to error", "Deletes error cells", "Displays error dialog", "Stops calculation"], a: 0 },
          { q: "Which function finds the position of a substring inside text (case-sensitive)?", opts: ["SEARCH", "FIND", "MATCH", "LOCATE"], a: 1 },
          { q: "What formula returns only the current date without time?", opts: ["TODAY()", "NOW()", "DATE()", "CURDATE()"], a: 0 },
          { q: "Which chart is best for showing proportions of a whole?", opts: ["Pie Chart", "Line Chart", "Bar Chart", "Area Chart"], a: 0 },
          { q: "What shortcut pastes values only in Excel?", opts: ["CTRL + ALT + V", "CTRL + V", "SHIFT + V", "ALT + V"], a: 0 },
          { q: "Which function returns the largest value in a dataset?", opts: ["MAX", "LARGE", "HIGH", "TOP"], a: 0 },
          { q: "Which function finds the k-th smallest value in a dataset?", opts: ["MIN", "SMALL", "FEWEST", "LOW"], a: 1 },
          { q: "What is the default text alignment in Excel cells?", opts: ["Left", "Right", "Center", "Justified"], a: 0 },
          { q: "What is the default number alignment in Excel cells?", opts: ["Left", "Right", "Center", "Justified"], a: 1 },
          { q: "Which feature freezes top rows or first column while scrolling?", opts: ["Freeze Panes", "Split Window", "Lock Cells", "Hide Rows"], a: 0 },
          { q: "Which function counts cells matching a single specified condition?", opts: ["COUNTIF", "COUNTIFS", "COUNTA", "SUMIF"], a: 0 },
          { q: "Which shortcut hides selected columns?", opts: ["CTRL + 0", "CTRL + 9", "CTRL + H", "ALT + H"], a: 0 },
          { q: "Which shortcut hides selected rows?", opts: ["CTRL + 9", "CTRL + 0", "CTRL + R", "ALT + R"], a: 0 },
          { q: "What function replaces part of a text string with a different text string?", opts: ["REPLACE", "SUBSTITUTE", "CHANGE", "SWAP"], a: 1 }
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
          { q: "What does LTV stand for in customer analytics?", opts: ["Long Term Value", "Lifetime Value", "Last Transaction Valuation", "Lead Total Value"], a: 1 },
          { q: "Which type of analytics answers 'Why did it happen'?", opts: ["Descriptive", "Diagnostic", "Predictive", "Prescriptive"], a: 1 },
          { q: "Which type of analytics suggests actions to take based on predictions?", opts: ["Descriptive", "Diagnostic", "Predictive", "Prescriptive"], a: 3 },
          { q: "What does CAC stand for in marketing analytics?", opts: ["Customer Acquisition Cost", "Customer Account Charge", "Calculated Annual Cost", "Client Asset Category"], a: 0 },
          { q: "What does NPS measure in business analytics?", opts: ["Net Profit Ratio", "Net Promoter Score (Customer Loyalty)", "New Product Sales", "National Performance Standard"], a: 1 },
          { q: "What is A/B testing primarily used for?", opts: ["Comparing two versions to see which performs better", "Auditing tax filings", "Staff evaluations", "Database backup"], a: 0 },
          { q: "What does a correlation coefficient of +1 indicate?", opts: ["No relationship", "Perfect positive linear relationship", "Inverse relationship", "Random pattern"], a: 1 },
          { q: "What is an 'Outlier' in data analytics?", opts: ["An average data point", "An extreme value far from other observations", "The center of a distribution", "A missing data entry"], a: 1 },
          { q: "What process involves identifying and correcting corrupt or inaccurate records?", opts: ["Data Warehousing", "Data Cleaning / Cleansing", "Data Mining", "Data Encryption"], a: 1 },
          { q: "What technique extracts hidden patterns from large datasets?", opts: ["Data Mining", "Data Entry", "Data Formatting", "Data Transmission"], a: 0 },
          { q: "What analysis tracks a specific group of users over a period of time?", opts: ["Cohort Analysis", "Funnel Analysis", "Pareto Analysis", "SWOT Analysis"], a: 0 },
          { q: "What does ROI stand for?", opts: ["Return on Investment", "Rate of Interest", "Risk of Inflation", "Ratio of Income"], a: 0 },
          { q: "What does 'Bounce Rate' measure on a website?", opts: ["Percentage of single-page visits with no interaction", "Repeat visitors", "Conversion rate", "Total page views"], a: 0 },
          { q: "Which metric represents revenue generated per active user?", opts: ["ARPU", "MRR", "ARR", "CLV"], a: 0 },
          { q: "What does MRR stand for in SaaS business models?", opts: ["Monthly Recurring Revenue", "Maximum Retail Revenue", "Margin Rate Ratio", "Mean Retention Rate"], a: 0 },
          { q: "What principle states that 80% of outcomes come from 20% of causes?", opts: ["Pareto Principle", "Gaussian Distribution", "Central Limit Theorem", "Occam's Razor"], a: 0 },
          { q: "What chart type is specifically designed to display cumulative flow/conversion drop-offs?", opts: ["Funnel Chart", "Scatter Plot", "Pie Chart", "Radar Chart"], a: 0 },
          { q: "What statistical measure represents the arithmetic average of numbers?", opts: ["Mean", "Median", "Mode", "Range"], a: 0 },
          { q: "Which statistical metric measures the spread of data relative to its mean?", opts: ["Standard Deviation", "Mode", "Median", "Mean"], a: 0 },
          { q: "What is a Data Warehouse?", opts: ["Central repository of integrated data from multiple sources", "A physical storage room for servers", "A backup hard drive", "An Excel sheet"], a: 0 },
          { q: "What does ETL stand for in data pipeline management?", opts: ["Extract, Transform, Load", "Enter, Test, Launch", "Evaluate, Transfer, Link", "Execute, Track, Log"], a: 0 },
          { q: "Which measure of central tendency is least affected by extreme outliers?", opts: ["Mean", "Median", "Range", "Standard Deviation"], a: 1 },
          { q: "What is a Hypothesis in statistical experimentation?", opts: ["A proven scientific fact", "A testable proposed explanation", "A final conclusion", "An error code"], a: 1 },
          { q: "What does p-value measure in statistical hypothesis testing?", opts: ["Probability of observing results if null hypothesis is true", "Percentage of total revenue", "Profit ratio", "Population size"], a: 0 },
          { q: "What does Type I error represent in hypothesis testing?", opts: ["False Positive", "False Negative", "Calculation Error", "Syntax Error"], a: 0 },
          { q: "What does Type II error represent in hypothesis testing?", opts: ["False Negative", "False Positive", "Data Loss", "System Crash"], a: 0 },
          { q: "What is Customer Churn?", opts: ["Rate at which customers stop doing business with an entity", "Rate of new customer sign-ups", "Customer feedback frequency", "Average order value"], a: 0 },
          { q: "What is RFM analysis in customer marketing?", opts: ["Recency, Frequency, Monetary analysis", "Risk, Return, Margin", "Revenue, Profit, Market", "Retention, Feedback, Metrics"], a: 0 },
          { q: "What is a Dashboard in business intelligence?", opts: ["Visual representation of key performance metrics", "Database backup script", "Spreadsheet grid only", "Software installer"], a: 0 },
          { q: "What visual chart displays relationship between two continuous variables?", opts: ["Scatter Plot", "Pie Chart", "Bar Chart", "Treemap"], a: 0 },
          { q: "What does Conversion Rate measure?", opts: ["Percentage of users who complete a desired action", "Total website traffic count", "Server loading speed", "Customer refund frequency"], a: 0 },
          { q: "What is Data Governance?", opts: ["Overall management of data availability, usability, integrity, and security", "Installing database software", "Deleting old files", "Building charts"], a: 0 },
          { q: "What does ARR stand for in subscription businesses?", opts: ["Annual Recurring Revenue", "Average Return Rate", "Actual Risk Ratio", "Annual Revenue Rate"], a: 0 },
          { q: "Which regression model predicts binary outcomes (e.g., Yes/No)?", opts: ["Logistic Regression", "Linear Regression", "Polynomial Regression", "Ridge Regression"], a: 0 },
          { q: "What is Time Series Analysis?", opts: ["Analyzing data points collected over successive time intervals", "Random data sampling", "Comparing two static cohorts", "Text sentiment analysis"], a: 0 },
          { q: "What does 'Overfitting' mean in predictive modeling?", opts: ["Model performs well on training data but poorly on unseen data", "Model is too simple", "Dataset has missing values", "Model trains too fast"], a: 0 },
          { q: "What is a Heat Map used for?", opts: ["Visualizing data values as colors in a matrix or map", "Measuring CPU temperature", "Plotting line graphs", "Building pivot tables"], a: 0 },
          { q: "What is Net Retention Rate (NRR)?", opts: ["Percentage of recurring revenue retained from existing customers over time", "Net profit margin", "Employee retention rate", "Tax rate"], a: 0 },
          { q: "What does CLV / LTV help determine?", opts: ["Maximum amount a company should spend to acquire a customer", "Employee salaries", "Product manufacturing cost", "Office rent"], a: 0 },
          { q: "What is Sentiment Analysis?", opts: ["Using NLP to identify emotional tone in text data", "Analyzing financial statements", "Calculating profit margins", "Measuring website latency"], a: 0 },
          { q: "What is Market Basket Analysis used for?", opts: ["Discovering co-occurrence patterns in retail transactions", "Setting retail property rent", "Stock inventory counting", "Evaluating cashier speed"], a: 0 },
          { q: "What does 'Cross-selling' mean?", opts: ["Selling complementary products to an existing customer", "Selling goods across borders", "Selling at a discount", "Selling competitor products"], a: 0 },
          { q: "What does 'Up-selling' mean?", opts: ["Encouraging customers to purchase a higher-end version of a product", "Selling items online", "Increasing overall prices", "Wholesale distribution"], a: 0 },
          { q: "What is a KPI Metric Target?", opts: ["A specific quantifiable goal set for a performance indicator", "The baseline calculation", "An past historical record", "An error limit"], a: 0 },
          { q: "What does Customer Retention Rate measure?", opts: ["Percentage of customers retained over a given period", "Number of new leads", "Product defect rate", "Employee turnover"], a: 0 },
          { q: "What is Dimensionality Reduction in machine learning?", opts: ["Reducing the number of input variables in a dataset", "Shrinking image size", "Truncating rows", "Deleting backup files"], a: 0 },
          { q: "What chart type is best for showing hierarchy and nested proportions?", opts: ["Treemap", "Line Chart", "Gauge Chart", "Scatter Plot"], a: 0 },
          { q: "What does 'Gross Margin' measure?", opts: ["Revenue remaining after subtracting Cost of Goods Sold (COGS)", "Net profit after taxes", "Total sales revenue", "Operating expense"], a: 0 },
          { q: "What is a Box Plot (Box-and-Whisker) used for?", opts: ["Visualizing distribution of data based on five-number summary", "Showing timeline events", "Mapping geographical data", "Tracking online traffic"], a: 0 },
          { q: "What does 'Payback Period' mean in customer analytics?", opts: ["Time required to recover Customer Acquisition Cost (CAC)", "Time to pay employee salaries", "Loan repayment duration", "Product delivery time"], a: 0 },
          { q: "What is Data Aggregation?", opts: ["Gathering and expressing data in a summary form", "Splitting data into small files", "Encrypting database tables", "Deleting old records"], a: 0 },
          { q: "What does 'Impression' mean in digital advertising analytics?", opts: ["Single display of an ad to a user", "A user clicking an ad", "A user buying a product", "A user closing an ad"], a: 0 },
          { q: "What is Click-Through Rate (CTR)?", opts: ["Percentage of impressions that resulted in a click", "Number of total conversions", "Cost per click", "Page bounce rate"], a: 0 },
          { q: "What does Cost Per Click (CPC) measure?", opts: ["Actual cost incurred for each click in an ad campaign", "Cost of product manufacturing", "Total marketing budget", "Cost per 1000 views"], a: 0 },
          { q: "What is a Business Intelligence (BI) tool?", opts: ["Software used to analyze, visualize, and report data", "Antivirus software", "Word processor", "Operating system"], a: 0 },
          { q: "What is Data Normalization?", opts: ["Organizing data to minimize redundancy and improve integrity", "Deleting outlier values", "Converting numbers to text", "Increasing table sizes"], a: 0 },
          { q: "What does 'Siloed Data' refer to?", opts: ["Data isolated within one department and inaccessible to others", "Backed up data", "Public open-source data", "Cleaned data"], a: 0 }
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
      if (['lobby', 'login', 'admin', 'pwchange'].includes(targetView)) {
        sound.stopAll();
      }
      state.currentView = targetView;
      render();
    }

    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'AVIATOR_STATE') {
        state.aviator = data;
        if (data.status === 'WAITING') {
          if (state.nextRoundBet) {
            state.hasBetAviator = true;
            state.nextRoundBet = false;
          }
          state.cashedOut = false;
        }
        if (data.status === 'FLYING' && !state.cashedOut) sound.playFly();
        if (data.status === 'CRASHED' && state.hasBetAviator && !state.cashedOut) {
          sound.playLoss();
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

    async function handleLogin() {
      sound.init();
      const u = document.getElementById('u').value;
      const p = document.getElementById('p').value;
      try {
        const res = await fetch('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u, password: p })
        });
        if (res.ok) {
          state.user = await res.json();
          if(!state.user.seenQuestions) state.user.seenQuestions = [];
          switchView(state.user.role === 'admin' ? 'admin' : 'lobby');
          if (state.user.role === 'admin') fetchAdminUsers();
        } else {
          showPopup('Invalid credentials', 'Try again');
        }
      } catch(e) {
        showPopup('Connection Error', 'Try again');
      }
      render();
    }

    async function fetchAdminUsers() {
      const res = await fetch('/api/admin/users');
      if (res.ok) state.adminUsers = await res.json();
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

    function updateBetAmount(delta) {
      state.userBet = Math.max(10, state.userBet + delta);
      const inputs = document.querySelectorAll('.bet-amt-input');
      inputs.forEach(i => i.value = state.userBet);
      if(state.currentView === 'aviator') renderAviatorOverlay();
      else render();
    }

    function renderBetControllerUI() {
      return \`
        <div class="flex items-center justify-between bg-black/60 p-2 rounded-2xl border border-amber-500/40 w-full max-w-xs shadow-lg">
          <span class="text-xs text-amber-300 font-bold ml-2">BET AMOUNT:</span>
          <div class="flex items-center gap-2">
            <button onclick="updateBetAmount(-10)" class="w-9 h-9 rounded-xl bg-red-900/80 border border-red-500 text-amber-300 font-black text-lg flex items-center justify-center active:scale-95">-</button>
            <input type="number" readonly value="\${state.userBet}" class="bet-amt-input w-20 bg-black/80 border border-amber-500/50 rounded-xl text-center font-mono font-bold text-amber-300 py-1.5 text-sm outline-none">
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
        state.hasBetAviator = true;
        renderAviatorOverlay();
      } else if (state.aviator.status === 'FLYING') {
        if (state.hasBetAviator && !state.cashedOut) {
          state.cashedOut = true;
          const winAmt = +(state.userBet * state.aviator.currentX).toFixed(2);
          state.user.balance += (winAmt - state.userBet);
          sound.playWin();
          showPopup(\`CASHED OUT AT \${state.aviator.currentX.toFixed(2)}x! WON ₹\${winAmt}\`, 'Paisa hi Paisa');
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
          ctx.fillText('💥', -16, 12);
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
          actionBtn.innerHTML = state.hasBetAviator ? 'BET PLACED FOR NEXT ROUND' : \`BET ₹\${state.userBet}\`;
          actionBtn.className = \`w-full h-14 rounded-2xl font-black text-xl tracking-wider transition-all shadow-lg \${state.hasBetAviator ? 'bg-gray-700 text-gray-400' : 'bg-red-600 text-white border-2 border-red-400'}\`;
        } else if (state.aviator.status === 'FLYING') {
          if (state.hasBetAviator && !state.cashedOut) {
            actionBtn.disabled = false;
            actionBtn.innerHTML = \`CASH OUT (₹\${(state.userBet * state.aviator.currentX).toFixed(2)})\`;
            actionBtn.className = 'w-full h-14 rounded-2xl font-black text-xl tracking-wider shadow-lg bg-emerald-500 text-black border-2 border-green-300 animate-pulse';
          } else if (state.nextRoundBet) {
            actionBtn.disabled = true;
            actionBtn.innerHTML = 'BET QUEUED FOR NEXT ROUND';
            actionBtn.className = 'w-full h-14 rounded-2xl font-black text-lg tracking-wider shadow-lg bg-amber-700 text-amber-200 border border-amber-500';
          } else {
            actionBtn.disabled = false;
            actionBtn.innerHTML = \`BET FOR NEXT ROUND (₹\${state.userBet})\`;
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
              showPopup(\`MATCHED! Sum is \${data.resultMeta.sum}. WON ₹\${(state.userBet * data.rewardMultiplier).toFixed(2)} (\${data.rewardMultiplier}x)!\`, 'Paisa hi Paisa');
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
            showPopup(\`SUCCESS! Entry: ₹\${startVal} | Exit: ₹\${endVal}. WON ₹\${(state.userBet * 2).toFixed(2)}!\`, 'Paisa hi Paisa', () => {
              state.predictionMark1 = null; state.predictionMark2 = null;
            });
          } else {
            sound.playLoss();
            showPopup(\`FAILED! Entry: ₹\${startVal} | Exit: ₹\${endVal}. YOU LOST!\`, 'Try Again', () => {
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

      Conversation with Gemini
This file is giving blank screen, fix the issues cause and give me the updated file.

Here is the analysis of the issue along with the updated, fixed code.

Cause of the Blank Screen
The file rendered a blank screen because the inline HTML/JavaScript string template inside app.get('/', ...) was accidentally truncated at the end (roundMultText = cb.round === 1 ? '+1.40x' : (cb.round === 2 ? '+1.6). This unclosed template string resulted in a server-side syntax error during module parsing, preventing the server from serving responses.

Fixed & Complete Server Script
Below is the complete, self-contained server file with the frontend code fully restored:

JavaScript
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
  balance: { type: Number, default: 1000 },
  totalWon: { type: Number, default: 0 },
  totalLost: { type: Number, default: 0 },
  totalBetPlaced: { type: Number, default: 0 },
  seenQuestions: { type: [String], default: [] }
});
const User = mongoose.model('User', userSchema);

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
  const users = await User.find({ role: 'player' });
  res.json(users);
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
  <title>Skilled Old Hand 🤑</title>
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
        if (['lobby', 'login', 'admin', 'pwchange'].includes(state.currentView)) return;
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
        if (['lobby', 'login', 'admin', 'pwchange'].includes(state.currentView)) return;
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
      currentView: 'login',
      adminSubTab: 'users',
      aviator: { status: 'WAITING', currentX: 1.00, history: [] },
      userBet: 100,
      hasBetAviator: false,
      nextRoundBet: false,
      cashedOut: false,
      popup: null,
      adminUsers: [],
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
          { q: "Which phrase contains a dangling modifier?", opts: ["Having finished the report, the computer crashed.", "After completing the audit, she left.", "To succeed, practice daily.", "While reviewing numbers, we saw mistakes."], a: 0 },
          { q: "Identify the correct pronoun: 'Send the final document to Sarah and ___.'", opts: ["I", "me", "myself", "mine"], a: 1 }
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
          </div>
        \`,
        mcqs: generate15kQuestions('Vocabulary', 'VOC', [
          { q: "What does 'Mitigate' mean?", opts: ["Increase severity", "Lessen or reduce harm", "Duplicate records", "Delay execution"], a: 1 },
          { q: "Choose the synonym for 'Synergy'.", opts: ["Isolation", "Combined effectiveness", "Conflict", "Division"], a: 1 },
          { q: "What is the meaning of 'Pivot' in business?", opts: ["Close operations", "Maintain current strategy", "Strategic change in course", "File for bankruptcy"], a: 2 }
        ])
      },
      'MS Excel': {
        color: '#059669',
        lesson: \`
          <div class="space-y-4 text-sm text-amber-100/90 leading-relaxed text-left font-sans">
            <h3 class="text-base font-bold text-amber-300 border-b border-amber-500/30 pb-1">CHAPTER 1: Lookup Functions & References</h3>
            <p><strong>1. Lookup Logic:</strong> VLOOKUP searches for values in the leftmost column of a dataset. XLOOKUP is the modern replacement that eliminates leftward lookup constraints and default exact-match issues.</p>
            <p><strong>2. Cell Referencing:</strong> The "$" symbol freezes row/column coordinates ($A$1). The F4 key cycles through relative, absolute, and mixed reference modes.</p>
          </div>
        \`,
        mcqs: generate15kQuestions('MS Excel', 'EXC', [
          { q: "Which formula searches for a value in the leftmost column of a table?", opts: ["XLOOKUP", "VLOOKUP", "HLOOKUP", "INDEX"], a: 1 },
          { q: "What symbol freezes cell references in Excel (Absolute Reference)?", opts: ["#", "$", "%", "&"], a: 1 }
        ])
      },
      'Business analytics': {
        color: '#d97706',
        lesson: \`
          <div class="space-y-4 text-sm text-amber-100/90 leading-relaxed text-left font-sans">
            <h3 class="text-base font-bold text-amber-300 border-b border-amber-500/30 pb-1">CHAPTER 1: Analytics Taxonomies & KPIs</h3>
            <p><strong>1. Analytics Types:</strong> Descriptive analytics focuses on past events ("What happened"), Diagnostic analyzes causes, Predictive forecasts trends, and Prescriptive analytics recommends specific business decisions.</p>
          </div>
        \`,
        mcqs: generate15kQuestions('Business analytics', 'BSA', [
          { q: "What type of analytics explains 'What happened in the past'?", opts: ["Predictive", "Descriptive", "Prescriptive", "Diagnostic"], a: 1 },
          { q: "What does KPI stand for?", opts: ["Key Process Integration", "Key Performance Indicator", "Known Program Insight", "Key Profit Index"], a: 1 }
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
      if (['lobby', 'login', 'admin', 'pwchange'].includes(targetView)) {
        sound.stopAll();
      }
      state.currentView = targetView;
      render();
    }

    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'AVIATOR_STATE') {
        state.aviator = data;
        if (data.status === 'WAITING') {
          if (state.nextRoundBet) {
            state.hasBetAviator = true;
            state.nextRoundBet = false;
          }
          state.cashedOut = false;
        }
        if (data.status === 'FLYING' && !state.cashedOut) sound.playFly();
        if (data.status === 'CRASHED' && state.hasBetAviator && !state.cashedOut) {
          sound.playLoss();
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

    async function handleLogin() {
      sound.init();
      const u = document.getElementById('u').value;
      const p = document.getElementById('p').value;
      try {
        const res = await fetch('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u, password: p })
        });
        if (res.ok) {
          state.user = await res.json();
          if(!state.user.seenQuestions) state.user.seenQuestions = [];
          switchView(state.user.role === 'admin' ? 'admin' : 'lobby');
          if (state.user.role === 'admin') fetchAdminUsers();
        } else {
          showPopup('Invalid credentials', 'Try again');
        }
      } catch(e) {
        showPopup('Connection Error', 'Try again');
      }
      render();
    }

    async function fetchAdminUsers() {
      const res = await fetch('/api/admin/users');
      if (res.ok) state.adminUsers = await res.json();
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

    function updateBetAmount(delta) {
      state.userBet = Math.max(10, state.userBet + delta);
      const inputs = document.querySelectorAll('.bet-amt-input');
      inputs.forEach(i => i.value = state.userBet);
      if(state.currentView === 'aviator') renderAviatorOverlay();
      else render();
    }

    function renderBetControllerUI() {
      return \`
        <div class="flex items-center justify-between bg-black/60 p-2 rounded-2xl border border-amber-500/40 w-full max-w-xs shadow-lg">
          <span class="text-xs text-amber-300 font-bold ml-2">BET AMOUNT:</span>
          <div class="flex items-center gap-2">
            <button onclick="updateBetAmount(-10)" class="w-9 h-9 rounded-xl bg-red-900/80 border border-red-500 text-amber-300 font-black text-lg flex items-center justify-center active:scale-95">-</button>
            <input type="number" readonly value="\${state.userBet}" class="bet-amt-input w-20 bg-black/80 border border-amber-500/50 rounded-xl text-center font-mono font-bold text-amber-300 py-1.5 text-sm outline-none">
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
        state.hasBetAviator = true;
        renderAviatorOverlay();
      } else if (state.aviator.status === 'FLYING') {
        if (state.hasBetAviator && !state.cashedOut) {
          state.cashedOut = true;
          const winAmt = +(state.userBet * state.aviator.currentX).toFixed(2);
          state.user.balance += (winAmt - state.userBet);
          sound.playWin();
          showPopup(\`CASHED OUT AT \${state.aviator.currentX.toFixed(2)}x! WON ₹\${winAmt}\`, 'Paisa hi Paisa');
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
          ctx.fillText('💥', -16, 12);
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
          actionBtn.innerHTML = state.hasBetAviator ? 'BET PLACED FOR NEXT ROUND' : \`BET ₹\${state.userBet}\`;
          actionBtn.className = \`w-full h-14 rounded-2xl font-black text-xl tracking-wider transition-all shadow-lg \${state.hasBetAviator ? 'bg-gray-700 text-gray-400' : 'bg-red-600 text-white border-2 border-red-400'}\`;
        } else if (state.aviator.status === 'FLYING') {
          if (state.hasBetAviator && !state.cashedOut) {
            actionBtn.disabled = false;
            actionBtn.innerHTML = \`CASH OUT (₹\${(state.userBet * state.aviator.currentX).toFixed(2)})\`;
            actionBtn.className = 'w-full h-14 rounded-2xl font-black text-xl tracking-wider shadow-lg bg-emerald-500 text-black border-2 border-green-300 animate-pulse';
          } else if (state.nextRoundBet) {
            actionBtn.disabled = true;
            actionBtn.innerHTML = 'BET QUEUED FOR NEXT ROUND';
            actionBtn.className = 'w-full h-14 rounded-2xl font-black text-lg tracking-wider shadow-lg bg-amber-700 text-amber-200 border border-amber-500';
          } else {
            actionBtn.disabled = false;
            actionBtn.innerHTML = \`BET FOR NEXT ROUND (₹\${state.userBet})\`;
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
              showPopup(\`MATCHED! Sum is \${data.resultMeta.sum}. WON ₹\${(state.userBet * data.rewardMultiplier).toFixed(2)} (\${data.rewardMultiplier}x)!\`, 'Paisa hi Paisa');
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
            showPopup(\`SUCCESS! Entry: ₹\${startVal} | Exit: ₹\${endVal}. WON ₹\${(state.userBet * 2).toFixed(2)}!\`, 'Paisa hi Paisa', () => {
              state.predictionMark1 = null; state.predictionMark2 = null;
            });
          } else {
            sound.playLoss();
            showPopup(\`FAILED! Entry: ₹\${startVal} | Exit: ₹\${endVal}. YOU LOST!\`, 'Try Again', () => {
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
              showPopup(\`ALL ROUNDS PASSED! Total Multiplier \${finalMult.toFixed(2)}x! WON ₹\${(state.userBet * finalMult).toFixed(2)}!\`, 'Paisa hi Paisa', () => {
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
          showPopup(\`WRONG ANSWER! Correct answer highlighted in green. YOU LOST ₹\${state.userBet}.\`, 'Try Again', () => {
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

      drawRoundedRect(ctx, lastX - 68, lastY - 26, 62, 20, 6, '#22c55e', '#000000', '₹' + lastVal);

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

        drawRoundedRect(ctx, 8, y1 - 20, 100, 18, 4, '#eab308', '#000000', 'ENTRY: ₹' + state.predictionMark1);
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

        drawRoundedRect(ctx, w - 108, y2 - 20, 100, 18, 4, '#06b6d4', '#000000', 'EXIT: ₹' + state.predictionMark2);
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

      if (state.currentView === 'login') {
        html = \`
          <div class="h-full w-full flex flex-col items-center justify-center p-6 bg-gradient-to-b from-[#2a0404] to-[#0d0202]">
            <div class="tomato-card p-8 rounded-3xl w-full text-center space-y-5">
              <div class="text-6xl">🤑</div>
              <div>
                <h1 class="text-3xl font-black gold-text tracking-wider">Skilled Old Hand</h1>
                <p class="text-xs font-semibold text-amber-200/70 mt-1">Shree Ganesh Karte Hai</p>
              </div>
              <div class="space-y-3">
                <input id="u" oninput="checkLoginInputsDirectly()" type="text" placeholder="Username" class="w-full p-4 rounded-2xl bg-black/60 border border-amber-500/40 text-white placeholder-amber-200/40 text-sm outline-none">
                <input id="p" oninput="checkLoginInputsDirectly()" type="password" placeholder="Password" class="w-full p-4 rounded-2xl bg-black/60 border border-amber-500/40 text-white placeholder-amber-200/40 text-sm outline-none">
              </div>
              <button id="lbtn" onclick="handleLogin()" class="hidden w-full gold-gradient text-black font-black py-4 rounded-2xl shadow-xl text-lg">
                Paisa hi Paisa Hoga 💰
              </button>
            </div>
          </div>
        \`;
      }

      else if (state.currentView === 'lobby') {
        html = \`
          <div class="h-full w-full flex flex-col bg-[#120303]">
            <div class="h-16 px-4 bg-gradient-to-r from-red-950 via-black to-red-950 border-b border-amber-500/40 flex items-center justify-between shadow-lg">
              <span class="font-black text-lg gold-text">Skilled Old Hand 🤑</span>
              <div class="flex items-center gap-2">
                <div class="bg-black/60 px-3 py-1.5 rounded-full border border-amber-500/40">
                  <span class="text-xs text-amber-300 font-bold">₹</span>
                  <span class="text-sm font-mono font-bold text-green-400">\${state.user.balance.toFixed(2)}</span>
                </div>
                <button onclick="switchView('pwchange')" class="px-2.5 py-1 bg-amber-600/30 border border-amber-500/50 rounded-lg text-[10px] font-bold text-amber-300">Password</button>
                <button onclick="switchView('login')" class="px-2.5 py-1 bg-red-900/50 border border-red-500/50 rounded-lg text-[10px] font-bold text-red-300">Logout</button>
              </div>
            </div>
            <div class="flex-1 p-4 grid grid-cols-2 gap-4 overflow-y-auto">
              \${[
                { id: 'careerboot', name: 'CareerBoot', icon: '🎓', desc: 'Wheel & MCQ Rounds' },
                { id: 'aviator', name: 'Aviator', icon: '🚀', desc: 'Realtime Multiplier' },
                { id: 'guesscorrect', name: 'Guess Correct', icon: '🎲', desc: 'Big vs Small Dice' },
                { id: 'prediction', name: 'Prediction', icon: '📈', desc: 'Live Market Line' }
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

      else if (state.currentView === 'careerboot') {
        const cb = state.careerboot;
        if (cb.stage === 'WHEEL') {
          html = \`
            <div class="h-full w-full flex flex-col bg-[#120303]">
              <div class="h-14 px-3 bg-red-950 border-b border-amber-500/40 flex items-center justify-between">
                <button onclick="switchView('lobby')" class="px-3 py-1 bg-red-900 border border-amber-500/40 rounded-xl text-xs font-bold text-white">Lobby</button>
                <span class="font-black gold-text">CAREERBOOT WHEEL</span>
                <span class="font-mono text-sm text-green-400 font-bold">₹\${state.user.balance.toFixed(2)}</span>
              </div>
              <div class="flex-1 flex flex-col items-center justify-center p-4 space-y-4">
                <div class="relative w-72 h-72 flex items-center justify-center">
                  <canvas id="cb-wheel-canvas" class="w-full h-full"></canvas>
                </div>
                \${renderBetControllerUI()}
                <button onclick="spinCareerBootWheel()" \${cb.spinning ? 'disabled' : ''} class="w-full max-w-xs h-14 rounded-2xl font-black text-xl tracking-wider gold-gradient text-black shadow-xl active:scale-95 transition-all">
                  \${cb.spinning ? 'SPINNING...' : 'SPIN THE WHEEL 🎡'}
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
                <span class="font-mono text-sm text-green-400 font-bold">₹\${state.user.balance.toFixed(2)}</span>
              </div>
              <div class="flex-1 p-5 overflow-y-auto space-y-4">
                <div class="tomato-card p-6 rounded-3xl space-y-3">
                  <div class="flex items-center gap-2">
                    <span class="text-2xl">📖</span>
                    <h2 class="text-xl font-black text-amber-300 uppercase">\${cb.selectedSlice} Deep Detailed Chapter</h2>
                  </div>
                  \${sliceData.lesson}
                </div>
              </div>
              <div class="p-4 bg-red-950 border-t border-amber-500/40 shrink-0 flex justify-center">
                <button onclick="startCareerBootMCQs()" class="w-full max-w-xs h-14 rounded-2xl font-black text-lg gold-gradient text-black shadow-xl active:scale-95">
                  START MCQ QUIZ 🚀
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
              <span class="font-mono text-sm text-green-400 font-bold">₹\${state.user.balance.toFixed(2)}</span>
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
                BET ₹\${state.userBet}
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
              <span class="font-mono text-sm text-green-400 font-bold">₹\${state.user.balance.toFixed(2)}</span>
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
              <span class="font-mono text-sm text-green-400 font-bold">₹\${state.user.balance.toFixed(2)}</span>
            </div>
            <div class="flex-1 flex flex-col items-center justify-between p-3 space-y-3">
              <div class="w-full flex-1 bg-gradient-to-b from-[#090d16] to-[#04060a] border-2 border-emerald-500/30 rounded-3xl relative overflow-hidden flex flex-col p-2 min-h-[280px] shadow-[0_0_20px_rgba(16,185,129,0.15)]">
                <canvas id="market-canvas" class="absolute inset-0 w-full h-full"></canvas>
                <div class="relative z-10 flex justify-between items-center p-2 pointer-events-none">
                  <div class="flex items-center gap-2 bg-black/80 backdrop-blur-md px-3 py-1.5 rounded-2xl border border-emerald-500/40 shadow-lg">
                    <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping"></span>
                    <span class="text-xs font-bold text-emerald-400 uppercase tracking-widest">LIVE</span>
                    <span class="text-sm font-mono font-black text-white ml-1">₹\${state.marketHistory[state.marketHistory.length - 1]}</span>
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
                  <span class="text-xl">📈</span>
                </button>
                <button onclick="playPrediction('down')" class="bg-gradient-to-b from-red-600 to-red-800 border-2 border-red-400 h-14 rounded-2xl font-black text-lg active:scale-95 text-white shadow-[0_0_15px_rgba(239,68,68,0.4)] flex items-center justify-center gap-2">
                  <span>DOWN</span>
                  <span class="text-xl">📉</span>
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

            <div class="flex gap-2 my-3 shrink-0">
              <button onclick="state.adminSubTab='users'; render();" class="w-1/2 py-2 rounded-xl font-bold text-xs \${state.adminSubTab==='users' ? 'gold-gradient text-black' : 'bg-gray-800 text-gray-400'}">Users Management</button>
              <button onclick="state.adminSubTab='create'; render();" class="w-1/2 py-2 rounded-xl font-bold text-xs \${state.adminSubTab==='create' ? 'gold-gradient text-black' : 'bg-gray-800 text-gray-400'}">Create User</button>
            </div>

            <div class="flex-1 overflow-y-auto space-y-4">
              \${state.adminSubTab === 'create' ? \`
                <div class="tomato-card p-4 rounded-2xl space-y-3">
                  <h3 class="font-bold text-sm text-amber-300">Create Player Account</h3>
                  <input id="nu" placeholder="New Username" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
                  <input id="np" placeholder="New Password" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
                  <button onclick="createPlayer()" class="w-full gold-gradient text-black font-black py-3 rounded-xl text-sm">Create Account</button>
                </div>
              \` : \`
                <div class="tomato-card p-4 rounded-2xl space-y-3">
                  <h3 class="font-bold text-sm text-amber-300">Modify User Balance</h3>
                  <input id="bu" placeholder="Player Username" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
                  <input id="ba" type="number" placeholder="Amount (+1000 or -500)" class="w-full p-3 bg-black/60 border border-amber-500/40 rounded-xl text-sm outline-none text-white">
                  <button onclick="modifyBalance()" class="w-full bg-emerald-600 text-white font-black py-3 rounded-xl text-sm">Update Balance</button>
                </div>

                <div class="space-y-2">
                  <h3 class="font-bold text-xs text-amber-300/80">ALL PLAYERS STATISTICS</h3>
                  \${state.adminUsers.map(u => \`
                    <div class="bg-black/60 p-3 rounded-xl border border-amber-500/30 text-xs space-y-1">
                      <div class="flex justify-between font-bold text-amber-300">
                        <span>👤 \${u.username}</span>
                        <span class="text-green-400 font-mono">₹\${u.balance.toFixed(2)}</span>
                      </div>
                      <div class="grid grid-cols-3 gap-1 text-[10px] text-gray-400 font-mono mt-1">
                        <div>Won: <span class="text-green-400">₹\${u.totalWon}</span></div>
                        <div>Lost: <span class="text-red-400">₹\${u.totalLost}</span></div>
                        <div>Placed: <span class="text-amber-200">₹\${u.totalBetPlaced}</span></div>
                      </div>
                    </div>
                  \`).join('')}
                </div>
              \`}
            </div>
          </div>
        \`;
      }

      app.innerHTML = html + popupHtml;

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
      if (res.ok) { fetchAdminUsers(); showPopup('User Created Successfully', 'OK'); }
      else showPopup('Error Creating User', 'try again');
    }

    async function modifyBalance() {
      const username = document.getElementById('bu').value;
      const amount = parseFloat(document.getElementById('ba').value);
      const res = await fetch('/api/admin/update-balance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, amount })
      });
      if (res.ok) { fetchAdminUsers(); showPopup('Balance Updated!', 'OK'); }
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

    server.listen(PORT, () => console.log(`Casino Server active on port ${PORT}`));
    startAviatorLoop();
  } catch (err) {
    console.error("Database connection failure:", err.message);
  }
}

startServer();
