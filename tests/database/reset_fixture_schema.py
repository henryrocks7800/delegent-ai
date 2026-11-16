"""Return the disposable fixture database to an empty public schema.

Each SQL suite builds the minimal relational fixture it needs and refuses to
run against a non-empty public schema, which is the guard that keeps them off
anything real. Running two suites in one job therefore needs this between them.

It will not run anywhere except the named loopback fixture database, for the
same reason the suites will not.
"""
import os
import psycopg

ROLES = ['anon', 'authenticated', 'service_role']

if os.environ.get('PGHOST') != '127.0.0.1' or os.environ.get('PGDATABASE') != 'delegent_review_test':
    raise RuntimeError('This resets only the named disposable loopback database')

with psycopg.connect(host='127.0.0.1', dbname='delegent_review_test', autocommit=True) as conn:
    with conn.cursor() as cursor:
        cursor.execute('drop schema if exists auth cascade')
        cursor.execute('drop schema public cascade')
        cursor.execute('create schema public')
        for role in ROLES:
            cursor.execute(f'drop role if exists {role}')
print('fixture schema reset')
