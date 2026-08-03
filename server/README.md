# Okane Flow - Minimal server

This folder contains a minimal Node/Express server implementing the API contract used by the frontend (index.html).
It is intended for local development and testing only. It uses SQLite (better-sqlite3) and provides:

- POST /api/auth/register { email, password }
- POST /api/auth/login { email, password } -> { token }
- GET  /api/transactions -> [{ id, description, category, date, amount, type }]
- POST /api/transactions { description, category, date, amount, type } -> created transaction
- DELETE /api/transactions/:id
- WebSocket at ws(s)://host/ws/sync?token=<jwt> broadcasting messages { type: 'transactions:update', data: [...] }

Quick start

1. Install dependencies

   cd server
   npm install

2. Configure environment

   cp .env.example .env
   Edit .env and set JWT_SECRET to a strong secret

3. Start

   npm run start

4. By default the server listens on PORT (4000). Point the frontend apiBase to http://localhost:4000

Notes
- Passwords are stored hashed (bcrypt).
- JWTs are signed with JWT_SECRET. Keep it secret in production.
- This server is intentionally simple and not production hardened. Use it as a reference implementation.
