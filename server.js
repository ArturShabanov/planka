// Планка — сервер: вход через Telegram, общие проекты, одноразовые приглашения.
// Без зависимостей: node:http + node:sqlite (Node 22.13+ / 24).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

/* ---------- config ---------- */
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3150').replace(/\/$/, '');
const PORT = +process.env.PORT || 3150;
const HOST = process.env.HOST || '127.0.0.1';
if (!BOT_TOKEN) { console.error('BOT_TOKEN не задан в .env'); process.exit(1); }

/* ---------- db ---------- */
const db = new DatabaseSync(path.join(__dirname, 'planka.db'));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT, username TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER);
CREATE TABLE IF NOT EXISTS logins (code TEXT PRIMARY KEY, user_id INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, data TEXT NOT NULL, updated INTEGER);
CREATE TABLE IF NOT EXISTS members (project_id TEXT NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL, added INTEGER, PRIMARY KEY (project_id, user_id));
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
CREATE TABLE IF NOT EXISTS invites (token TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_by INTEGER, created INTEGER, used_by INTEGER, used_at INTEGER);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`);
const q = sql => db.prepare(sql);
const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
if (!cols('tasks').includes('remind_at')) db.exec(`ALTER TABLE tasks ADD COLUMN remind_at INTEGER; ALTER TABLE tasks ADD COLUMN remind_by INTEGER; ALTER TABLE tasks ADD COLUMN reminded INTEGER DEFAULT 0;`);
if (!cols('users').includes('tz')) db.exec(`ALTER TABLE users ADD COLUMN tz TEXT; ALTER TABLE users ADD COLUMN digest INTEGER DEFAULT 1; ALTER TABLE users ADD COLUMN last_digest TEXT;`);
const now = () => Date.now();
const bumpRev = () => q(`INSERT INTO meta(k,v) VALUES('rev',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(String(now()));
const rev = () => +(q(`SELECT v FROM meta WHERE k='rev'`).get()?.v || 0);

function upsertUser(u) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Без имени';
  q(`INSERT INTO users(id,name,username,created) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, username=excluded.username`)
    .run(u.id, name, u.username || null, now());
  return { id: u.id, name, username: u.username || null };
}
function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  q(`INSERT INTO sessions(token,user_id,created) VALUES(?,?,?)`).run(token, userId, now());
  return token;
}
const isMember = (pid, uid) => q(`SELECT role FROM members WHERE project_id=? AND user_id=?`).get(pid, uid)?.role || null;

/* ---------- telegram ---------- */
function checkInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash'); if (!hash) return null;
  params.delete('hash');
  const dcs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (now() / 1000 - +params.get('auth_date') > 86400 * 7) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}
