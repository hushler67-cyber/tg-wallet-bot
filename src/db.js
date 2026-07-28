// Storage layer. Private keys are ALWAYS encrypted before they reach this file.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { encrypt, decrypt } = require('./crypto');

const dbPath = process.env.DB_PATH || './data/wallets.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id        INTEGER PRIMARY KEY,
    telegram_username  TEXT,
    eth_address        TEXT NOT NULL,
    eth_privkey_enc    TEXT NOT NULL,
    bsc_address        TEXT NOT NULL,
    bsc_privkey_enc    TEXT NOT NULL,
    sol_address        TEXT NOT NULL,
    sol_privkey_enc    TEXT NOT NULL,
    eth_balance        REAL NOT NULL DEFAULT 0,
    bsc_balance        REAL NOT NULL DEFAULT 0,
    sol_balance        REAL NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === column);
}

if (columnExists('users', 'btc_address') && !columnExists('users', 'bsc_address')) {
  try { db.exec('ALTER TABLE users RENAME COLUMN btc_address TO bsc_address'); } catch (e) { console.warn(e.message); }
}
if (columnExists('users', 'btc_privkey_enc') && !columnExists('users', 'bsc_privkey_enc')) {
  try { db.exec('ALTER TABLE users RENAME COLUMN btc_privkey_enc TO bsc_privkey_enc'); } catch (e) { console.warn(e.message); }
}
if (columnExists('users', 'btc_balance') && !columnExists('users', 'bsc_balance')) {
  try { db.exec('ALTER TABLE users RENAME COLUMN btc_balance TO bsc_balance'); } catch (e) { console.warn(e.message); }
}
if (!columnExists('users', 'bsc_address')) { try { db.exec('ALTER TABLE users ADD COLUMN bsc_address TEXT'); } catch {} }
if (!columnExists('users', 'bsc_privkey_enc')) { try { db.exec('ALTER TABLE users ADD COLUMN bsc_privkey_enc TEXT'); } catch {} }
if (!columnExists('users', 'eth_balance')) { try { db.exec('ALTER TABLE users ADD COLUMN eth_balance REAL NOT NULL DEFAULT 0'); } catch {} }
if (!columnExists('users', 'bsc_balance')) { try { db.exec('ALTER TABLE users ADD COLUMN bsc_balance REAL NOT NULL DEFAULT 0'); } catch {} }
if (!columnExists('users', 'sol_balance')) { try { db.exec('ALTER TABLE users ADD COLUMN sol_balance REAL NOT NULL DEFAULT 0'); } catch {} }

db.exec(`
  CREATE TABLE IF NOT EXISTS copytrade_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    address TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(telegram_id, address)
  );
  CREATE TABLE IF NOT EXISTS copytrade_status (
    telegram_id INTEGER PRIMARY KEY,
    active INTEGER NOT NULL DEFAULT 0
  );
`);

function addCopytradeTarget(telegramId, address) {
  db.prepare('INSERT OR IGNORE INTO copytrade_targets (telegram_id, address) VALUES (?, ?)').run(telegramId, address);
}
function getCopytradeTargets(telegramId) {
  return db.prepare('SELECT address FROM copytrade_targets WHERE telegram_id = ? ORDER BY created_at').all(telegramId).map((r) => r.address);
}
function setCopytradeActive(telegramId, active) {
  db.prepare(`INSERT INTO copytrade_status (telegram_id, active) VALUES (?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET active = excluded.active`).run(telegramId, active ? 1 : 0);
}
function isCopytradeActive(telegramId) {
  const row = db.prepare('SELECT active FROM copytrade_status WHERE telegram_id = ?').get(telegramId);
  return !!(row && row.active);
}

const VALID_CHAINS = new Set(['eth', 'bsc', 'sol']);

function importWallet(telegramId, chain, address, privateKey) {
  const col = chain.toLowerCase();
  if (!VALID_CHAINS.has(col)) throw new Error(`Unknown chain: ${chain}`);
  db.prepare(`UPDATE users SET ${col}_address = ?, ${col}_privkey_enc = ? WHERE telegram_id = ?`)
    .run(address, encrypt(privateKey), telegramId);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS auto_deposit_settings (
    telegram_id INTEGER NOT NULL,
    chain TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (telegram_id, chain)
  );
`);
function setAutoDeposit(telegramId, chain, enabled) {
  db.prepare(`INSERT INTO auto_deposit_settings (telegram_id, chain, enabled) VALUES (?, ?, ?)
    ON CONFLICT(telegram_id, chain) DO UPDATE SET enabled = excluded.enabled`).run(telegramId, chain, enabled ? 1 : 0);
}
function getAutoDepositSettings(telegramId) {
  const rows = db.prepare('SELECT chain, enabled FROM auto_deposit_settings WHERE telegram_id = ?').all(telegramId);
  const map = { ETH: false, BSC: false, SOL: false };
  for (const row of rows) map[row.chain] = !!row.enabled;
  return map;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS auto_deposit_schedule (
    telegram_id INTEGER PRIMARY KEY,
    interval_hours INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    last_reminded_at TEXT
  );
`);
try { db.exec('ALTER TABLE auto_deposit_schedule ADD COLUMN last_reminded_at TEXT'); } catch {}

