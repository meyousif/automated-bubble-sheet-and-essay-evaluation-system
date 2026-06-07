#!/usr/bin/env python
"""
Check all records for Father Name mismatches
Compare Excel source with JSON scan results
"""

import pandas as pd
import json
from pathlib import Path

print("=" * 80)
print("CHECKING ALL RECORDS FOR FATHER NAME MISMATCHES")
print("=" * 80)

# Load files
excel_file = Path('results.xlsx')
json_file = Path('data/bubble_results/20260421_022700/ALL_STUDENTS_RESULTS.json')

if not excel_file.exists() or not json_file.exists():
    print("❌ Required files not found")
    exit(1)

# Load data
excel_df = pd.read_excel(excel_file)
with open(json_file) as f:
    json_data = json.load(f)

print(f"\n📊 Total records in Excel: {len(excel_df)}")
print(f"📊 Total records in JSON: {len(json_data)}")

# Create mapping
json_map = {str(s.get('SeatNumber')): s for s in json_data}

print("\n" + "=" * 80)
print("COMPARISON RESULTS")
print("=" * 80)

mismatches = []
missing_in_json = []
matches = []

for idx, row in excel_df.iterrows():
    seat_no = str(row.get('Seat No', ''))
    excel_guardian = str(row.get('S/o D/o W/o', '')).strip()
    excel_name = row.get('Name', '')
    
    if seat_no in json_map:
        json_record = json_map[seat_no]
        json_guardian = str(json_record.get('FatherName', '')).strip()
        json_name = json_record.get('Name', '')
        
        # Check if guardian names match
        if excel_guardian and not json_guardian:
            mismatches.append({
                'seat': seat_no,
                'name': excel_name,
                'excel_guardian': excel_guardian,
                'json_guardian': '(EMPTY)',
                'issue': 'Missing in JSON'
            })
        elif excel_guardian != json_guardian:
            mismatches.append({
                'seat': seat_no,
                'name': excel_name,
                'excel_guardian': excel_guardian,
                'json_guardian': json_guardian,
                'issue': 'Mismatch'
            })
        else:
            matches.append(seat_no)
    else:
        missing_in_json.append({'seat': seat_no, 'name': excel_name})

# Report
print(f"\n✅ MATCHES: {len(matches)}")
print(f"⚠️  MISMATCHES: {len(mismatches)}")
print(f"❌ MISSING IN JSON: {len(missing_in_json)}")

if mismatches:
    print("\n" + "=" * 80)
    print("MISMATCH DETAILS")
    print("=" * 80)
    
    for i, item in enumerate(mismatches, 1):
        print(f"\n{i}. Seat {item['seat']} - {item['name']}")
        print(f"   Excel Guardian:  {item['excel_guardian']}")
        print(f"   JSON Guardian:   {item['json_guardian']}")
        print(f"   Issue:           {item['issue']}")

if missing_in_json:
    print("\n" + "=" * 80)
    print("MISSING IN JSON (Not scanned)")
    print("=" * 80)
    
    for item in missing_in_json:
        print(f"  • Seat {item['seat']} - {item['name']}")

print("\n" + "=" * 80)
print("SUMMARY")
print("=" * 80)
print(f"""
📋 Analysis Results:
   - Records with matching guardian data: {len(matches)}
   - Records with mismatched guardian data: {len(mismatches)}
   - Records not in JSON scans: {len(missing_in_json)}

⚠️  RECOMMENDATION:
   If there are many mismatches, the issue is likely:
   1. Scanning is not capturing father/guardian field
   2. Father name is not in the bubble sheet template
   3. Need to update scanning logic to extract this field

🔧 ACTION:
   - Use import_results.py to re-import Excel data (now fixed)
   - Review bubble sheet scanning logic
   - Update scanning if father name field exists on form but not being read
""")

print("=" * 80 + "\n")
