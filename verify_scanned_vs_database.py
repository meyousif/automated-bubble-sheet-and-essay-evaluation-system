#!/usr/bin/env python
"""
Check if scanned records exist in database
Verify which records are matched and which are not
"""

import sqlite3
import json
from pathlib import Path

print("=" * 80)
print("CHECKING SCANNED IMAGES VS DATABASE")
print("=" * 80)

# Load scanned data
json_file = Path('data/bubble_results/20260421_022700/ALL_STUDENTS_RESULTS.json')

if not json_file.exists():
    print("❌ JSON file not found")
    exit(1)

with open(json_file) as f:
    json_data = json.load(f)

print(f"\n📊 Scanned images: {len(json_data)}\n")

# Connect to database
conn = sqlite3.connect('data/app.db')
conn.row_factory = sqlite3.Row
cursor = conn.cursor()

matched = 0
unmatched = 0
unmatched_list = []

print("Checking each scanned record in database:\n")

for idx, student in enumerate(json_data, 1):
    seat_no = str(student.get('SeatNumber', ''))
    name_from_scan = student.get('Name', '')
    
    # Search in database
    cursor.execute("""
        SELECT seat_no, name, cnic, father_name FROM student_registry 
        WHERE seat_no = ? LIMIT 1
    """, (seat_no,))
    
    db_record = cursor.fetchone()
    
    if db_record:
        print(f"✅ {idx}. Seat {seat_no}")
        print(f"    Scan Name:    {name_from_scan}")
        print(f"    DB Name:      {db_record['name']}")
        print(f"    DB CNIC:      {db_record['cnic']}")
        print(f"    DB Guardian:  {db_record['father_name'] or '(EMPTY)'}")
        matched += 1
    else:
        print(f"❌ {idx}. Seat {seat_no} - NOT FOUND in database")
        print(f"    Scan Name: {name_from_scan}")
        unmatched += 1
        unmatched_list.append({
            'seat': seat_no,
            'name': name_from_scan
        })
    print()

conn.close()

# Summary
print("=" * 80)
print("SUMMARY")
print("=" * 80)
print(f"\n✅ Matched (found in DB):    {matched}/{len(json_data)}")
print(f"❌ Unmatched (NOT in DB):    {unmatched}/{len(json_data)}")

if unmatched_list:
    print(f"\n📋 Unmatched Records:")
    for item in unmatched_list:
        print(f"   ❌ Seat {item['seat']} - {item['name']}")
    
    print(f"\n⚠️  These {unmatched} records need to be added to database!")
    print("\n💡 SOLUTION:")
    print("   Import Excel file with these seat numbers")
    print("   Or manually add them to database.db (candidates table)")

print("\n" + "=" * 80 + "\n")
