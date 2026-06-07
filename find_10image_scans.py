#!/usr/bin/env python
"""
Check all scan runs to find which ones have 10 images
"""

import json
from pathlib import Path

print("=" * 80)
print("CHECKING ALL SCAN RUNS FOR IMAGE COUNTS")
print("=" * 80)

bubble_results_dir = Path('data/bubble_results')
scan_runs = sorted([d for d in bubble_results_dir.iterdir() if d.is_dir()])

print(f"\nTotal scan runs: {len(scan_runs)}\n")

scans_with_10_images = []

for scan_dir in scan_runs:  # Check all scans
    json_file = scan_dir / "ALL_STUDENTS_RESULTS.json"
    
    if json_file.exists():
        try:
            with open(json_file) as f:
                data = json.load(f)
            
            count = len(data)
            print(f"📁 {scan_dir.name}: {count} images")
            
            if count == 10:
                scans_with_10_images.append({
                    'run': scan_dir.name,
                    'count': count,
                    'path': scan_dir
                })
        except Exception as e:
            print(f"❌ {scan_dir.name}: Error - {e}")
    else:
        print(f"⚠️  {scan_dir.name}: No JSON file")

print("\n" + "=" * 80)
if scans_with_10_images:
    print(f"\n🎯 Found {len(scans_with_10_images)} scan run(s) with exactly 10 images:\n")
    for item in scans_with_10_images:
        print(f"   📁 {item['run']} ({item['count']} images)")
else:
    print("\n❌ No scan runs with exactly 10 images found in recent runs")

print("\n" + "=" * 80 + "\n")
