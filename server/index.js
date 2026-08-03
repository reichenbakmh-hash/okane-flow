const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'please_change_me';
const DB_FILE = process.env.DATABASE_FILE || path.join(__dirname, 'data', 'okane.db');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// Initialize DB
const db = new Database(DB_FILE);
// Create tables if not exists
db.prepare(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  description TEXT,
  category TEXT,
  date TEXT,
  amount REAL NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('income','expense')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
)`).run();

const app = express();
app.use(helmet());
app.use(express.json());
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));

// Helpers
function signToken(payload){ return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' }); }
function verifyToken(token){ try{ return jwt.verify(token, JWT_SECRET); }catch(e){ return null; } }

// Broadcast management for websockets
const userSockets = new Map(); // userId -> Set(ws)
function broadcastUser(userId, message){
  const set = userSockets.get(userId);
  if(!set) return;
  const raw = JSON.stringify(message);
  for(const ws of set){
    if(ws.readyState === ws.OPEN){
      try{ ws.send(raw); }catch(e){ console.warn('ws send err',e); }
    }
  }
}

// Auth endpoints
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body || {};
  if(!email || !password) return res.status(400).json({ error: 'email and password required' });
  if(String(password).length < 6) return res.status(400).json({ error: 'password too short' });
  try{
    const hash = await bcrypt.hash(password, 10);
    const stmt = db.prepare('INSERT INTO users (email, password_hash) VALUES (?,?)');
    const info = stmt.run(email.toLowerCase(), hash);
    const user = { id: info.lastInsertRowid, email };
    const token = signToken({ userId: user.id });
    res.status(201).json({ token });
  }catch(err){
    if(err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'email already exists' });
    console.error(err); res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if(!email || !password) return res.status(400).json({ error: 'email and password required' });
  try{
    const row = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email.toLowerCase());
    if(!row) return res.status(401).json({ error: 'invalid credentials' });
    const match = await bcrypt.compare(password, row.password_hash);
    if(!match) return res.status(401).json({ error: 'invalid credentials' });
    const token = signToken({ userId: row.id });
    res.json({ token });
  }catch(err){ console.error(err); res.status(500).json({ error: 'internal error' }); }
});

// Auth middleware
function authMiddleware(req,res,next){
  const h = req.headers.authorization;
  if(!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'missing token' });
  const token = h.slice(7);
  const payload = verifyToken(token);
  if(!payload || !payload.userId) return res.status(401).json({ error: 'invalid token' });
  req.userId = payload.userId; next();
}

// Transactions
app.get('/api/transactions', authMiddleware, (req,res)=>{
  try{
    const rows = db.prepare('SELECT id, description, category, date, amount, type, created_at, updated_at FROM transactions WHERE user_id = ? ORDER BY date ASC, id ASC').all(req.userId);
    res.json(rows);
  }catch(err){ console.error(err); res.status(500).json({ error: 'internal error' }); }
});

app.post('/api/transactions', authMiddleware, (req,res)=>{
  const { description, category, date, amount, type } = req.body || {};
  if(!amount || isNaN(Number(amount)) || !type || !['income','expense'].includes(type)) return res.status(400).json({ error: 'invalid payload' });
  try{
    const stmt = db.prepare('INSERT INTO transactions (user_id, description, category, date, amount, type) VALUES (?,?,?,?,?,?)');
    const info = stmt.run(req.userId, description||'', category||'', date||new Date().toISOString().slice(0,10), Number(amount), type);
    const tx = db.prepare('SELECT id, description, category, date, amount, type, created_at, updated_at FROM transactions WHERE id = ?').get(info.lastInsertRowid);
    // broadcast updated list
    const all = db.prepare('SELECT id, description, category, date, amount, type, created_at, updated_at FROM transactions WHERE user_id = ? ORDER BY date ASC, id ASC').all(req.userId);
    broadcastUser(req.userId, { type: 'transactions:update', data: all });
    res.status(201).json(tx);
  }catch(err){ console.error(err); res.status(500).json({ error: 'internal error' }); }
});

app.delete('/api/transactions/:id', authMiddleware, (req,res)=>{
  const id = Number(req.params.id);
  if(!id) return res.status(400).json({ error: 'invalid id' });
  try{
    const tx = db.prepare('SELECT id FROM transactions WHERE id = ? AND user_id = ?').get(id, req.userId);
    if(!tx) return res.status(404).json({ error: 'not found' });
    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);

    // broadcast updated list
    const all = db.prepare('SELECT id, description, category, date, amount, type, created_at, updated_at FROM transactions WHERE user_id = ? ORDER BY date ASC, id ASC').all(req.userId);
    broadcastUser(req.userId, { type: 'transactions:update', data: all });

    res.status(204).send();
  }catch(err){ console.error(err); res.status(500).json({ error: 'internal error' }); }
});

// Serve a health endpoint
app.get('/health', (req,res) => res.json({ ok: true }));

// Start HTTP server and WS server
const server = app.listen(PORT, () => console.log('Okane Flow API listening on', PORT));

const wss = new WebSocketServer({ server, path: '/ws/sync' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const payload = verifyToken(token);
  if(!payload || !payload.userId){ ws.close(1008, 'unauthorized'); return; }
  const userId = payload.userId;
  // attach
  let set = userSockets.get(userId); if(!set){ set = new Set(); userSockets.set(userId, set); }
  set.add(ws);
  // send initial data
  try{
    const all = db.prepare('SELECT id, description, category, date, amount, type, created_at, updated_at FROM transactions WHERE user_id = ? ORDER BY date ASC, id ASC').all(userId);
    ws.send(JSON.stringify({ type: 'transactions:update', data: all }));
  }catch(e){ console.warn(e); }

  ws.on('close', ()=>{ set.delete(ws); if(set.size===0) userSockets.delete(userId); });
});

// Graceful shutdown
process.on('SIGINT', ()=>{ console.log('shutting down'); server.close(()=>process.exit(0)); });
