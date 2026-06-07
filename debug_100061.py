import sqlite3
import json
from pathlib import Path

# Check database
print("=" * 60)
print("CHECKING DATABASE FOR SEAT 100061")
print("=" * 60)

try:
    conn = sqlite3.connect('data.db')
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Get all tables
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [row[0] for row in cursor.fetchall()]
    print(f"\nTables in database: {tables}")
    
    # Check all tables that might have student data
    for table in tables:
        cursor.execute(f"SELECT * FROM {table} WHERE seat_no LIKE '%100061%' OR cnic LIKE '%4200024141102%'")
        rows = cursor.fetchall()
        if rows:
            print(f"\n--- Found in table: {table} ---")
            for row in rows:
                print(dict(row))
    
    conn.close()
except Exception as e:
    print(f"Database error: {e}")

# Check JSON results
print("\n" + "=" * 60)
print("CHECKING JSON RESULTS FOR SEAT 100061")
print("=" * 60)

json_file = Path('data/bubble_results/20260421_022700/ALL_STUDENTS_RESULTS.json')
if json_file.exists():
    try:
        with open(json_file) as f:
            data = json.load(f)
        
        for student in data:
            if student.get('SeatNumber') == '100061':
                print(f"\nJSON Record:")
                print(f"  CNIC: {student.get('CNIC')}")
                print(f"  Seat Number: {student.get('SeatNumber')}")
                print(f"  Name: {student.get('Name')}")
                print(f"  Father Name: {student.get('FatherName')}")
                print(f"  Correct: {student.get('Correct')}")
                print(f"  Score: {student.get('Score')}")
                print(f"  Total: {student.get('Total')}")
                print(f"  Match Source: {student.get('MatchSource')}")
                break
    except Exception as e:
        print(f"JSON error: {e}")

# Check CSV results
print("\n" + "=" * 60)
print("CHECKING CSV RESULTS FOR SEAT 100061")
print("=" * 60)

csv_file = Path('data/bubble_results/20260421_022700/report_summary.csv')
if csv_file.exists():
    try:
        with open(csv_file) as f:
            lines = f.readlines()
        
        print("CSV Header:", lines[0].strip())
        for line in lines[1:]:
            if '100061' in line:
                print(f"CSV Record: {line.strip()}")
    except Exception as e:
        print(f"CSV error: {e}")
