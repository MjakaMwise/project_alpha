//! A small common SQL interface for the embedded SQLite and server PostgreSQL stores.
//! Values stay bound parameters; PostgreSQL runs on a dedicated worker thread.
use rusqlite::{
    Result, ToSql,
    types::{FromSql, ToSqlOutput, Value, ValueRef},
};
use std::{cell::Cell, path::Path};

#[derive(Clone)]
pub struct Param {
    value: Value,
    kind: &'static str,
}
pub trait Bind {
    const KIND: &'static str;
    fn param(&self) -> Param;
}
macro_rules! bind {
    ($kind:literal; $($t:ty),*) => {$(impl Bind for $t {
        const KIND: &'static str = $kind;
        fn param(&self) -> Param { Param { value: match self.to_sql().expect("SQL value") {
            ToSqlOutput::Borrowed(v) => v.into(), ToSqlOutput::Owned(v) => v, _ => unreachable!()
        }, kind: $kind } }
    })*};
}
bind!("BIGINT"; i64, i32, u32);
bind!("DOUBLE PRECISION"; f64);
bind!("TEXT"; String, str);
impl<T: Bind + ?Sized> Bind for &T {
    const KIND: &'static str = T::KIND;
    fn param(&self) -> Param {
        (*self).param()
    }
}
impl<T: Bind> Bind for Option<T> {
    const KIND: &'static str = T::KIND;
    fn param(&self) -> Param {
        // Preserve the type of NULL without constructing a dummy T.
        match self {
            Some(v) => v.param(),
            None => Param {
                value: Value::Null,
                kind: T::KIND,
            },
        }
    }
}
macro_rules! params { ($($v:expr),* $(,)?) => { vec![$($crate::database::Bind::param(&$v)),*] }; }
pub(crate) use params;
pub trait Params {
    fn values(self) -> Vec<Param>;
}
impl Params for Vec<Param> {
    fn values(self) -> Vec<Param> {
        self
    }
}
impl Params for [(); 0] {
    fn values(self) -> Vec<Param> {
        vec![]
    }
}
impl<T: Bind> Params for [T; 1] {
    fn values(self) -> Vec<Param> {
        self.iter().map(Bind::param).collect()
    }
}

