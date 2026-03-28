const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const PORT = process.env.PORT || 3000;

// Serve static files from the public folder
app.use(express.static(path.join(process.cwd(), 'public')));
app.use(express.json());

// In-memory session state
let session = {
  active: false,
  currentQuestion: 0,
  allowChanges: false,
  questions: [],
  voters: {}
};

function resetSession(questions, allowChanges) {
  session = {
    active: true,
    currentQuestion: 0,
    allowChanges,
    questions: questions.map((q, i) => ({
      label: q.label || `Question ${i + 1}`,
      optionCount: q.optionCount,
      votes: {}
    })),
    voters: {}
  };
}

function getResults(qIndex) {
  const q = session.questions[qIndex];
  if (!q) return {};
  const results = {};
  for (let i = 0; i < q.optionCount; i++) results[i] = 0;
  Object.values(session.voters).forEach(v => {
    const choice = v[qIndex];
    if (choice !== undefined) results[choice] = (results[choice] || 0) + 1;
  });
  return results;
}

function broadcastResults() {
  const qIndex = session.currentQuestion;
  io.emit('results_update', {
    qIndex,
    label: session.questions[qIndex]?.label || '',
    optionCount: session.questions[qIndex]?.optionCount || 0,
    results: getResults(qIndex),
    totalVoters: Object.keys(session.voters).length
  });
}

// Admin login
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, message: 'Wrong password' });
  }
});

// QR code generation
app.get('/api/qr', async (req, res) => {
  const base = req.query.url || `${req.protocol}://${req.get('host')}`;
  try {
    const dataUrl = await QRCode.toDataURL(base, { width: 300, margin: 2 });
    res.json({ qr: dataUrl });
  } catch (e) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// Current session state
app.get('/api/state', (req, res) => {
  res.json({
    active: session.active,
    currentQuestion: session.currentQuestion,
    totalQuestions: session.questions.length,
    allowChanges: session.allowChanges,
    currentLabel: session.questions[session.currentQuestion]?.label || '',
    currentOptionCount: session.questions[session.currentQuestion]?.optionCount ?? 10
  });
});

// Socket.io
io.on('connection', (socket) => {

  socket.emit('session_state', {
    active: session.active,
    currentQuestion: session.currentQuestion,
    totalQuestions: session.questions.length,
    allowChanges: session.allowChanges,
    currentLabel: session.questions[session.currentQuestion]?.label || '',
    currentOptionCount: session.questions[session.currentQuestion]?.optionCount ?? 10
  });

  socket.on('admin_start', ({ password, questions, allowChanges }) => {
    if (password !== ADMIN_PASSWORD) { socket.emit('admin_error', 'Wrong password'); return; }
    resetSession(questions, allowChanges);
    io.emit('session_state', {
      active: true,
      currentQuestion: 0,
      totalQuestions: session.questions.length,
      allowChanges: session.allowChanges,
      currentLabel: session.questions[0]?.label || '',
      currentOptionCount: session.questions[0]?.optionCount ?? 10
    });
    broadcastResults();
  });

  socket.on('admin_end', ({ password }) => {
    if (password !== ADMIN_PASSWORD) return;
    session.active = false;
    io.emit('session_state', { active: false });
  });

  socket.on('admin_goto', ({ password, qIndex }) => {
    if (password !== ADMIN_PASSWORD) return;
    if (qIndex < 0 || qIndex >= session.questions.length) return;
    session.currentQuestion = qIndex;
    const q = session.questions[qIndex];
    io.emit('session_state', {
      active: true,
      currentQuestion: qIndex,
      totalQuestions: session.questions.length,
      allowChanges: session.allowChanges,
      currentLabel: q.label,
      currentOptionCount: q.optionCount
    });
    broadcastResults();
  });

  socket.on('admin_refresh', ({ password }) => {
    if (password !== ADMIN_PASSWORD) return;
    broadcastResults();
  });

  socket.on('vote', ({ fingerprint, option }) => {
    if (!session.active) return;
    const qIndex = session.currentQuestion;
    const q = session.questions[qIndex];
    if (!q || option < 0 || option >= q.optionCount) return;
    const id = fingerprint || socket.id;
    if (!session.voters[id]) session.voters[id] = {};
    if (session.voters[id][qIndex] !== undefined && !session.allowChanges) {
      socket.emit('vote_rejected', 'Already voted on this question');
      return;
    }
    session.voters[id][qIndex] = option;
    socket.emit('vote_accepted', { qIndex, option });
    broadcastResults();
  });

  socket.on('check_vote', ({ fingerprint }) => {
    const id = fingerprint || socket.id;
    socket.emit('vote_status', session.voters[id] || {});
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
