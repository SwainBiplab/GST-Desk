//! The desktop database: one SQLite connection owned by Rust.
//!
//! The browser build runs SQLite in a worker with a single connection, and every repository relies on
//! `BEGIN ... COMMIT` issued as separate statements landing on the same connection. The Tauri SQL
//! plugin pools connections, so it cannot promise that. This module is the same contract as the worker
//! (`exec(sql, params, method)` giving rows and column names) over one `rusqlite` connection behind a
//! mutex, so transactions, `foreign_keys` and the rest behave exactly as they do in the browser.
//!
//! Values cross the bridge as JSON. Numbers are numbers; an integer too large for a JavaScript number
//! is `{"$int": "123..."}` and a blob is `{"$blob": "<base64>"}`, in both directions.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rusqlite::{params_from_iter, types::Value, types::ValueRef, Connection};
use serde::Serialize;
use serde_json::{json, Value as Json};
use std::path::Path;
use std::sync::Mutex;

/// Open connections by name. `main` is the live database; a restore opens a second one, `staging`, to
/// build the new database beside it. Each is one connection, so a transaction stays on it.
#[derive(Default)]
pub struct DbState(pub Mutex<std::collections::HashMap<String, Connection>>);

pub const MAIN: &str = "main";

#[derive(Serialize, Debug, PartialEq)]
pub struct Rows {
    pub rows: Vec<Vec<Json>>,
    pub columns: Vec<String>,
}

const MAX_SAFE: i64 = 9_007_199_254_740_991;

fn to_sql(v: &Json) -> Result<Value, String> {
    Ok(match v {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Integer(i64::from(*b)),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Integer(i)
            } else if let Some(u) = n.as_u64() {
                i64::try_from(u)
                    .map(Value::Integer)
                    .unwrap_or(Value::Real(u as f64))
            } else {
                Value::Real(n.as_f64().ok_or("number out of range")?)
            }
        }
        Json::String(s) => Value::Text(s.clone()),
        Json::Object(o) => {
            if let Some(Json::String(b)) = o.get("$blob") {
                Value::Blob(B64.decode(b).map_err(|e| format!("bad blob: {e}"))?)
            } else if let Some(Json::String(i)) = o.get("$int") {
                Value::Integer(i.parse::<i64>().map_err(|e| format!("bad integer: {e}"))?)
            } else {
                return Err("unsupported parameter object".into());
            }
        }
        Json::Array(_) => return Err("unsupported parameter array".into()),
    })
}

fn from_sql(v: ValueRef<'_>) -> Json {
    match v {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(i) if i.abs() <= MAX_SAFE => json!(i),
        ValueRef::Integer(i) => json!({ "$int": i.to_string() }),
        ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(Json::Number)
            .unwrap_or(Json::Null),
        ValueRef::Text(t) => Json::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => json!({ "$blob": B64.encode(b) }),
    }
}

/// Open (creating the folder and the file if needed) and set the connection up the way the browser's is.
pub fn open_connection(path: &Path) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Run one statement. `method` is `run` (no rows wanted), `all` / `values` (every row) or `get` (the first).
pub fn exec(conn: &Connection, sql: &str, params: &[Json], method: &str) -> Result<Rows, String> {
    let bound: Vec<Value> = params.iter().map(to_sql).collect::<Result<_, _>>()?;
    if method == "run" && bound.is_empty() {
        // a script such as a migration, or a trigger body with semicolons inside it
        conn.execute_batch(sql).map_err(|e| e.to_string())?;
        return Ok(Rows {
            rows: vec![],
            columns: vec![],
        });
    }
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let columns: Vec<String> = stmt
        .column_names()
        .iter()
        .map(|c| (*c).to_string())
        .collect();
    let n = columns.len();
    let mut rows_iter = stmt
        .query(params_from_iter(bound.iter()))
        .map_err(|e| e.to_string())?;
    let mut rows: Vec<Vec<Json>> = Vec::new();
    while let Some(row) = rows_iter.next().map_err(|e| e.to_string())? {
        if method == "run" {
            continue; // a statement that returns rows (RETURNING) run for its effect
        }
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            out.push(from_sql(row.get_ref(i).map_err(|e| e.to_string())?));
        }
        rows.push(out);
        if method == "get" {
            break;
        }
    }
    if method == "run" {
        return Ok(Rows {
            rows: vec![],
            columns: vec![],
        });
    }
    Ok(Rows { rows, columns })
}

