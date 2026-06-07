import sqlite3
from pathlib import Path

# Check app.db
app_db = Path('data/app.db')
if app_db.exists():
    print('=' * 60)
    print('CHECKING data/app.db')
    print('=' * 60)
    conn = sqlite3.connect(str(app_db))
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [row[0] for row in cursor.fetchall()]
    print(f'Tables: {tables}')
    
    if 'student_registry' in tables:
        cursor.execute('SELECT COUNT(*) FROM student_registry')
        count = cursor.fetchone()[0]
        print(f'student_registry records: {count}')
        
        # Show sample
        cursor.execute('SELECT seat_no, name, cnic FROM student_registry LIMIT 5')
        print('\nSample records:')
        for row in cursor.fetchall():
            print(f'  Seat: {row[0]}, Name: {row[1]}, CNIC: {row[2]}')
    
    conn.close()

# Check database.db
print()
db_db = Path('database.db')
if db_db.exists():
    print('=' * 60)
    print('CHECKING database.db')
    print('=' * 60)
    conn = sqlite3.connect(str(db_db))
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [row[0] for row in cursor.fetchall()]
    print(f'Tables: {tables}')
    
    if 'users' in tables:
        cursor.execute('SELECT COUNT(*) FROM users')
        count = cursor.fetchone()[0]
        print(f'users records: {count}')
    
    conn.close()
