// Data store: Postgres when DATABASE_URL is set, otherwise an in-memory store for local testing.
import pg from 'pg';

const pub = u => u && ({ id: u.id, username: u.username, wins: u.wins, matches: u.matches, kills: u.kills, deaths: u.deaths });

class MemoryStore {
  constructor() { this.users = new Map(); this.sessions = new Map(); this.friends = new Map(); this.seq = 1; this.kind = 'memory'; }
  async init() {}
  async createUser(username, passHash) {
    if (await this.userByName(username)) throw Object.assign(new Error('taken'), { code: 'taken' });
    const u = { id: this.seq++, username, pass_hash: passHash, wins: 0, matches: 0, kills: 0, deaths: 0 };
    this.users.set(u.id, u); return pub(u);
  }
  async userByName(name) { const n = String(name).toLowerCase(); for (const u of this.users.values()) if (u.username.toLowerCase() === n) return u; return null; }
  async userById(id) { return pub(this.users.get(id)); }
  async passHash(id) { const u = this.users.get(id); return u && u.pass_hash; }
  async createSession(userId, tokenHash) { this.sessions.set(tokenHash, userId); }
  async sessionUser(tokenHash) { const id = this.sessions.get(tokenHash); return id ? pub(this.users.get(id)) : null; }
  async deleteSession(tokenHash) { this.sessions.delete(tokenHash); }
  async deleteUser(id) {
    this.users.delete(id); this.friends.delete(id);
    for (const [t, uid] of this.sessions) if (uid === id) this.sessions.delete(t);
    for (const s of this.friends.values()) s.delete(id);
  }
  async addFriend(uid, fid) { if (!this.friends.has(uid)) this.friends.set(uid, new Set()); this.friends.get(uid).add(fid); }
  async removeFriend(uid, fid) { this.friends.get(uid)?.delete(fid); }
  async friendList(uid) { return [...(this.friends.get(uid) || [])].map(id => this.users.get(id)).filter(Boolean).map(u => ({ id: u.id, username: u.username })); }
  async isFriend(uid, fid) { return !!this.friends.get(uid)?.has(fid); }
  async recordMatch(uid, { win, kills, deaths }) {
    const u = this.users.get(uid); if (!u) return;
    u.matches++; if (win) u.wins++; u.kills += kills; u.deaths += deaths;
  }
}

class PgStore {
  constructor(url) {
    this.kind = 'postgres';
    this.pool = new pg.Pool({ connectionString: url, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }, max: 8 });
  }
  q(text, params) { return this.pool.query(text, params); }
  async init() {
    await this.q(`
      create table if not exists cy_users(
        id serial primary key, username text not null, pass_hash text not null,
        wins int not null default 0, matches int not null default 0, kills int not null default 0, deaths int not null default 0,
        created_at timestamptz not null default now());
      create unique index if not exists cy_users_username_lower on cy_users(lower(username));
      create table if not exists cy_sessions(
        token_hash text primary key, user_id int not null references cy_users(id) on delete cascade,
        created_at timestamptz not null default now());
      create table if not exists cy_friends(
        user_id int not null references cy_users(id) on delete cascade, friend_id int not null references cy_users(id) on delete cascade,
        created_at timestamptz not null default now(), primary key(user_id, friend_id));`);
  }
  async createUser(username, passHash) {
    try { const r = await this.q('insert into cy_users(username, pass_hash) values($1,$2) returning *', [username, passHash]); return pub(r.rows[0]); }
    catch (e) { if (e.code === '23505') throw Object.assign(new Error('taken'), { code: 'taken' }); throw e; }
  }
  async userByName(name) { const r = await this.q('select * from cy_users where lower(username)=lower($1)', [name]); return r.rows[0] || null; }
  async userById(id) { const r = await this.q('select * from cy_users where id=$1', [id]); return pub(r.rows[0]); }
  async passHash(id) { const r = await this.q('select pass_hash from cy_users where id=$1', [id]); return r.rows[0]?.pass_hash; }
  async createSession(userId, tokenHash) { await this.q('insert into cy_sessions(token_hash, user_id) values($1,$2)', [tokenHash, userId]); }
  async sessionUser(tokenHash) { const r = await this.q('select u.* from cy_sessions s join cy_users u on u.id=s.user_id where s.token_hash=$1', [tokenHash]); return pub(r.rows[0]); }
  async deleteSession(tokenHash) { await this.q('delete from cy_sessions where token_hash=$1', [tokenHash]); }
  async deleteUser(id) { await this.q('delete from cy_users where id=$1', [id]); }
  async addFriend(uid, fid) { await this.q('insert into cy_friends(user_id, friend_id) values($1,$2) on conflict do nothing', [uid, fid]); }
  async removeFriend(uid, fid) { await this.q('delete from cy_friends where user_id=$1 and friend_id=$2', [uid, fid]); }
  async friendList(uid) { const r = await this.q('select u.id, u.username from cy_friends f join cy_users u on u.id=f.friend_id where f.user_id=$1 order by lower(u.username)', [uid]); return r.rows; }
  async isFriend(uid, fid) { const r = await this.q('select 1 from cy_friends where user_id=$1 and friend_id=$2', [uid, fid]); return r.rowCount > 0; }
  async recordMatch(uid, { win, kills, deaths }) {
    await this.q('update cy_users set matches=matches+1, wins=wins+$2, kills=kills+$3, deaths=deaths+$4 where id=$1', [uid, win ? 1 : 0, kills, deaths]);
  }
}

export function makeStore() {
  if (process.env.DATABASE_URL) return new PgStore(process.env.DATABASE_URL);
  console.warn('[crateyard] DATABASE_URL not set: using in-memory storage. Accounts disappear when the server restarts.');
  return new MemoryStore();
}
