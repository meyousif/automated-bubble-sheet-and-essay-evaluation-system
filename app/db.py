import sqlite3
from datetime import datetime

from .config import DATA_DIR, DB_PATH, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD, DEFAULT_ADMIN_USERNAME
from .security import hash_password, now_utc


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL,
            status TEXT NOT NULL,
            must_reset INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token_hash TEXT UNIQUE NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS password_resets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token_hash TEXT UNIQUE NOT NULL,
            expires_at TEXT NOT NULL,
            used_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS password_otps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            otp_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            used_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS system_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            user TEXT NOT NULL,
            action TEXT NOT NULL,
            status TEXT NOT NULL
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS answer_key_uploads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_name TEXT NOT NULL,
            file_name TEXT NOT NULL,
            row_count INTEGER NOT NULL,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS answer_key_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            upload_id INTEGER NOT NULL,
            question_id TEXT NOT NULL,
            correct_answer TEXT NOT NULL,
            FOREIGN KEY(upload_id) REFERENCES answer_key_uploads(id)
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS essay_uploads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_name TEXT NOT NULL,
            file_name TEXT NOT NULL,
            row_count INTEGER NOT NULL,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS essay_rubrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            subject TEXT NOT NULL,
            grade_level TEXT NOT NULL,
            topic TEXT NOT NULL,
            total_marks INTEGER NOT NULL,
            rubric_json TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 0,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS essay_evaluations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rubric_id INTEGER NOT NULL,
            file_name TEXT NOT NULL,
            ocr_text TEXT NOT NULL,
            evaluation_json TEXT NOT NULL,
            total_awarded REAL NOT NULL,
            total_marks REAL NOT NULL,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(rubric_id) REFERENCES essay_rubrics(id)
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS report_exports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            report_name TEXT NOT NULL,
            report_type TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS bubble_change_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            report_id INTEGER NOT NULL,
            student_index INTEGER NOT NULL,
            question_id TEXT NOT NULL,
            old_selected TEXT,
            new_selected TEXT NOT NULL,
            comment TEXT,
            requested_by TEXT NOT NULL,
            requested_role TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            reviewed_by TEXT,
            reviewed_at TEXT,
            admin_comment TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(report_id) REFERENCES report_exports(id)
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS bubble_scan_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            folder_path TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS bubble_sheets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_id INTEGER NOT NULL,
            filename TEXT NOT NULL,
            path TEXT NOT NULL,
            status TEXT NOT NULL,
            confidence REAL,
            verified_status TEXT NOT NULL,
            verified_by TEXT,
            verified_at TEXT,
            FOREIGN KEY(scan_id) REFERENCES bubble_scan_runs(id)
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS student_registry (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cnic TEXT,
            cnic_norm TEXT,
            seat_no TEXT,
            name TEXT,
            father_name TEXT,
            source_filename TEXT,
            post_applied_for TEXT,
            venue TEXT,
            score REAL,
            status TEXT,
            imported_at TEXT
        )
        """
    )

    _ensure_column(cursor, "bubble_sheets", "merged_from_path", "TEXT")
    _ensure_column(cursor, "bubble_sheets", "merged_at", "TEXT")
    _ensure_column(cursor, "report_exports", "row_count", "INTEGER")
    _ensure_column(cursor, "report_exports", "summary_json", "TEXT")
    _ensure_column(cursor, "report_exports", "details_json", "TEXT")
    _ensure_column(cursor, "bubble_change_requests", "seat_no", "TEXT")
    _ensure_column(cursor, "bubble_change_requests", "student_name", "TEXT")
    _ensure_column(cursor, "bubble_change_requests", "image_name", "TEXT")

    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_bubble_change_requests_status
        ON bubble_change_requests(status)
        """
    )

    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_bubble_change_requests_report
        ON bubble_change_requests(report_id)
        """
    )

    cursor.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_bubble_sheets_path
        ON bubble_sheets(path)
        """
    )

    cursor.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_student_registry_cnic
        ON student_registry(cnic_norm)
        """
    )

    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_system_logs_timestamp
        ON system_logs(timestamp)
        """
    )

    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_system_logs_user
        ON system_logs(user)
        """
    )

    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_system_logs_action
        ON system_logs(action)
        """
    )

    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_system_logs_status
        ON system_logs(status)
        """
    )

    conn.commit()
    _ensure_default_admin(conn)
    conn.close()


def _ensure_column(cursor: sqlite3.Cursor, table: str, column: str, col_type: str) -> None:
    cursor.execute(f"PRAGMA table_info({table})")
    existing = {row[1] for row in cursor.fetchall()}
    if column in existing:
        return
    cursor.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")


def log_event(user: str, action: str, status: str) -> None:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        """
        INSERT INTO system_logs (timestamp, user, action, status)
        VALUES (?, ?, ?, ?)
        """,
        (now_utc().isoformat(), user, action, status),
    )
    conn.commit()
    conn.close()


def _ensure_default_admin(conn: sqlite3.Connection) -> None:
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM users WHERE username = ?", (DEFAULT_ADMIN_USERNAME,))
    row = cursor.fetchone()
    if row:
        return

    now = now_utc().isoformat()
    cursor.execute(
        """
        INSERT INTO users (username, email, password_hash, role, status, must_reset, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            DEFAULT_ADMIN_USERNAME,
            DEFAULT_ADMIN_EMAIL,
            hash_password(DEFAULT_ADMIN_PASSWORD),
            "Admin",
            "Active",
            0,
            now,
            now,
        ),
    )
    conn.commit()
