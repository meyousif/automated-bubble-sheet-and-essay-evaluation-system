"""
Script to import student results from Excel file to database
"""
import pandas as pd
import sqlite3
from pathlib import Path
from app.db import get_connection
from app.security import now_utc
from datetime import datetime

def import_results_from_excel(excel_file_path, user="system"):
    """
    Import student results from Excel file to database
    
    Args:
        excel_file_path: Path to the Excel file (results.xlsx)
        user: Username performing the import (default: "system")
    
    Returns:
        dict: Summary of import results
    """
    
    excel_path = Path(excel_file_path)
    
    if not excel_path.exists():
        return {"success": False, "error": f"File not found: {excel_file_path}"}
    
    try:
        # Read Excel file
        df = pd.read_excel(excel_path)
        
        print(f"Columns found in Excel: {df.columns.tolist()}")
        print(f"Total rows to import: {len(df)}")
        print(f"Preview:\n{df.head()}")
        
        # Connect to database
        conn = get_connection()
        cursor = conn.cursor()
        
        inserted = 0
        updated = 0
        skipped = 0
        errors = []
        
        for idx, row in df.iterrows():
            try:
                # Map Excel columns to database fields
                cnic = str(row.get('CNIC', '') or '').strip()
                seat_no = str(row.get('Seat No', '') or '').strip()
                name = str(row.get('Name', '') or '').strip()
                
                # Handle different column names for father/guardian name
                # Try 'Father Name' first, then 'S/o D/o W/o' (Son of/Daughter of/Wife of)
                father_name = str(row.get('Father Name', '') or '').strip()
                if not father_name:
                    father_name = str(row.get('S/o D/o W/o', '') or '').strip()
                
                score = row.get('Score', None)
                status = str(row.get('Status', 'Pass') or 'Pass').strip()
                post_applied = str(row.get('Post Applied For', '') or row.get('Post Applied', '') or '').strip()
                venue = str(row.get('Venue', '') or '').strip()
                
                # Normalize CNIC (remove spaces and dashes)
                cnic_norm = cnic.replace('-', '').replace(' ', '') if cnic else None
                
                # Convert score to float
                try:
                    score = float(score) if score and str(score).strip() else None
                except (ValueError, TypeError):
                    score = None
                
                # Check if student already exists
                cursor.execute(
                    "SELECT id FROM student_registry WHERE cnic_norm = ? LIMIT 1",
                    (cnic_norm,)
                )
                existing = cursor.fetchone()
                
                if existing:
                    # Update existing record
                    cursor.execute("""
                        UPDATE student_registry 
                        SET seat_no = ?, name = ?, father_name = ?, 
                            score = ?, status = ?, post_applied_for = ?, venue = ?
                        WHERE cnic_norm = ?
                    """, (seat_no, name, father_name, score, status, post_applied, venue, cnic_norm))
                    updated += 1
                else:
                    # Insert new record
                    cursor.execute("""
                        INSERT INTO student_registry 
                        (cnic, cnic_norm, seat_no, name, father_name, score, status, 
                         post_applied_for, venue, source_filename, imported_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (cnic, cnic_norm, seat_no, name, father_name, score, status, 
                          post_applied, venue, excel_path.name, now_utc().isoformat()))
                    inserted += 1
                    
            except Exception as e:
                errors.append(f"Row {idx + 1}: {str(e)}")
                skipped += 1
        
        conn.commit()
        conn.close()
        
        summary = {
            "success": True,
            "inserted": inserted,
            "updated": updated,
            "skipped": skipped,
            "total": len(df),
            "errors": errors if errors else None
        }
        
        print(f"\n✅ Import Summary:")
        print(f"  Inserted: {inserted}")
        print(f"  Updated: {updated}")
        print(f"  Skipped: {skipped}")
        print(f"  Total Processed: {len(df)}")
        
        if errors:
            print(f"\n⚠️ Errors encountered:")
            for error in errors[:5]:  # Show first 5 errors
                print(f"  - {error}")
        
        return summary
        
    except Exception as e:
        return {"success": False, "error": str(e)}


if __name__ == "__main__":
    # Import from results.xlsx
    result = import_results_from_excel("results.xlsx", user="admin")
    print(f"\nFinal Result: {result}")