async function tgApi(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json(); if (!j.ok) throw new Error(`${method}: ${j.description}`); return j.result;
}
let BOT_USERNAME = '';
const openBtn = (text, url) => ({ inline_keyboard: [[{ text, web_app: { url } }]] });
async function handleUpdate(u) {
  const m = u.message; if (!m || !m.text || !m.from) return;
  upsertUser(m.from);
  const arg = (m.text.match(/^\/start(?:\s+(\S+))?/) || [])[1] || '';
  if (!m.text.startsWith('/start')) {
    return tgApi('sendMessage', { chat_id: m.chat.id, text: 'Задачи открываются кнопкой ниже.', reply_markup: openBtn('Открыть задачи', BASE_URL + '/') });
  }
  if (arg.startsWith('login_')) {
    const code = arg.slice(6);
    const row = q(`SELECT * FROM logins WHERE code=?`).get(code);
    if (!row || now() - row.created > 10 * 60e3) return tgApi('sendMessage', { chat_id: m.chat.id, text: 'Ссылка для входа устарела. Обновите страницу на компьютере и попробуйте снова.' });
    q(`UPDATE logins SET user_id=? WHERE code=?`).run(m.from.id, code);
    return tgApi('sendMessage', { chat_id: m.chat.id, text: 'Готово, вы вошли. Вернитесь в браузер: задачи уже открываются.' });
  }
  if (arg.startsWith('join_')) {
    const token = arg.slice(5);
    const inv = q(`SELECT i.*, p.data FROM invites i JOIN projects p ON p.id=i.project_id WHERE token=?`).get(token);
    if (!inv) return tgApi('sendMessage', { chat_id: m.chat.id, text: 'Приглашение не найдено или проект удалён.' });
    if (inv.used_by && inv.used_by !== m.from.id) return tgApi('sendMessage', { chat_id: m.chat.id, text: 'Это приглашение уже использовал другой человек. Попросите новую ссылку.' });
    const name = JSON.parse(inv.data).name;
    return tgApi('sendMessage', { chat_id: m.chat.id, text: `Вас пригласили в проект «${name}».`, reply_markup: openBtn('Открыть проект', `${BASE_URL}/?join=${token}`) });
  }
  return tgApi('sendMessage', { chat_id: m.chat.id, text: 'Это ваш задачник. Открывайте его кнопкой ниже или кнопкой меню рядом с полем ввода.', reply_markup: openBtn('Открыть задачи', BASE_URL + '/') });
}
async function botLoop() {
  try {
    const me = await tgApi('getMe'); BOT_USERNAME = me.username;
    await tgApi('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Задачи', web_app: { url: BASE_URL + '/' } } });
    await tgApi('setMyCommands', { commands: [{ command: 'start', description: 'Открыть задачник' }] });
    await tgApi('deleteWebhook', {});
    console.log('bot @' + BOT_USERNAME + ' ready');
  } catch (e) { console.error('bot init failed:', e.message); setTimeout(botLoop, 15000); return; }
  let offset = 0;
  for (;;) {
    try {
      const ups = await tgApi('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      for (const u of ups) { offset = u.update_id + 1; handleUpdate(u).catch(e => console.error('update:', e.message)); }
    } catch (e) { console.error('poll:', e.message); await new Promise(r => setTimeout(r, 5000)); }
  }
}

