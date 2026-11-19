const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', process.env.DB_FILE || 'officer-service.db');

let db;
let SQL;
let batching = 0;

// Opens a separate, in-memory database from an uploaded file (used by the import page).
async function openDatabase(buffer) {
  SQL = SQL || await initSqlJs();
  return new SQL.Database(buffer);
}

function rawRows(handle, sql, params = []) {
  const stmt = handle.prepare(sql);
  stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

async function getDb() {
  if (db) return db;
  SQL = SQL || await initSqlJs();
  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  require('./core/schema').initCoreSchema(db);
  save();
  return db;
}

function save() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function run(sql, params = []) {
  db.run(sql, params);
  if (!batching) save();
}

// Runs fn inside one SQL transaction and writes the file once at the end.
function transaction(fn) {
  batching++;
  db.run('BEGIN');
  try {
    const result = fn();
    db.run('COMMIT');
    return result;
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  } finally {
    batching--;
    if (!batching) save();
  }
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function lastId() {
  return get('SELECT last_insert_rowid() AS id').id;
}

module.exports = { getDb, save, run, get, all, transaction, lastId, openDatabase, rawRows, DB_PATH };