fn name_of(id: Option<String>) -> String {
    id.filter(|s| !s.is_empty())
        .unwrap_or_else(|| MAIN.to_string())
}

#[tauri::command(async)]
pub fn db_open(
    state: tauri::State<'_, DbState>,
    path: String,
    id: Option<String>,
) -> Result<String, String> {
    let conn = open_connection(Path::new(&path))?;
    let version: String = conn
        .query_row("select sqlite_version()", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    state
        .0
        .lock()
        .map_err(|_| "database lock poisoned")?
        .insert(name_of(id), conn);
    Ok(version)
}

#[tauri::command(async)]
pub fn db_exec(
    state: tauri::State<'_, DbState>,
    sql: String,
    params: Vec<Json>,
    method: String,
    id: Option<String>,
) -> Result<Rows, String> {
    let guard = state.0.lock().map_err(|_| "database lock poisoned")?;
    let conn = guard.get(&name_of(id)).ok_or("the database is not open")?;
    exec(conn, &sql, &params, &method)
}

/// Close one connection (checkpointing it, so the file holds everything and can be copied whole).
pub fn close_named(state: &DbState, id: &str) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "database lock poisoned")?;
    if let Some(conn) = guard.remove(id) {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
        conn.close().map_err(|(_, e)| e.to_string())?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn db_close(state: tauri::State<'_, DbState>, id: Option<String>) -> Result<(), String> {
    close_named(&state, &name_of(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(name: &str) -> (std::path::PathBuf, Connection) {
        let dir = std::env::temp_dir().join(format!("gstdesk-db-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("data").join("t.db");
        let conn = open_connection(&path).unwrap();
        (dir, conn)
    }

    fn all(conn: &Connection, sql: &str, p: &[Json]) -> Rows {
        exec(conn, sql, p, "all").unwrap()
    }

    #[test]
    fn a_transaction_issued_as_separate_calls_shares_one_connection() {
        let (dir, c) = temp_db("tx");
        exec(
            &c,
            "create table t (id integer primary key, v text)",
            &[],
            "run",
        )
        .unwrap();
        exec(&c, "begin", &[], "run").unwrap();
        exec(&c, "insert into t (v) values (?)", &[json!("a")], "run").unwrap();
        exec(&c, "rollback", &[], "run").unwrap();
        assert!(all(&c, "select * from t", &[]).rows.is_empty());
        exec(&c, "begin", &[], "run").unwrap();
        exec(&c, "insert into t (v) values (?)", &[json!("b")], "run").unwrap();
        exec(&c, "commit", &[], "run").unwrap();
        assert_eq!(all(&c, "select v from t", &[]).rows, vec![vec![json!("b")]]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn two_named_connections_are_separate_and_closing_one_leaves_the_other() {
        let state = DbState::default();
        let (d1, c1) = temp_db("named1");
        let (d2, c2) = temp_db("named2");
        {
            let mut g = state.0.lock().unwrap();
            g.insert(MAIN.into(), c1);
            g.insert("staging".into(), c2);
        }
        {
            let g = state.0.lock().unwrap();
            exec(&g[MAIN], "create table t (v)", &[], "run").unwrap();
            assert!(exec(&g["staging"], "select * from t", &[], "all").is_err());
        }
        close_named(&state, "staging").unwrap();
        assert!(state.0.lock().unwrap().contains_key(MAIN));
        assert!(!state.0.lock().unwrap().contains_key("staging"));
        close_named(&state, "never-opened").unwrap();
        let _ = std::fs::remove_dir_all(d1);
        let _ = std::fs::remove_dir_all(d2);
    }

    #[test]
    fn foreign_keys_are_enforced_like_in_the_browser() {
        let (dir, c) = temp_db("fk");
        exec(&c, "create table p (id integer primary key)", &[], "run").unwrap();
        exec(
            &c,
            "create table k (p integer references p(id))",
            &[],
            "run",
        )
        .unwrap();
        assert!(exec(&c, "insert into k values (?)", &[json!(9)], "run").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn full_text_search_is_there() {
        let (dir, c) = temp_db("fts");
        exec(
            &c,
            "create virtual table f using fts5(name, tokenize='unicode61 remove_diacritics 2')",
            &[],
            "run",
        )
        .unwrap();
        exec(
            &c,
            "insert into f (name) values (?)",
            &[json!("शर्मा traders")],
            "run",
        )
        .unwrap();
        let r = all(
            &c,
            "select name from f where f match ?",
            &[json!("\"tra\"*")],
        );
        assert_eq!(r.rows.len(), 1);
        let r = all(
            &c,
            "select name from f where f match ?",
            &[json!("\"शर्मा\"*")],
        );
        assert_eq!(r.rows.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn big_integers_and_blobs_survive_the_trip() {
        let (dir, c) = temp_db("types");
        exec(
            &c,
            "create table t (n integer, b blob, r real, s text, z)",
            &[],
            "run",
        )
        .unwrap();
        let big = "9223372036854775807";
        exec(
            &c,
            "insert into t values (?, ?, ?, ?, ?)",
            &[
                json!({"$int": big}),
                json!({"$blob": B64.encode([0u8, 1, 255])}),
                json!(1.5),
                json!("x"),
                Json::Null,
            ],
            "run",
        )
        .unwrap();
        let r = all(&c, "select n, b, r, s, z from t", &[]);
        assert_eq!(r.columns, vec!["n", "b", "r", "s", "z"]);
        assert_eq!(r.rows[0][0], json!({"$int": big}));
        assert_eq!(r.rows[0][1], json!({"$blob": B64.encode([0u8, 1, 255])}));
        assert_eq!(r.rows[0][2], json!(1.5));
        assert_eq!(r.rows[0][4], Json::Null);
        // an ordinary integer is a plain number
        exec(&c, "insert into t (n) values (?)", &[json!(12345)], "run").unwrap();
        assert_eq!(
            all(&c, "select n from t where n = 12345", &[]).rows[0][0],
            json!(12345)
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn get_returns_one_row_and_run_ignores_rows() {
        let (dir, c) = temp_db("get");
        exec(&c, "create table t (v integer)", &[], "run").unwrap();
        for i in 0..3 {
            exec(&c, "insert into t values (?)", &[json!(i)], "run").unwrap();
        }
        assert_eq!(
            exec(&c, "select v from t order by v", &[], "get")
                .unwrap()
                .rows
                .len(),
            1
        );
        // RETURNING through `run` is executed and its rows dropped
        let r = exec(
            &c,
            "insert into t values (?) returning v",
            &[json!(7)],
            "run",
        )
        .unwrap();
        assert!(r.rows.is_empty());
        assert_eq!(all(&c, "select count(*) from t", &[]).rows[0][0], json!(4));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_script_with_a_trigger_body_runs_as_one_statement() {
        let (dir, c) = temp_db("script");
        exec(
            &c,
            "create table t (v integer); create table log (v integer)",
            &[],
            "run",
        )
        .unwrap();
        exec(
            &c,
            "create trigger t_ai after insert on t begin insert into log values (new.v); insert into log values (new.v + 1); end",
            &[],
            "run",
        )
        .unwrap();
        exec(&c, "insert into t values (?)", &[json!(1)], "run").unwrap();
        assert_eq!(
            all(&c, "select count(*) from log", &[]).rows[0][0],
            json!(2)
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bad_parameters_and_bad_sql_are_errors_not_panics() {
        let (dir, c) = temp_db("bad");
        assert!(exec(&c, "select ?", &[json!([1])], "all").is_err());
        assert!(exec(&c, "select ?", &[json!({"x": 1})], "all").is_err());
        assert!(exec(&c, "selec 1", &[], "all").is_err());
        assert!(exec(&c, "select ?", &[json!({"$blob": "!!"})], "all").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