pub struct Row {
    names: Vec<String>,
    values: Vec<Value>,
}
pub trait Index {
    fn index(self, row: &Row) -> Result<usize>;
}
impl Index for usize {
    fn index(self, row: &Row) -> Result<usize> {
        if self < row.values.len() {
            Ok(self)
        } else {
            Err(rusqlite::Error::InvalidColumnIndex(self))
        }
    }
}
impl Index for &str {
    fn index(self, row: &Row) -> Result<usize> {
        row.names
            .iter()
            .position(|n| n == self)
            .ok_or_else(|| rusqlite::Error::InvalidColumnName(self.into()))
    }
}
impl Row {
    pub fn get<I: Index, T: FromSql>(&self, index: I) -> Result<T> {
        let i = index.index(self)?;
        T::column_result(ValueRef::from(&self.values[i])).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(i, self.values[i].data_type(), Box::new(e))
        })
    }
}
enum Backend {
    Sqlite(rusqlite::Connection),
    #[cfg(not(target_os = "android"))]
    Postgres(pg::Worker),
}
pub struct Connection {
    backend: Backend,
    last_id: Cell<i64>,
}
impl Connection {
    pub fn open(path: &Path) -> Result<Self> {
        Ok(Self {
            backend: Backend::Sqlite(rusqlite::Connection::open(path)?),
            last_id: Cell::new(0),
        })
    }
    #[cfg(not(target_os = "android"))]
    pub fn postgres(url: &str) -> Result<Self> {
        Ok(Self {
            backend: Backend::Postgres(pg::Worker::connect(url)?),
            last_id: Cell::new(0),
        })
    }
    pub fn execute_batch(&self, sql: &str) -> Result<()> {
        match &self.backend {
            Backend::Sqlite(c) => c.execute_batch(sql),
            #[cfg(not(target_os = "android"))]
            Backend::Postgres(w) => w.batch(sql),
        }
    }
    fn run(&self, sql: &str, values: Vec<Param>, write: bool) -> Result<(usize, Vec<Row>)> {
        match &self.backend {
            Backend::Sqlite(c) => {
                let mut stmt = c.prepare(sql)?;
                let values: Vec<Value> = values.into_iter().map(|p| p.value).collect();
                if write {
                    let n = stmt.execute(rusqlite::params_from_iter(values))?;
                    self.last_id.set(c.last_insert_rowid());
                    return Ok((n, vec![]));
                }
                let names: Vec<String> =
                    stmt.column_names().iter().map(|n| n.to_string()).collect();
                let rows = stmt
                    .query_map(rusqlite::params_from_iter(values), |r| {
                        Ok(Row {
                            names: names.clone(),
                            values: (0..names.len()).map(|i| r.get(i)).collect::<Result<_>>()?,
                        })
                    })?
                    .collect::<Result<Vec<_>>>()?;
                Ok((rows.len(), rows))
            }
            #[cfg(not(target_os = "android"))]
            Backend::Postgres(w) => {
                let (n, rows, id) = w.run(sql, values, write)?;
                if let Some(id) = id {
                    self.last_id.set(id);
                }
                Ok((n, rows))
            }
        }
    }
    pub fn execute<P: Params>(&self, sql: &str, p: P) -> Result<usize> {
        Ok(self.run(sql, p.values(), true)?.0)
    }
    pub fn last_insert_rowid(&self) -> i64 {
        self.last_id.get()
    }
    pub fn query_row<P: Params, T, F: FnOnce(&Row) -> Result<T>>(
        &self,
        sql: &str,
        p: P,
        f: F,
    ) -> Result<T> {
        let (_, rows) = self.run(sql, p.values(), false)?;
        f(rows.first().ok_or(rusqlite::Error::QueryReturnedNoRows)?)
    }
    pub fn prepare(&self, sql: &str) -> Result<Statement<'_>> {
        Ok(Statement {
            conn: self,
            sql: sql.into(),
        })
    }
    pub fn prepare_cached(&self, sql: &str) -> Result<Statement<'_>> {
        self.prepare(sql)
    }
    pub fn transaction(&mut self) -> Result<Transaction<'_>> {
        self.execute_batch("BEGIN")?;
        Ok(Transaction {
            conn: self,
            committed: false,
        })
    }
}
pub struct Statement<'a> {
    conn: &'a Connection,
    sql: String,
}
impl Statement<'_> {
    pub fn query_map<P: Params, T, F: FnMut(&Row) -> Result<T>>(
        &mut self,
        p: P,
        mut f: F,
    ) -> Result<std::vec::IntoIter<Result<T>>> {
        Ok(self
            .conn
            .run(&self.sql, p.values(), false)?
            .1
            .iter()
            .map(&mut f)
            .collect::<Vec<_>>()
            .into_iter())
    }
}
pub struct Transaction<'a> {
    conn: &'a Connection,
    committed: bool,
}
impl std::ops::Deref for Transaction<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.conn
    }
}
impl Transaction<'_> {
    pub fn commit(mut self) -> Result<()> {
        self.conn.execute_batch("COMMIT")?;
        self.committed = true;
        Ok(())
    }
}
impl Drop for Transaction<'_> {
    fn drop(&mut self) {
        if !self.committed {
            let _ = self.conn.execute_batch("ROLLBACK");
        }
    }
}

