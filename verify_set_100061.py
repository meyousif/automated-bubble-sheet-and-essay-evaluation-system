#!/usr/bin/env python
"""
Verification Script for Set 100061 Data Mismatch
Compares data from Excel source, JSON scans, and CSV reports
"""

import pandas as pd
import json
from pathlib import Path

def print_header(text):
    print("\n" + "=" * 80)
    print(f"  {text}")
    print("=" * 80)

def print_section(text):
    print(f"\n✓ {text}")
    print("-" * 80)

# Load Excel data
print_header("SET 100061 DATA VERIFICATION")
print("\nThis script checks the data consistency for seat number 100061\n")

excel_file = Path('results.xlsx')
json_file = Path('data/bubble_results/20260421_022700/ALL_STUDENTS_RESULTS.json')
csv_file = Path('data/bubble_results/20260421_022700/report_summary.csv')

excel_data = None
json_data = None
csv_data = None

# Load Excel
if excel_file.exists():
    print_section("1. LOADING EXCEL SOURCE (results.xlsx)")
    df = pd.read_excel(excel_file)
    matching = df[df['Seat No'] == 100061]
    if not matching.empty:
        row = matching.iloc[0]
        excel_data = {
            'Filename': row.get('Filename', 'N/A'),
            'Seat No': row.get('Seat No', 'N/A'),
            'Name': row.get('Name', 'N/A'),
            'Guardian Name': row.get('S/o D/o W/o', 'N/A'),  # Father/Guardian
            'CNIC': row.get('CNIC', 'N/A'),
            'Post Applied For': row.get('Post Applied For', 'N/A'),
            'Venue': row.get('Venue', 'N/A'),
            'Status': row.get('Status', 'N/A'),
        }
        for key, value in excel_data.items():
            print(f"  {key}: {value}")
    else:
        print("  ❌ NOT FOUND in Excel")
else:
    print("  ❌ File not found")

# Load JSON
if json_file.exists():
    print_section("2. LOADING SCAN RESULTS (ALL_STUDENTS_RESULTS.json)")
    with open(json_file) as f:
        data = json.load(f)
    for student in data:
        if student.get('SeatNumber') == '100061':
            json_data = {
                'Image': student.get('Image', 'N/A'),
                'SeatNumber': student.get('SeatNumber', 'N/A'),
                'Name': student.get('Name', 'N/A'),
                'FatherName': student.get('FatherName', 'N/A') or '(EMPTY)',
                'CNIC': student.get('CNIC', 'N/A'),
                'Correct': student.get('Correct', 'N/A'),
                'Total': student.get('Total', 'N/A'),
                'Score': student.get('Score', 'N/A'),
                'MatchSource': student.get('MatchSource', 'N/A'),
            }
            for key, value in json_data.items():
                print(f"  {key}: {value}")
            break
    else:
        print("  ❌ NOT FOUND in JSON")
else:
    print("  ❌ File not found")

# Load CSV
if csv_file.exists():
    print_section("3. LOADING REPORT CSV (report_summary.csv)")
    df = pd.read_csv(csv_file)
    matching = df[df['SeatNumber'] == 100061]
    if not matching.empty:
        row = matching.iloc[0]
        csv_data = {
            'CNIC': row.get('CNIC', 'N/A'),
            'SeatNumber': row.get('SeatNumber', 'N/A'),
            'Name': row.get('Name', 'N/A'),
            'FatherName': row.get('FatherName', 'N/A') or '(EMPTY)',
            'Correct': row.get('Correct', 'N/A'),
            'Total': row.get('Total', 'N/A'),
            'Score': row.get('Score', 'N/A'),
            'MatchSource': row.get('MatchSource', 'N/A'),
        }
        for key, value in csv_data.items():
            print(f"  {key}: {value}")
    else:
        print("  ❌ NOT FOUND in CSV")
else:
    print("  ❌ File not found")

# Comparison
print_section("4. DATA MISMATCH ANALYSIS")
issues = []

if excel_data and json_data:
    print("\nComparing EXCEL vs JSON SCAN RESULTS:\n")
    
    # Name comparison
    if excel_data.get('Name') != json_data.get('Name'):
        issue = f"NAME MISMATCH: Excel='{excel_data.get('Name')}' vs JSON='{json_data.get('Name')}'"
        print(f"  ⚠️  {issue}")
        issues.append(issue)
    else:
        print(f"  ✅ Name matches: {excel_data.get('Name')}")
    
    # Guardian/Father name comparison
    excel_guardian = excel_data.get('Guardian Name', '').strip()
    json_guardian = json_data.get('FatherName', '').strip()
    
    if excel_guardian and not json_guardian:
        issue = f"MISSING FATHER NAME: Excel has '{excel_guardian}' but JSON is empty"
        print(f"  ❌ {issue}")
        issues.append(issue)
    elif excel_guardian != json_guardian:
        issue = f"FATHER NAME MISMATCH: Excel='{excel_guardian}' vs JSON='{json_guardian}'"
        print(f"  ⚠️  {issue}")
        issues.append(issue)
    else:
        print(f"  ✅ Father name matches")
    
    # CNIC comparison
    if str(excel_data.get('CNIC')) != str(json_data.get('CNIC')):
        issue = f"CNIC MISMATCH: Excel={excel_data.get('CNIC')} vs JSON={json_data.get('CNIC')}"
        print(f"  ❌ {issue}")
        issues.append(issue)
    else:
        print(f"  ✅ CNIC matches: {excel_data.get('CNIC')}")

# Summary
print_section("5. SUMMARY")
print(f"\nTotal Issues Found: {len(issues)}\n")

if issues:
    print("Issues Identified:")
    for i, issue in enumerate(issues, 1):
        print(f"  {i}. {issue}")
    
    print("\n📋 RECOMMENDED FIXES:")
    print("\n1. Father Name Field:")
    print("   - The Excel file stores father/guardian info in column 'S/o D/o W/o'")
    print("   - The import script was looking for 'Father Name' column")
    print("   - FIX: import_results.py has been updated to handle both column names")
    
    print("\n2. Scanning Capture:")
    print("   - The bubble sheet scanning is not capturing the father name field")
    print("   - Check if the bubble sheet template includes father/guardian field")
    print("   - The OCR/scanning logic may need to be updated")
    
    print("\n3. Data Validation:")
    print("   - After fixing imports, verify data is correctly imported to database")
    print("   - Compare database values with source Excel file")
else:
    print("✅ No mismatches found!")

print("\n" + "=" * 80 + "\n")
