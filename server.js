import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- DB setup
const db = new Database(path.join(__dirname, 'db.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  club TEXT,
  photo_url TEXT,
  total_points INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  points_allocated INTEGER NOT NULL CHECK(points_allocated >= 0),
  UNIQUE(user_id, player_id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(player_id) REFERENCES players(id)
);

-- Matches for POTM polls
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  opponent TEXT NOT NULL,
  home_away TEXT CHECK(home_away in ('HOME','AWAY')) DEFAULT 'HOME',
  status TEXT DEFAULT 'final' -- 'upcoming', 'live', 'final'
);

-- POTM votes: one vote per user per match
CREATE TABLE IF NOT EXISTS potm_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  user_email TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(match_id, user_email),
  FOREIGN KEY(match_id) REFERENCES matches(id),
  FOREIGN KEY(player_id) REFERENCES players(id)
);
`);

// --- Seed players if empty
const playerCount = db.prepare('SELECT COUNT(*) as c FROM players').get().c;
if (playerCount === 0) {
  const seed = db.prepare('INSERT INTO players (name, club, photo_url) VALUES (?, ?, ?)');
  seed.run('Lamine Yamal', 'FC Barcelona', '');
  seed.run('Pedri', 'FC Barcelona', '');
  seed.run('Gavi', 'FC Barcelona', '');
}

// --- Seed a sample match if empty
const matchCount = db.prepare('SELECT COUNT(*) as c FROM matches').get().c;
if (matchCount === 0) {
  db.prepare('INSERT INTO matches (date, opponent, home_away, status) VALUES (?, ?, ?, ?)')
    .run(new Date().toISOString().slice(0,10), 'Real Madrid', 'HOME', 'final');
}

// --- Helpers
const getUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const createUser = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
const upsertAllocation = db.prepare(`
INSERT INTO allocations (user_id, player_id, points_allocated)
VALUES (?, ?, ?)
ON CONFLICT(user_id, player_id) DO UPDATE SET points_allocated = excluded.points_allocated
`);

// --- API routes

// Players
app.get('/api/players', (req, res) => {
  const rows = db.prepare('SELECT * FROM players ORDER BY id').all();
  res.json(rows);
});

app.post('/api/players', (req, res) => {
  const { name, club, photo_url } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const info = db.prepare('INSERT INTO players (name, club, photo_url) VALUES (?, ?, ?)')
                 .run(name, club || '', photo_url || '');
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.post('/api/players/:id/points', (req, res) => {
  const id = Number(req.params.id);
  const { delta, set } = req.body || {};
  const row = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Player not found' });
  let newTotal = row.total_points;
  if (typeof set === 'number') newTotal = set;
  if (typeof delta === 'number') newTotal = newTotal + delta;
  db.prepare('UPDATE players SET total_points = ? WHERE id = ?').run(newTotal, id);
  res.json({ ok: true, id, total_points: newTotal });
});

// Allocations (Breakout Tracker)
app.post('/api/allocate', (req, res) => {
  const { name, email, allocations } = req.body || {};
  if (!name || !email || !Array.isArray(allocations)) {
    return res.status(400).json({ error: 'name, email, allocations[] required' });
  }
  const total = allocations.reduce((s, a) => s + Number(a.points_allocated || 0), 0);
  if (total !== 100) return res.status(400).json({ error: 'Total allocated points must equal 100' });

  const tx = db.transaction(() => {
    let user = getUserByEmail.get(email);
    if (!user) {
      const info = createUser.run(name, email);
      user = { id: info.lastInsertRowid, name, email };
    }
    for (const a of allocations) {
      if (!a.player_id) throw new Error('player_id missing');
      upsertAllocation.run(user.id, a.player_id, a.points_allocated);
    }
    return user;
  });

  try {
    const user = tx();
    res.json({ ok: true, user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Allocation failed' });
  }
});

app.get('/api/leaderboard', (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.name, u.email,
           COALESCE(SUM(a.points_allocated * p.total_points / 100.0), 0) as portfolio_points
    FROM users u
    LEFT JOIN allocations a ON a.user_id = u.id
    LEFT JOIN players p ON p.id = a.player_id
    GROUP BY u.id
    ORDER BY portfolio_points DESC, u.id ASC
    LIMIT 100
  `).all();
  res.json(rows);
});

// Matches + POTM
app.get('/api/matches', (req, res) => {
  const rows = db.prepare('SELECT * FROM matches ORDER BY date DESC, id DESC').all();
  res.json(rows);
});

app.post('/api/matches', (req, res) => {
  const { date, opponent, home_away = 'HOME', status = 'final' } = req.body || {};
  if (!date || !opponent) return res.status(400).json({ error: 'date and opponent required' });
  const info = db.prepare('INSERT INTO matches (date, opponent, home_away, status) VALUES (?, ?, ?, ?)')
                 .run(date, opponent, home_away, status);
  res.json({ ok: true, id: info.lastInsertRowid });
});

// Vote (upsert by match_id + user_email)
app.post('/api/potm/:match_id/vote', (req, res) => {
  const match_id = Number(req.params.match_id);
  const { name, email, player_id } = req.body || {};
  if (!name || !email || !player_id) return res.status(400).json({ error: 'name, email, player_id required' });

  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(match_id);
  if (!match) return res.status(404).json({ error: 'Match not found' });

  // Ensure user exists
  let user = getUserByEmail.get(email);
  if (!user) {
    const info = createUser.run(name, email);
    user = { id: info.lastInsertRowid, name, email };
  }

  db.prepare(`
    INSERT INTO potm_votes (match_id, player_id, user_email)
    VALUES (?, ?, ?)
    ON CONFLICT(match_id, user_email) DO UPDATE SET player_id = excluded.player_id, created_at = datetime('now')
  `).run(match_id, player_id, email);

  res.json({ ok: true });
});

app.get('/api/potm/:match_id/results', (req, res) => {
  const match_id = Number(req.params.match_id);
  const rows = db.prepare(`
    SELECT p.id as player_id, p.name as player_name, COUNT(v.id) as votes
    FROM players p
    LEFT JOIN potm_votes v ON v.player_id = p.id AND v.match_id = ?
    GROUP BY p.id
    ORDER BY votes DESC, p.name ASC
  `).all(match_id);
  res.json(rows);
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`
Culers' Corner running at http://localhost:${PORT}
`));