#[cfg(not(target_os = "android"))]
mod pg {
    use super::*;
    use sqlx::{Column, Connection as _, Row as _, TypeInfo, ValueRef as _};
    use std::sync::mpsc;
    type Output = Result<(usize, Vec<Row>, Option<i64>)>;
    enum Request {
        Run(String, Vec<Param>, bool, mpsc::SyncSender<Output>),
        Batch(String, mpsc::SyncSender<Result<()>>),
    }
    pub struct Worker {
        sender: mpsc::Sender<Request>,
    }
    fn err(e: sqlx::Error) -> rusqlite::Error {
        if e.as_database_error()
            .and_then(|e| e.code())
            .is_some_and(|c| c == "23505")
        {
            return rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE),
                Some("Value already exists".into()),
            );
        }
        rusqlite::Error::ToSqlConversionFailure(Box::new(e))
    }
    fn channel_error() -> rusqlite::Error {
        rusqlite::Error::InvalidQuery
    }
    impl Worker {
        pub fn connect(url: &str) -> Result<Self> {
            let url = url.to_owned();
            let (sender, receiver) = mpsc::channel();
            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
            std::thread::spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(r) => r,
                    Err(e) => {
                        let _ = ready_tx
                            .send(Err(rusqlite::Error::ToSqlConversionFailure(Box::new(e))));
                        return;
                    }
                };
                runtime.block_on(async move {
                    let options = match url.parse::<sqlx::postgres::PgConnectOptions>() {
                        Ok(o) => o
                            .ssl_mode(sqlx::postgres::PgSslMode::VerifyFull)
                            .application_name("customize"),
                        Err(e) => {
                            let _ = ready_tx.send(Err(err(e)));
                            return;
                        }
                    };
                    let mut conn = match sqlx::PgConnection::connect_with(&options).await {
                        Ok(c) => c,
                        Err(e) => {
                            let _ = ready_tx.send(Err(err(e)));
                            return;
                        }
                    };
                    if let Err(e) = sqlx::raw_sql(
                        "SET search_path TO customize; SET statement_timeout TO '15s'",
                    )
                    .execute(&mut conn)
                    .await
                    {
                        let _ = ready_tx.send(Err(err(e)));
                        return;
                    }
                    let _ = ready_tx.send(Ok(()));
                    while let Ok(request) = receiver.recv() {
                        match request {
                            Request::Run(sql, values, write, reply) => {
                                let _ = reply.send(run(&mut conn, &sql, values, write).await);
                            }
                            Request::Batch(sql, reply) => {
                                let _ = reply.send(
                                    sqlx::raw_sql(&sql)
                                        .execute(&mut conn)
                                        .await
                                        .map(|_| ())
                                        .map_err(err),
                                );
                            }
                        }
                    }
                });
            });
            ready_rx.recv().map_err(|_| channel_error())??;
            Ok(Self { sender })
        }
        pub fn run(&self, sql: &str, values: Vec<Param>, write: bool) -> Output {
            let (tx, rx) = mpsc::sync_channel(1);
            self.sender
                .send(Request::Run(sql.into(), values, write, tx))
                .map_err(|_| channel_error())?;
            rx.recv().map_err(|_| channel_error())?
        }
        pub fn batch(&self, sql: &str) -> Result<()> {
            let (tx, rx) = mpsc::sync_channel(1);
            self.sender
                .send(Request::Batch(sql.into(), tx))
                .map_err(|_| channel_error())?;
            rx.recv().map_err(|_| channel_error())?
        }
    }
    pub(super) fn translate(sql: &str, values: &[Param]) -> String {
        let ignore = sql.contains("INSERT OR IGNORE");
        let mut sql = sql
            .replace("INSERT OR IGNORE", "INSERT")
            .replace("IFNULL(", "COALESCE(")
            .replace(" LIKE ", " ILIKE ");
        // These tables have explicit ordinal IDs in PostgreSQL; SQLite uses its rowid.
        sql = sql
            .replace("p.rowid", "p.id")
            .replace("position, rowid", "position, id")
            .replace("ORDER BY rowid", "ORDER BY id")
            .replace("at, rowid", "at, id");
        for i in (1..=values.len()).rev() {
            sql = sql.replace(
                &format!("?{i}"),
                &format!("(${i}::text::{})", values[i - 1].kind),
            );
        }
        if ignore {
            sql.push_str(" ON CONFLICT DO NOTHING");
        }
        sql
    }
    async fn run(
        conn: &mut sqlx::PgConnection,
        sql: &str,
        values: Vec<Param>,
        write: bool,
    ) -> Output {
        let mut sql = translate(sql, &values);
        let identity = write
            && [
                "INSERT INTO users ",
                "INSERT INTO shops ",
                "INSERT INTO orders ",
            ]
            .iter()
            .any(|s| sql.starts_with(s));
        if identity {
            sql.push_str(" RETURNING id");
        }
        let mut query = sqlx::query(&sql);
        for p in values {
            let value = match p.value {
                Value::Null => None,
                Value::Text(s) => Some(s),
                Value::Integer(n) => Some(n.to_string()),
                Value::Real(n) => Some(n.to_string()),
                _ => return Err(rusqlite::Error::InvalidQuery),
            };
            query = query.bind(value);
        }
        if write && !identity {
            return query
                .execute(conn)
                .await
                .map(|r| (r.rows_affected() as usize, vec![], None))
                .map_err(err);
        }
        let rows = query.fetch_all(conn).await.map_err(err)?;
        let id = if identity {
            rows.first()
                .map(|r| r.try_get::<i64, _>(0))
                .transpose()
                .map_err(err)?
        } else {
            None
        };
        let count = rows.len();
        let mut output = vec![];
        for row in rows {
            let mut values = vec![];
            let names = row.columns().iter().map(|c| c.name().to_string()).collect();
            for (i, col) in row.columns().iter().enumerate() {
                let v = if row.try_get_raw(i).map_err(err)?.is_null() {
                    Value::Null
                } else {
                    match col.type_info().name() {
                        "INT8" => Value::Integer(row.try_get(i).map_err(err)?),
                        "INT4" => Value::Integer(row.try_get::<i32, _>(i).map_err(err)? as i64),
                        "FLOAT8" => Value::Real(row.try_get(i).map_err(err)?),
                        _ => Value::Text(row.try_get(i).map_err(err)?),
                    }
                };
                values.push(v);
            }
            output.push(Row { names, values });
        }
        Ok((count, output, id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(not(target_os = "android"))]
    #[test]
    fn postgres_parameters_and_conflicts() {
        let sql = pg::translate(
            "INSERT OR IGNORE INTO orders (ref, shopper_key) VALUES (?1, ?2)",
            &params!["a'?", "shopper"],
        );
        assert_eq!(
            sql,
            "INSERT INTO orders (ref, shopper_key) VALUES (($1::text::TEXT), ($2::text::TEXT)) ON CONFLICT DO NOTHING"
        );
        assert!(!sql.contains("a'?"));
        let sql = pg::translate(
            "SELECT * FROM orders WHERE (?1 IS NULL OR user_id = ?1) AND ref LIKE ?2",
            &params![None::<i64>, "%A%"],
        );
        assert!(sql.contains("($1::text::BIGINT) IS NULL"));
        assert!(sql.contains("ILIKE ($2::text::TEXT)"));
        let values: Vec<Param> = (0..12i64).map(|n| n.param()).collect();
        let sql = pg::translate("SELECT ?1, ?12", &values);
        assert_eq!(sql, "SELECT ($1::text::BIGINT), ($12::text::BIGINT)");
    }
    #[test]
    fn rollback_and_typed_nullable_rows() {
        let path =
            std::env::temp_dir().join(format!("customize-db-unit-{}.sqlite", std::process::id()));
        let mut conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE values_test (id INTEGER PRIMARY KEY, name TEXT, amount REAL)",
        )
        .unwrap();
        {
            let tx = conn.transaction().unwrap();
            tx.execute(
                "INSERT INTO values_test VALUES (?1, ?2, ?3)",
                params![1i64, None::<String>, 0.5],
            )
            .unwrap();
        }
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM values_test", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let tx = conn.transaction().unwrap();
        tx.execute(
            "INSERT INTO values_test VALUES (?1, ?2, ?3)",
            params![1i64, None::<String>, 0.5],
        )
        .unwrap();
        tx.commit().unwrap();
        let (name, amount): (Option<String>, f64) = conn
            .query_row("SELECT * FROM values_test", [], |r| {
                Ok((r.get("name")?, r.get("amount")?))
            })
            .unwrap();
        assert_eq!(name, None);
        assert_eq!(amount, 0.5);
        assert_eq!(None::<i64>.param().kind, "BIGINT");
        drop(conn);
        let _ = std::fs::remove_file(path);
    }
}
