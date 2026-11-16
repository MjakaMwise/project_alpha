#!/usr/bin/env python3
"""Back up and import a stopped Customize SQLite database into empty PostgreSQL tables."""
import argparse
import datetime
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

TABLES = ('meta', 'users', 'sessions', 'shops', 'products', 'shoppers', 'orders', 'order_items', 'order_events')

def literal(value):
    if value is None:
        return 'NULL'
    if isinstance(value, (int, float)):
        return str(value)
    if '\x00' in value:
        raise ValueError('PostgreSQL text cannot contain NUL bytes')
    return "'" + value.replace("'", "''") + "'"

def export_sql(db):
    emails = [r[0].lower() for r in db.execute('SELECT email FROM users')]
    if len(emails) != len(set(emails)):
        raise ValueError('Duplicate emails after normalization; resolve them before import')
    lines = ['BEGIN;', 'SET LOCAL search_path TO customize;', 'SET LOCAL standard_conforming_strings TO on;',
             "SELECT pg_advisory_xact_lock(176161, 1);",
             'LOCK TABLE ' + ', '.join(TABLES) + ' IN ACCESS EXCLUSIVE MODE;']
    for table in TABLES:
        lines.append(f"DO $$ BEGIN IF EXISTS (SELECT 1 FROM {table}) THEN RAISE EXCEPTION 'Destination {table} must be empty'; END IF; END $$;")
    counts = {}
    for table in TABLES:
        cols = [r[1] for r in db.execute(f'PRAGMA table_info({table})')]
        if not cols:
            raise ValueError(f'Missing SQLite table: {table}. Start the existing SQLite app once to initialize it.')
        counts[table] = 0
        quoted = ', '.join('"' + c + '"' for c in cols)
        for row in db.execute(f'SELECT {quoted} FROM {table} ORDER BY rowid'):
            values = list(row)
            if table == 'users':
                values[cols.index('email')] = values[cols.index('email')].lower()
            lines.append(f'INSERT INTO {table} ({quoted}) VALUES ({", ".join(map(literal, values))});')
            counts[table] += 1
    for table in ('users', 'shops', 'orders', 'order_items', 'order_events'):
        lines.append(f"SELECT setval(pg_get_serial_sequence('customize.{table}', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM {table};")
    for table, count in counts.items():
        lines.append(f"DO $$ BEGIN IF (SELECT COUNT(*) FROM {table}) <> {count} THEN RAISE EXCEPTION 'Row count mismatch: {table}'; END IF; END $$;")
    lines.append('COMMIT;')
    return '\n'.join(lines), counts

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path('data/customize.db'))
    args = parser.parse_args()
    url = os.environ.get('CUSTOMIZE_DATABASE_URL')
    if not url:
        sys.exit('Set CUSTOMIZE_DATABASE_URL in the server environment first.')
    parts = urlsplit(url)
    if parts.scheme not in ('postgres', 'postgresql') or not parts.hostname:
        sys.exit('Expected a PostgreSQL connection URL.')
    query = dict(parse_qsl(parts.query))
    query['sslmode'] = 'verify-full'
    url = urlunsplit(parts._replace(query=urlencode(query)))
    # SQLite backup API makes a consistent snapshot, including WAL contents.
    source = sqlite3.connect(args.source.resolve().as_uri() + '?mode=ro', uri=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = args.source.with_name(args.source.name + '.' + stamp + '.backup')
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    snapshot = sqlite3.connect(backup)
    source.backup(snapshot)
    source.close()
    sql, counts = export_sql(snapshot)
    snapshot.close()
    env = dict(os.environ, PGDATABASE=url, PGCONNECT_TIMEOUT='15')
    # SQL and credentials go through stdin/environment; never print rows or connection strings.
    result = subprocess.run(['psql', '-X', '-q', '--set', 'ON_ERROR_STOP=1'], input=sql, text=True,
                            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    print(f'Consistent SQLite backup: {backup}')
    if result.returncode:
        # psql may include customer fields in error context. Keep those out of terminal output.
        sys.exit('Import failed; the transaction was rolled back. Check connectivity, credentials, schema, and that destination tables are empty.')
    print('Verified imported row counts: ' + ', '.join(f'{k}={v}' for k, v in counts.items()))

if __name__ == '__main__':
    main()