/* ---------- http ---------- */
const ID = /^[A-Za-z0-9_-]{4,64}$/;
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };
function readBody(req) {
  return new Promise((res, rej) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 256 * 1024) { rej(new HttpError(413, 'Слишком большой запрос')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return res({}); try { res(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { rej(new HttpError(400, 'Неверный JSON')); } });
    req.on('error', rej);
  });
}
function auth(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const s = t && q(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?`).get(t);
  if (!s) fail(401, 'Нужно войти');
  return s;
}
function cleanData(d, maxLen) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) fail(400, 'Нет данных');
  const s = JSON.stringify(d); if (s.length > maxLen) fail(413, 'Слишком много текста'); return s;
}
function state(uid) {
  const projects = q(`SELECT p.id, p.owner_id, p.data, m.role FROM projects p JOIN members m ON m.project_id=p.id AND m.user_id=?`).all(uid);
  const ids = projects.map(p => p.id);
  const members = ids.length ? q(`SELECT m.project_id, m.user_id, m.role, u.name, u.username FROM members m JOIN users u ON u.id=m.user_id WHERE m.project_id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
  const tasks = ids.length ? q(`SELECT id, project_id, data FROM tasks WHERE project_id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
  return {
    rev: rev(),
    projects: projects.map(p => ({ ...JSON.parse(p.data), id: p.id, ownerId: p.owner_id, role: p.role,
      members: members.filter(m => m.project_id === p.id).map(m => ({ id: m.user_id, role: m.role, name: m.name, username: m.username })) })),
    tasks: tasks.map(t => ({ ...JSON.parse(t.data), id: t.id, projectId: t.project_id }))
  };
}

const routes = [
  ['POST', /^\/api\/auth\/tg$/, async (req) => {
    const { initData } = await readBody(req);
    const u = checkInitData(initData || ''); if (!u) fail(401, 'Не удалось проверить вход через Telegram');
    const user = upsertUser(u); return { token: newSession(user.id), user };
  }],
  ['POST', /^\/api\/auth\/link$/, async () => {
    const code = crypto.randomBytes(12).toString('hex');
    q(`INSERT INTO logins(code,user_id,created) VALUES(?,NULL,?)`).run(code, now());
    q(`DELETE FROM logins WHERE created < ?`).run(now() - 3600e3);
    return { code, url: `https://t.me/${BOT_USERNAME}?start=login_${code}` };
  }],
  ['GET', /^\/api\/auth\/link\/([a-f0-9]{24})$/, async (req, [code]) => {
    const row = q(`SELECT * FROM logins WHERE code=?`).get(code);
    if (!row || now() - row.created > 10 * 60e3) fail(410, 'Ссылка для входа устарела');
    if (!row.user_id) return { pending: true };
    q(`DELETE FROM logins WHERE code=?`).run(code);
    const user = q(`SELECT * FROM users WHERE id=?`).get(row.user_id);
    return { token: newSession(user.id), user };
  }],
  ['POST', /^\/api\/me$/, async (req) => {
    const u = auth(req); const { tz, digest } = await readBody(req);
    if (typeof tz === 'string' && tz.length < 64) { try { new Intl.DateTimeFormat('ru-RU', { timeZone: tz }); q(`UPDATE users SET tz=? WHERE id=?`).run(tz, u.id); } catch {} }
    if (typeof digest === 'boolean') q(`UPDATE users SET digest=? WHERE id=?`).run(digest ? 1 : 0, u.id);
    return { ok: true };
  }],
  ['POST', /^\/api\/logout$/, async (req) => { auth(req); q(`DELETE FROM sessions WHERE token=?`).run(req.headers.authorization.replace(/^Bearer\s+/i, '')); return { ok: true }; }],
  ['GET', /^\/api\/state$/, async (req, _, url) => {
    const u = auth(req);
    if (url.searchParams.has('rev') && +url.searchParams.get('rev') === rev()) return { same: true };
    return { me: { id: u.id, name: u.name, username: u.username, tz: u.tz, digest: u.digest !== 0 }, bot: BOT_USERNAME, ...state(u.id) };
  }],
  ['PUT', /^\/api\/projects\/([^/]+)$/, async (req, [pid]) => {
    const u = auth(req); if (!ID.test(pid)) fail(400, 'Неверный id');
    const { data } = await readBody(req);
    const { id, ownerId, role, members, ...rest } = data || {};
    const s = cleanData(rest, 64 * 1024);
    const ex = q(`SELECT owner_id FROM projects WHERE id=?`).get(pid);
    if (ex) { if (!isMember(pid, u.id)) fail(403, 'Нет доступа к проекту'); q(`UPDATE projects SET data=?, updated=? WHERE id=?`).run(s, now(), pid); }
    else {
      q(`INSERT INTO projects(id,owner_id,data,updated) VALUES(?,?,?,?)`).run(pid, u.id, s, now());
      q(`INSERT INTO members(project_id,user_id,role,added) VALUES(?,?,'owner',?)`).run(pid, u.id, now());
    }
    bumpRev(); return { ok: true };
  }],
  ['DELETE', /^\/api\/projects\/([^/]+)$/, async (req, [pid]) => {
    const u = auth(req);
    if (isMember(pid, u.id) !== 'owner') fail(403, 'Удалить проект может только владелец');
    for (const t of ['tasks', 'members', 'invites']) q(`DELETE FROM ${t} WHERE project_id=?`).run(pid);
    q(`DELETE FROM projects WHERE id=?`).run(pid);
    bumpRev(); return { ok: true };
  }],
  ['PUT', /^\/api\/tasks\/([^/]+)$/, async (req, [tid]) => {
    const u = auth(req); if (!ID.test(tid)) fail(400, 'Неверный id');
    const { data } = await readBody(req);
    const { id, projectId, ...rest } = data || {};
    if (!projectId || !isMember(projectId, u.id)) fail(403, 'Нет доступа к проекту');
    const ex = q(`SELECT project_id, remind_at, remind_by, reminded FROM tasks WHERE id=?`).get(tid);
    if (ex && !isMember(ex.project_id, u.id)) fail(403, 'Нет доступа к задаче');
    const s = cleanData(rest, 64 * 1024);
    const ra = Date.parse(rest.remindAt || '') || null;
    let rb = ex ? ex.remind_by : null, rd = ex ? ex.reminded || 0 : 0;
    if (!ex || ex.remind_at !== ra) { rb = ra ? u.id : null; rd = 0; }  // whoever sets the reminder receives it
    q(`INSERT INTO tasks(id,project_id,data,updated,remind_at,remind_by,reminded) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, data=excluded.data, updated=excluded.updated, remind_at=excluded.remind_at, remind_by=excluded.remind_by, reminded=excluded.reminded`).run(tid, projectId, s, now(), ra, rb, rd);
    bumpRev(); return { ok: true };
  }],
  ['DELETE', /^\/api\/tasks\/([^/]+)$/, async (req, [tid]) => {
    const u = auth(req);
    const ex = q(`SELECT project_id FROM tasks WHERE id=?`).get(tid);
    if (ex) { if (!isMember(ex.project_id, u.id)) fail(403, 'Нет доступа к задаче'); q(`DELETE FROM tasks WHERE id=?`).run(tid); bumpRev(); }
    return { ok: true };
  }],
  ['POST', /^\/api\/projects\/([^/]+)\/invites$/, async (req, [pid]) => {
    const u = auth(req);
    if (isMember(pid, u.id) !== 'owner') fail(403, 'Приглашать может только владелец проекта');
    const token = crypto.randomBytes(12).toString('hex');
    q(`INSERT INTO invites(token,project_id,created_by,created) VALUES(?,?,?,?)`).run(token, pid, u.id, now());
    return { token, url: `https://t.me/${BOT_USERNAME}?start=join_${token}`, webUrl: `${BASE_URL}/?join=${token}` };
  }],
  ['POST', /^\/api\/invites\/([a-f0-9]{24})\/accept$/, async (req, [token]) => {
    const u = auth(req);
    const inv = q(`SELECT * FROM invites WHERE token=?`).get(token);
    if (!inv || !q(`SELECT 1 FROM projects WHERE id=?`).get(inv.project_id)) fail(404, 'Приглашение не найдено или проект удалён');
    if (isMember(inv.project_id, u.id)) return { projectId: inv.project_id };
    if (inv.used_by && inv.used_by !== u.id) fail(410, 'Это приглашение уже использовал другой человек. Попросите новую ссылку.');
    q(`UPDATE invites SET used_by=?, used_at=? WHERE token=? AND used_by IS NULL`).run(u.id, now(), token);
    if (q(`SELECT used_by FROM invites WHERE token=?`).get(token).used_by !== u.id) fail(410, 'Это приглашение уже использовано.');
    q(`INSERT OR IGNORE INTO members(project_id,user_id,role,added) VALUES(?,?,'member',?)`).run(inv.project_id, u.id, now());
    bumpRev(); return { projectId: inv.project_id };
  }],
  ['DELETE', /^\/api\/projects\/([^/]+)\/members\/(\d+)$/, async (req, [pid, uid]) => {
    const u = auth(req); const target = +uid;
    const myRole = isMember(pid, u.id);
    if (!myRole || (target !== u.id && myRole !== 'owner')) fail(403, 'Нет прав');
    if (isMember(pid, target) === 'owner') fail(400, 'Владельца нельзя удалить из проекта');
    q(`DELETE FROM members WHERE project_id=? AND user_id=?`).run(pid, target);
    bumpRev(); return { ok: true };
  }],
];