function setAutoDepositSchedule(telegramId, intervalHours) {
  db.prepare(`INSERT INTO auto_deposit_schedule (telegram_id, interval_hours, active) VALUES (?, ?, 0)
    ON CONFLICT(telegram_id) DO UPDATE SET interval_hours = excluded.interval_hours`).run(telegramId, intervalHours);
}
function setAutoDepositScheduleActive(telegramId, active) {
  const now = new Date().toISOString();
  db.prepare('UPDATE auto_deposit_schedule SET active = ?, last_reminded_at = ? WHERE telegram_id = ?')
    .run(active ? 1 : 0, active ? now : null, telegramId);
}
function getAutoDepositSchedule(telegramId) {
  return db.prepare('SELECT * FROM auto_deposit_schedule WHERE telegram_id = ?').get(telegramId);
}
function touchAutoDepositReminder(telegramId) {
  db.prepare('UPDATE auto_deposit_schedule SET last_reminded_at = ? WHERE telegram_id = ?')
    .run(new Date().toISOString(), telegramId);
}
function getDueAutoDepositReminders() {
  return db.prepare(`
    SELECT s.telegram_id, s.interval_hours, s.last_reminded_at,
           u.eth_address, u.bsc_address, u.sol_address
    FROM auto_deposit_schedule s
    JOIN users u ON u.telegram_id = s.telegram_id
    WHERE s.active = 1
      AND (s.last_reminded_at IS NULL OR (julianday('now') - julianday(s.last_reminded_at)) * 24 >= s.interval_hours)
  `).all();
}

function deleteUser(telegramId) {
  db.prepare('DELETE FROM copytrade_targets WHERE telegram_id = ?').run(telegramId);
  db.prepare('DELETE FROM copytrade_status WHERE telegram_id = ?').run(telegramId);
  db.prepare('DELETE FROM auto_deposit_settings WHERE telegram_id = ?').run(telegramId);
  db.prepare('DELETE FROM auto_deposit_schedule WHERE telegram_id = ?').run(telegramId);
  db.prepare('DELETE FROM users WHERE telegram_id = ?').run(telegramId);
}
function getUser(telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
}
function createUser({ telegramId, telegramUsername, eth, bsc, sol }) {
  db.prepare(`
    INSERT INTO users (
      telegram_id, telegram_username,
      eth_address, eth_privkey_enc,
      bsc_address, bsc_privkey_enc,
      sol_address, sol_privkey_enc,
      eth_balance, bsc_balance, sol_balance
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
  `).run(
    telegramId, telegramUsername || null,
    eth.address, encrypt(eth.privateKey),
    bsc.address, encrypt(bsc.privateKey),
    sol.address, encrypt(sol.privateKey),
  );
}
function getDecryptedKeys(telegramId) {
  const row = getUser(telegramId);
  if (!row) return null;
  return {
    eth: { address: row.eth_address, privateKey: decrypt(row.eth_privkey_enc) },
    bsc: { address: row.bsc_address, privateKey: decrypt(row.bsc_privkey_enc) },
    sol: { address: row.sol_address, privateKey: decrypt(row.sol_privkey_enc) },
  };
}
function setDummyBalance(telegramId, chain, amount) {
  const col = chain.toLowerCase();
  if (!VALID_CHAINS.has(col)) throw new Error(`Unknown chain: ${chain}`);
  const value = Number(amount);
  if (Number.isNaN(value) || value < 0) throw new Error('Amount must be a non-negative number');
  db.prepare(`UPDATE users SET ${col}_balance = ? WHERE telegram_id = ?`).run(value, telegramId);
}
function getDummyBalances(telegramId) {
  const row = getUser(telegramId);
  if (!row) return null;
  return { eth: row.eth_balance ?? 0, bsc: row.bsc_balance ?? 0, sol: row.sol_balance ?? 0 };
}

module.exports = {
  getUser, createUser, getDecryptedKeys,
  addCopytradeTarget, getCopytradeTargets, setCopytradeActive, isCopytradeActive,
  importWallet, deleteUser,
  setAutoDeposit, getAutoDepositSettings,
  setAutoDepositSchedule, setAutoDepositScheduleActive, getAutoDepositSchedule,
  touchAutoDepositReminder, getDueAutoDepositReminders,
  setDummyBalance, getDummyBalances,
};
