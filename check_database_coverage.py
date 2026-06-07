#!/usr/bin/env python
"""
Database Data Availability Check
Check if the 10 unmatched images have data in database
"""

import sqlite3
import json
from pathlib import Path

def print_header(text):
    print("\n" + "=" * 80)
    print(f"  {text}")
    print("=" * 80)

# Load the JSON data
json_file = Path('data/bubble_results/20260421_022700/ALL_STUDENTS_RESULTS.json')

if not json_file.exists():
    print("❌ JSON file not found")
    exit(1)

print_header("DATABASE DATA AVAILABILITY CHECK")

with open(json_file) as f:
    json_data = json.load(f)

# Get seat numbers from JSON
scanned_seats = [str(s.get('SeatNumber', '')) for s in json_data if s.get('SeatNumber')]
print(f"\n📊 Scanned records in JSON: {len(scanned_seats)}")
print(f"Seats: {sorted(scanned_seats)}")

# Check database
print_header("CHECKING DATABASE")

try:
    conn = sqlite3.connect('data.db')
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Check if database has tables
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [row[0] for row in cursor.fetchall()]
    
    if not tables:
        print("\n❌ DATABASE IS EMPTY - No tables found!")
        print("\nStatus:")
        print("  ✗ student_registry table: NOT FOUND")
        print("  ✗ Any scan data: NOT FOUND")
        print("\nConclusion:")
        print("  The database is currently EMPTY. No student data has been imported yet.")
        conn.close()
    else:
        print(f"\n✅ Found tables: {tables}")
        
        # Check student_registry table
        if 'student_registry' in tables:
            cursor.execute("SELECT COUNT(*) FROM student_registry")
            count = cursor.fetchone()[0]
            print(f"\n✅ student_registry table found")
            print(f"   Records in database: {count}")
            
            if count > 0:
                # Get all seat numbers in database
                cursor.execute("SELECT DISTINCT seat_no FROM student_registry ORDER BY seat_no")
                db_seats = [str(row[0]) for row in cursor.fetchall()]
                print(f"   Seat numbers in database: {db_seats}")
                
                # Compare with scanned seats
                print_header("COMPARISON: SCANNED vs DATABASE")
                
                print(f"\n✅ Scanned records: {len(scanned_seats)}")
                for seat in sorted(scanned_seats):
                    status = "✓" if seat in db_seats else "✗"
                    print(f"   {status} Seat {seat}")
                
                print(f"\n📊 Database records: {len(db_seats)}")
                print(f"   Total: {len(db_seats)} records")
                
                # Check which scanned records are in database
                in_database = [s for s in scanned_seats if s in db_seats]
                not_in_database = [s for s in scanned_seats if s not in db_seats]
                
                print_header("RESULTS")
                print(f"\n✅ Records in both (scanned AND database): {len(in_database)}")
                for seat in sorted(in_database):
                    print(f"   ✓ {seat}")
                
                print(f"\n❌ Records NOT in database (only scanned, not in DB): {len(not_in_database)}")
                for seat in sorted(not_in_database):
                    print(f"   ✗ {seat}")
                
                if not_in_database:
                    print("\n⚠️  These scanned records are MISSING from database!")
            else:
                print("   But table is EMPTY - no records yet")
        else:
            print("\n❌ student_registry table NOT found")
        
        conn.close()
        
except Exception as e:
    print(f"❌ Database error: {e}")

print("\n" + "=" * 80 + "\n")