const INDEX = path.join(__dirname, 'public', 'index.html');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      return fs.createReadStream(INDEX).pipe(res);
    }
    if (url.pathname === '/health') return send(200, { ok: true });
    for (const [m, re, fn] of routes) {
      if (req.method !== m) continue;
      const match = url.pathname.match(re); if (!match) continue;
      return send(200, await fn(req, match.slice(1), url));
    }
    send(404, { error: 'Не найдено' });
  } catch (e) {
    if (e instanceof HttpError) return send(e.code, { error: e.message });
    console.error(e); send(500, { error: 'Ошибка сервера' });
  }
});
/* ---------- reminders + morning digest ---------- */
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const localParts = (tz, ms = now()) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute };
};
const ruDate = d => new Date(d + 'T00:00:00Z').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace('.', '');
function taskInfo(row) {
  const t = JSON.parse(row.data), p = JSON.parse(row.pdata);
  const col = (p.columns || []).find(c => c.id === t.columnId);
  return { t, p, col, label: `${esc(p.key || '')}-${t.num}` };
}
async function sendReminders() {
  const rows = q(`SELECT t.id, t.project_id, t.data, t.remind_by, p.data pdata FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.remind_at IS NOT NULL AND t.remind_at <= ? AND t.reminded=0 AND t.remind_by IS NOT NULL`).all(now());
  for (const row of rows) {
    q(`UPDATE tasks SET reminded=1 WHERE id=?`).run(row.id);
    const { t, p, col, label } = taskInfo(row);
    if (!isMember(row.project_id, row.remind_by)) continue; // left the project
    if (col && col.done) continue;
    const text = `⏰ <b>Напоминание</b>\n${label} · ${esc(t.title)}\nПроект «${esc(p.name)}»${col ? ` · ${esc(col.name)}` : ''}${t.due ? `\nСрок: ${ruDate(t.due)}` : ''}`;
    tgApi('sendMessage', { chat_id: row.remind_by, text, parse_mode: 'HTML', reply_markup: openBtn('Открыть задачу', `${BASE_URL}/?task=${row.id}`) }).catch(e => console.error('remind:', e.message));
  }
}
async function sendDigests() {
  for (const u of q(`SELECT * FROM users WHERE digest IS NOT 0`).all()) {
    const lp = localParts(u.tz);
    if (lp.hour !== 9 || u.last_digest === lp.date) continue;
    q(`UPDATE users SET last_digest=? WHERE id=?`).run(lp.date, u.id);
    const rows = q(`SELECT t.id, t.data, p.data pdata FROM tasks t JOIN members m ON m.project_id=t.project_id AND m.user_id=? JOIN projects p ON p.id=t.project_id`).all(u.id);
    const due = rows.map(taskInfo).filter(x => x.t.due && x.t.due <= lp.date && !(x.col && x.col.done))
      .sort((a, b) => a.t.due.localeCompare(b.t.due) || (b.t.priority || 0) - (a.t.priority || 0));
    if (!due.length) continue;
    const lines = due.slice(0, 25).map(x => `• ${x.label} ${esc(x.t.title)} — ${x.t.due < lp.date ? `<b>просрочено</b> (${ruDate(x.t.due)})` : 'сегодня'}`);
    const more = due.length > 25 ? `\n…и ещё ${due.length - 25}` : '';
    const text = `☀️ <b>Задачи на сегодня</b>\n${lines.join('\n')}${more}`;
    tgApi('sendMessage', { chat_id: u.id, text, parse_mode: 'HTML', reply_markup: openBtn('Открыть задачи', BASE_URL + '/') }).catch(e => console.error('digest:', e.message));
  }
}
setInterval(() => { sendReminders().catch(e => console.error(e)); sendDigests().catch(e => console.error(e)); }, 30e3);

server.listen(PORT, HOST, () => console.log(`planka on http://${HOST}:${PORT} → ${BASE_URL}`));
botLoop();
