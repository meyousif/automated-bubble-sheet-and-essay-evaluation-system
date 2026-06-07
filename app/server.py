from datetime import datetime
from functools import wraps
from typing import Optional
import threading
import re
import uuid

import io
import os
import shutil
import sqlite3
from pathlib import Path

import pandas as pd
import json
from flask import Flask, jsonify, request, g, Response
from flask_cors import CORS

from .config import SESSION_TTL_MINUTES, DATA_DIR, OMR_MODEL_PATH, STUDENT_REGISTRY_DB, RESET_TOKEN_TTL_MINUTES
from .db import get_connection, init_db, log_event
import utils
from .fold_detector import scan_folder
from omr_backend_service import run_omr_backend
from .security import expires_at, generate_token, hash_password, hash_token, now_utc, verify_password
from config import GEMINI_API_KEY
from rubric_generator import generate_rubric as generate_ai_rubric
from essayText import extract_handwritten_text
from evaluate_essay import evaluate_essay as evaluate_ai_essay


def create_app() -> Flask:
    app = Flask(__name__)
    CORS(app)
    init_db()

    users_json_path = Path(__file__).resolve().parent.parent / "users.json"

    def _sync_users_from_json() -> int:
        if not users_json_path.is_file():
            return 0

        try:
            raw = json.loads(users_json_path.read_text(encoding="utf-8"))
        except Exception:
            return 0

        if not isinstance(raw, dict):
            return 0

        conn = get_connection()
        cursor = conn.cursor()
        inserted = 0
        now = now_utc().isoformat()

        try:
            for email_raw, password_raw in raw.items():
                email = str(email_raw or "").strip().lower()
                password = str(password_raw or "").strip()
                if not email or not password:
                    continue

                cursor.execute("SELECT id FROM users WHERE email = ?", (email,))
                if cursor.fetchone():
                    continue

                local_part = email.split("@", 1)[0] if "@" in email else email
                base_username = "".join(ch for ch in local_part if ch.isalnum() or ch in {"_", ".", "-"}).strip("._-")
                if not base_username:
                    base_username = f"user{uuid.uuid4().hex[:6]}"

                username = base_username
                suffix = 1
                while True:
                    cursor.execute("SELECT 1 FROM users WHERE username = ?", (username,))
                    if not cursor.fetchone():
                        break
                    suffix += 1
                    username = f"{base_username}{suffix}"

                cursor.execute(
                    """
                    INSERT INTO users (username, email, password_hash, role, status, must_reset, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (username, email, hash_password(password), "Examiner", "Active", 0, now, now),
                )
                inserted += 1

            if inserted:
                conn.commit()
        finally:
            conn.close()

        return inserted

    # Note: Automatic user sync from users.json is disabled to prevent deleted users from reappearing.
    # Admins can manually sync using the /api/users/sync-json endpoint if needed.

    def _normalize_cnic(value: Optional[str]) -> str:
        raw = str(value or "")
        digits = "".join(ch for ch in raw if ch.isdigit())
        return digits

    def _bubble_question_sort_key(value: str) -> tuple[int, str]:
        try:
            return int(value), value
        except Exception:
            return 10**9, value

    def _rebuild_bubble_export(detail_rows: list[dict]) -> tuple[list[str], list[dict]]:
        questions = []
        question_seen = set()

        for item in detail_rows:
            for question in item.get("QuestionResults") or []:
                question_id = str(question.get("Question") or "").strip()
                if not question_id or question_id in question_seen:
                    continue
                question_seen.add(question_id)
                questions.append(question_id)

        questions.sort(key=_bubble_question_sort_key)

        summary_rows = []
        total_questions = len(questions)

        for item in detail_rows:
            question_map = {}
            for question in item.get("QuestionResults") or []:
                question_id = str(question.get("Question") or "").strip()
                if question_id:
                    question_map[question_id] = question

            correct_count = 0
            for question_id in questions:
                question = question_map.get(question_id) or {}
                selected = str(question.get("SelectedOption") or "").strip()
                correct = str(question.get("CorrectOption") or "").strip()
                is_correct = bool(selected) and selected == correct
                question["Question"] = question_id
                question["SelectedOption"] = selected
                question["CorrectOption"] = correct
                question["IsCorrect"] = is_correct
                if is_correct:
                    correct_count += 1

            item["Correct"] = int(correct_count)
            item["Total"] = int(total_questions)
            item["Score"] = round((correct_count / total_questions * 100.0), 2) if total_questions else 0.0
            item["MatchSource"] = item.get("MatchSource") or "ocr"

            summary_rows.append({
                "CNIC": item.get("CNIC") or "",
                "SeatNumber": item.get("SeatNumber") or "",
                "Name": item.get("Name") or "",
                "FatherName": item.get("FatherName") or "",
                "Correct": int(item.get("Correct") or 0),
                "Total": int(item.get("Total") or 0),
                "Score": float(item.get("Score") or 0.0),
                "MatchSource": item.get("MatchSource") or "ocr",
                "QuestionResults": item.get("QuestionResults") or [],
                "Image": item.get("Image") or "",
                "SourcePath": item.get("SourcePath") or "",
            })

        return questions, summary_rows

    def _load_bubble_export(cursor: sqlite3.Cursor, report_id: int):
        cursor.execute(
            """
            SELECT id, report_name, report_type, created_by, created_at, row_count, summary_json, details_json
            FROM report_exports
            WHERE id = ?
            """,
            (report_id,),
        )
        return cursor.fetchone()

    def _store_bubble_export(cursor: sqlite3.Cursor, report_id: int, detail_rows: list[dict]) -> None:
        _, summary_rows = _rebuild_bubble_export(detail_rows)
        cursor.execute(
            """
            UPDATE report_exports
            SET row_count = ?, summary_json = ?, details_json = ?
            WHERE id = ?
            """,
            (
                len(detail_rows),
                json.dumps(summary_rows, ensure_ascii=False, indent=4),
                json.dumps(detail_rows, ensure_ascii=False, indent=4),
                report_id,
            ),
        )

    def _apply_bubble_answer_change(report_id: int, student_index: int, question_id: str, new_selected: str):
        conn = get_connection()
        cursor = conn.cursor()

        export = _load_bubble_export(cursor, report_id)
        if not export:
            conn.close()
            return None, "Report not found."

        if str(export["report_type"] or "").strip().lower() != "bubble":
            conn.close()
            return None, "Only bubble reports can be edited."

        try:
            detail_rows = json.loads(export["details_json"] or "[]")
        except json.JSONDecodeError:
            detail_rows = []

        if student_index < 0 or student_index >= len(detail_rows):
            conn.close()
            return None, "Student detail not found."

        item = detail_rows[student_index] or {}
        question_results = item.get("QuestionResults") or []
        target = None
        for question in question_results:
            if str(question.get("Question") or "").strip() == str(question_id).strip():
                target = question
                break

        if target is None:
            conn.close()
            return None, "Question not found."

        selected_value = str(new_selected or "").strip().upper()
        if selected_value in {"-", "BLANK"}:
            selected_value = ""
        target["SelectedOption"] = selected_value
        target["IsCorrect"] = bool(selected_value) and selected_value == str(target.get("CorrectOption") or "").strip().upper()
        item["QuestionResults"] = question_results
        detail_rows[student_index] = item

        _store_bubble_export(cursor, report_id, detail_rows)
        conn.commit()
        conn.close()

        return {
            "report_id": report_id,
            "student_index": student_index,
            "question_id": str(question_id).strip(),
            "selected": selected_value,
        }, None

    def _import_student_registry() -> tuple[int, int, str]:
        if not STUDENT_REGISTRY_DB.is_file():
            return 0, 0, "Student registry database not found."

        src_conn = sqlite3.connect(STUDENT_REGISTRY_DB)
        src_conn.row_factory = sqlite3.Row
        src_cur = src_conn.cursor()
        try:
            src_cur.execute(
                """
                SELECT filename, seat_no, name, relation, cnic, post_applied_for, venue, score, status, created_at
                FROM candidates
                """
            )
            rows = src_cur.fetchall()
        except Exception:
            src_conn.close()
            return 0, 0, "Unable to read candidates table."
        src_conn.close()

        if not rows:
            return 0, 0, "No candidates found in registry."

        conn = get_connection()
        cursor = conn.cursor()
        inserted = 0
        skipped = 0
        now = now_utc().isoformat()

        for row in rows:
            cnic = row["cnic"]
            cnic_norm = _normalize_cnic(cnic)
            if not cnic_norm:
                skipped += 1
                continue

            cursor.execute(
                """
                INSERT INTO student_registry
                (cnic, cnic_norm, seat_no, name, father_name, source_filename, post_applied_for, venue, score, status, imported_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(cnic_norm) DO UPDATE SET
                    cnic = excluded.cnic,
                    seat_no = excluded.seat_no,
                    name = excluded.name,
                    father_name = excluded.father_name,
                    source_filename = excluded.source_filename,
                    post_applied_for = excluded.post_applied_for,
                    venue = excluded.venue,
                    score = excluded.score,
                    status = excluded.status,
                    imported_at = excluded.imported_at
                """,
                (
                    cnic,
                    cnic_norm,
                    row["seat_no"],
                    row["name"],
                    row["relation"],
                    row["filename"],
                    row["post_applied_for"],
                    row["venue"],
                    row["score"],
                    row["status"],
                    now,
                ),
            )
            inserted += 1

        conn.commit()
        conn.close()
        return inserted, skipped, "Imported student registry."

    def _normalize_name(value: Optional[str]) -> str:
        raw = str(value or "").strip().lower()
        cleaned = "".join(ch if ch.isalnum() or ch.isspace() else " " for ch in raw)
        return " ".join(cleaned.split())

    def _normalize_seat(value: Optional[str]) -> str:
        raw = str(value or "").strip().upper()
        return "".join(ch for ch in raw if ch.isalnum())

    def _token_overlap_ratio(left: str, right: str) -> float:
        left_tokens = set(left.split())
        right_tokens = set(right.split())
        if not left_tokens or not right_tokens:
            return 0.0
        inter = left_tokens.intersection(right_tokens)
        denom = max(len(left_tokens), len(right_tokens))
        return len(inter) / denom

    def _load_student_registry() -> dict:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT cnic, cnic_norm, seat_no, name, father_name
            FROM student_registry
            """
        )
        rows = cursor.fetchall()
        conn.close()

        by_cnic = {}
        by_seat = {}
        by_name_father = {}
        all_rows = []
        for row in rows:
            record = {
                "cnic": row["cnic"],
                "seat_no": row["seat_no"],
                "name": row["name"],
                "father_name": row["father_name"],
                "cnic_norm": row["cnic_norm"],
                "seat_norm": _normalize_seat(row["seat_no"]),
                "name_norm": _normalize_name(row["name"]),
                "father_name_norm": _normalize_name(row["father_name"]),
            }
            all_rows.append(record)

            cnic_norm = row["cnic_norm"]
            if cnic_norm:
                by_cnic[cnic_norm] = record

            seat_no = _normalize_seat(row["seat_no"])
            if seat_no:
                existing = by_seat.get(seat_no)
                by_seat[seat_no] = record if existing is None else None

            name_key = _normalize_name(row["name"])
            father_key = _normalize_name(row["father_name"])
            if name_key and father_key:
                key = f"{name_key}|{father_key}"
                existing = by_name_father.get(key)
                by_name_father[key] = record if existing is None else None

        return {
            "by_cnic": by_cnic,
            "by_seat": by_seat,
            "by_name_father": by_name_father,
            "all_rows": all_rows,
        }

    def _best_registry_match(
        registry: dict,
        cnic_norm: str,
        seat_no: Optional[str],
        name: Optional[str],
        father_name: Optional[str],
    ) -> tuple[Optional[dict], Optional[str]]:
        seat_norm = _normalize_seat(seat_no)
        name_norm = _normalize_name(name)
        father_norm = _normalize_name(father_name)

        candidates = []
        for row in registry["all_rows"]:
            score = 0
            signals = []

            row_cnic = row.get("cnic_norm") or ""
            if cnic_norm and row_cnic:
                if cnic_norm == row_cnic:
                    return row, "cnic"
                if len(cnic_norm) >= 7 and (cnic_norm in row_cnic or row_cnic in cnic_norm):
                    score += 45
                    signals.append("cnic_partial")
                if len(cnic_norm) >= 5 and row_cnic.endswith(cnic_norm[-5:]):
                    score += 20
                    signals.append("cnic_tail")

            row_seat = row.get("seat_norm") or ""
            if seat_norm and row_seat:
                if seat_norm == row_seat:
                    score += 60
                    signals.append("seat")
                elif len(seat_norm) >= 4 and (seat_norm in row_seat or row_seat in seat_norm):
                    score += 35
                    signals.append("seat_partial")

            row_name = row.get("name_norm") or ""
            row_father = row.get("father_name_norm") or ""

            if name_norm and row_name:
                ratio = _token_overlap_ratio(name_norm, row_name)
                if ratio >= 0.8:
                    score += 30
                    signals.append("name")
                elif ratio >= 0.5:
                    score += 15
                    signals.append("name_partial")

            if father_norm and row_father:
                ratio = _token_overlap_ratio(father_norm, row_father)
                if ratio >= 0.8:
                    score += 20
                    signals.append("father")
                elif ratio >= 0.5:
                    score += 10
                    signals.append("father_partial")

            if score > 0:
                candidates.append((score, signals, row))

        if not candidates:
            return None, None

        candidates.sort(key=lambda item: item[0], reverse=True)
        best_score, best_signals, best_row = candidates[0]
        second_score = candidates[1][0] if len(candidates) > 1 else -1

        if best_score < 60:
            return None, None
        if second_score >= 0 and (best_score - second_score) < 15:
            return None, None

        if "seat" in best_signals:
            return best_row, "seat"
        if "cnic_partial" in best_signals or "cnic_tail" in best_signals:
            return best_row, "cnic_partial"
        if "name" in best_signals and "father" in best_signals:
            return best_row, "name_father"
        if "name_partial" in best_signals or "father_partial" in best_signals:
            return best_row, "name_father_partial"
        return best_row, "registry_best"

    def _best_seat_approx(registry: dict, seat_no: Optional[str]) -> Optional[dict]:
        seat_norm = _normalize_seat(seat_no)
        if not seat_norm:
            return None

        def _digit_distance(a: str, b: str) -> int:
            if len(a) == len(b):
                return sum(1 for x, y in zip(a, b) if x != y)
            # Fallback simple edit distance for length mismatch.
            m, n = len(a), len(b)
            dp = [[0] * (n + 1) for _ in range(m + 1)]
            for i in range(m + 1):
                dp[i][0] = i
            for j in range(n + 1):
                dp[0][j] = j
            for i in range(1, m + 1):
                for j in range(1, n + 1):
                    cost = 0 if a[i - 1] == b[j - 1] else 1
                    dp[i][j] = min(
                        dp[i - 1][j] + 1,
                        dp[i][j - 1] + 1,
                        dp[i - 1][j - 1] + cost,
                    )
            return dp[m][n]

        candidates = []
        for seat_key, row in registry["by_seat"].items():
            if not row:
                continue
            dist = _digit_distance(seat_norm, seat_key)
            if dist <= 3:
                candidates.append((dist, seat_key, row))

        if not candidates:
            return None

        candidates.sort(key=lambda item: (item[0], item[1]))
        if len(candidates) > 1 and candidates[0][0] == candidates[1][0]:
            return None
        return candidates[0][2]

    scan_jobs = {}
    scan_lock = threading.Lock()

    bubble_evaluation_jobs = {}
    bubble_evaluation_lock = threading.Lock()

    def _update_scan_job(job_id: str, **fields) -> None:
        with scan_lock:
            job = scan_jobs.get(job_id)
            if not job:
                return
            job.update(fields)

    def _update_bubble_evaluation_job(job_id: str, **fields) -> None:
        with bubble_evaluation_lock:
            job = bubble_evaluation_jobs.get(job_id)
            if not job:
                return
            job.update(fields)

    def _get_bubble_evaluation_job(job_id: str) -> Optional[dict]:
        with bubble_evaluation_lock:
            job = bubble_evaluation_jobs.get(job_id)
            return dict(job) if job else None

    def _store_scan_results(result: dict, folder_path: str, username: str) -> dict:
        conn = get_connection()
        cursor = conn.cursor()
        now = now_utc().isoformat()
        
        cursor.execute(
            """
            DELETE FROM bubble_sheets
            WHERE path LIKE ?
              AND verified_by IS NULL
            """,
            (f"{folder_path}%",),
        )
        conn.commit()
        
        cursor.execute(
            """
            INSERT INTO bubble_scan_runs (folder_path, created_by, created_at)
            VALUES (?, ?, ?)
            """,
            (folder_path, username, now),
        )
        scan_id = cursor.lastrowid

        rows = result.get("results", [])
        for row in rows:
            status = row.get("status")
            verified_status = "pending" if status == "folded" else "approved"
            cursor.execute(
                """
                INSERT INTO bubble_sheets
                (scan_id, filename, path, status, confidence, verified_status, verified_by, verified_at, merged_from_path, merged_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(path) DO UPDATE SET
                    scan_id = excluded.scan_id,
                    filename = excluded.filename,
                    status = excluded.status,
                    confidence = excluded.confidence,
                    verified_status = CASE 
                        WHEN verified_by IS NOT NULL THEN verified_status
                        ELSE excluded.verified_status
                    END,
                    verified_by = verified_by,
                    verified_at = verified_at,
                    merged_from_path = NULL,
                    merged_at = NULL
                """,
                (
                    scan_id,
                    row.get("filename", ""),
                    row.get("path", ""),
                    status,
                    row.get("confidence"),
                    verified_status,
                    None,
                    None,
                    None,
                    None,
                ),
            )
        conn.commit()

        cursor.execute(
            """
            SELECT id, filename, path, confidence
            FROM bubble_sheets
            WHERE status = 'folded' AND verified_status = 'pending'
            ORDER BY id DESC
            """,
        )
        folded_rows = [dict(row) for row in cursor.fetchall()]

        merge_candidates = []
        filenames = [row.get("filename") for row in rows if row.get("filename")]
        if filenames:
            unique_names = list(dict.fromkeys(filenames))
            lower_names = [name.lower() for name in unique_names]
            placeholders = ",".join("?" for _ in lower_names)
            cursor.execute(
                f"""
                SELECT id, filename, path
                FROM bubble_sheets
                WHERE verified_status = 'rejected'
                AND lower(filename) IN ({placeholders})
                ORDER BY id DESC
                """,
                lower_names,
            )
            rejected_rows = cursor.fetchall()
            matches_by_name = {}
            for rej in rejected_rows:
                name = rej["filename"].lower()
                matches_by_name.setdefault(name, []).append({
                    "id": rej["id"],
                    "path": rej["path"],
                })

            for row in rows:
                name = row.get("filename", "").lower()
                if not name or name not in matches_by_name:
                    continue
                merge_candidates.append({
                    "filename": row.get("filename"),
                    "new_path": row.get("path"),
                    "confidence": row.get("confidence"),
                    "status": row.get("status"),
                    "old_matches": matches_by_name[name],
                })
        conn.close()

        log_event(username, "Fold check completed", "Success")
        return {
            "success": True,
            **result,
            "scan_id": scan_id,
            "folder_path": folder_path,
            "folded_rows": folded_rows,
            "merge_candidates": merge_candidates,
        }

    def _run_scan_job(job_id: str, folder_path: str, recursive: bool, username: str) -> None:
        try:
            def progress_cb(processed: int, total: int) -> None:
                _update_scan_job(job_id, processed=processed, total=total)

            result = scan_folder(folder_path, 0.5, recursive, progress_cb)
            response = _store_scan_results(result, folder_path, username)
            _update_scan_job(job_id, status="done", result=response, processed=response.get("processed", 0), total=response.get("total", 0))
        except Exception:
            _update_scan_job(job_id, status="error", error="Unable to run fold detection.")

    @app.route("/api/health", methods=["GET"])
    def health():
        return jsonify({"ok": True})

    @app.route("/api/login", methods=["POST"])
    def login():
        payload = request.get_json(silent=True) or {}
        username = str(payload.get("username", "")).strip()
        password = str(payload.get("password", "")).strip()

        if not username or not password:
            return jsonify({"success": False, "message": "Username and password are required."}), 400

        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE username = ?", (username,))
        user = cursor.fetchone()

        if not user or not verify_password(password, user["password_hash"]):
            conn.close()
            log_event(username or "Guest", "Login attempt failed", "Failed")
            return jsonify({"success": False, "message": "Invalid username or password."}), 401

        if user["status"] != "Active":
            conn.close()
            log_event(user["username"], "Login blocked (inactive)", "Failed")
            return jsonify({"success": False, "message": "User account is inactive."}), 403

        token = generate_token()
        token_hash = hash_token(token)
        expires = expires_at(SESSION_TTL_MINUTES).isoformat()
        now = now_utc().isoformat()

        cursor.execute(
            """
            INSERT INTO sessions (user_id, token_hash, expires_at, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (user["id"], token_hash, expires, now),
        )
        conn.commit()
        conn.close()

        log_event(user["username"], "Login successful", "Success")

        redirect = "dashboard.html"

        return jsonify({
            "success": True,
            "message": "Login successful.",
            "username": user["username"],
            "name": user["username"],
            "role": user["role"],
            "redirect": redirect,
            "sessionToken": token,
            "mustReset": bool(user["must_reset"]),
        })

    @app.route("/api/logout", methods=["POST"])
    @require_auth
    def logout():
        token_hash = g.session_token_hash
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
        conn.commit()
        conn.close()
        log_event(g.user["username"], "Logout", "Success")
        return jsonify({"success": True})


    @app.route("/api/forgot-password", methods=["POST"])
    def forgot_password():
        payload = request.get_json(silent=True) or {}
        email = str(payload.get("email", "")).strip().lower()

        if not email:
            return jsonify({"success": False, "message": "Email is required."}), 400

        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id, username, status FROM users WHERE email = ?", (email,))
        user = cursor.fetchone()

        # Always return success to avoid leaking whether an email exists
        now = now_utc().isoformat()
        if not user:
            conn.close()
            return jsonify({"success": True, "message": "If an account exists, a reset link or OTP has been sent."})

        if user["status"] != "Active":
            conn.close()
            return jsonify({"success": True, "message": "If an account exists, a reset link or OTP has been sent."})

        # Generate OTP and send via SMTP (no SendGrid)
        otp = utils.generate_otp(6)
        otp_hash = hash_token(otp)
        otp_expires = expires_at(int(RESET_TOKEN_TTL_MINUTES)).isoformat()
        try:
            cursor.execute(
                "INSERT INTO password_otps (user_id, otp_hash, expires_at, created_at) VALUES (?, ?, ?, ?)",
                (user["id"], otp_hash, otp_expires, now),
            )
            conn.commit()
        except Exception:
            pass

        conn.close()

        # Send OTP in background so UI doesn't hang on slow SMTP/network.
        def _send_otp_async(target_email: str, otp_value: str, username: str) -> None:
            try:
                ok, send_msg = utils.send_otp_email(target_email, otp_value)
                if ok:
                    log_event(username, f"Password OTP sent to {target_email}", "Success")
                else:
                    log_event(username, f"Password OTP send failed: {send_msg}", "Failed")
            except Exception as exc:
                log_event(username, f"Password OTP send exception: {exc}", "Failed")

        threading.Thread(target=_send_otp_async, args=(email, otp, user["username"]), daemon=True).start()

        log_event(user["username"], "Requested password reset", "Success")
        return jsonify({"success": True, "message": "If an account exists, a reset link or OTP has been sent."})


    @app.route("/api/verify-reset-token", methods=["POST"])
    def verify_reset_token():
        payload = request.get_json(silent=True) or {}
        token = str(payload.get("token", "")).strip()
        if not token:
            return jsonify({"success": False, "message": "Token is required."}), 400

        token_hash = hash_token(token)
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT pr.id AS id, pr.user_id AS user_id, pr.expires_at AS expires_at, pr.used_at AS used_at, u.username AS username FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE pr.token_hash = ?",
            (token_hash,),
        )
        row = cursor.fetchone()
        conn.close()

        if not row:
            return jsonify({"success": False, "message": "Invalid or expired token."}), 404

        if row["used_at"]:
            return jsonify({"success": False, "message": "Token already used."}), 400

        try:
            expires = datetime.fromisoformat(row["expires_at"])
        except Exception:
            return jsonify({"success": False, "message": "Invalid token record."}), 400

        if expires < now_utc():
            return jsonify({"success": False, "message": "Token expired."}), 400

        return jsonify({"success": True, "username": row["username"]})


    @app.route("/api/reset-password", methods=["POST"])
    def reset_password():
        payload = request.get_json(silent=True) or {}
        token = str(payload.get("token", "")).strip()
        new_password = str(payload.get("password", "")).strip()

        if not token or not new_password:
            return jsonify({"success": False, "message": "Token and new password are required."}), 400

        token_hash = hash_token(token)
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT pr.id AS id, pr.user_id AS user_id, pr.expires_at AS expires_at, pr.used_at AS used_at FROM password_resets pr WHERE pr.token_hash = ?",
            (token_hash,),
        )
        row = cursor.fetchone()
        if not row:
            conn.close()
            return jsonify({"success": False, "message": "Invalid token."}), 404

        if row["used_at"]:
            conn.close()
            return jsonify({"success": False, "message": "Token already used."}), 400

        try:
            expires = datetime.fromisoformat(row["expires_at"])
        except Exception:
            conn.close()
            return jsonify({"success": False, "message": "Invalid token record."}), 400

        if expires < now_utc():
            conn.close()
            return jsonify({"success": False, "message": "Token expired."}), 400

        # Update password
        now = now_utc().isoformat()
        try:
            cursor.execute("UPDATE users SET password_hash = ?, must_reset = 0, updated_at = ? WHERE id = ?", (hash_password(new_password), now, row["user_id"]))
            cursor.execute("UPDATE password_resets SET used_at = ? WHERE id = ?", (now, row["id"]))
            # delete any existing sessions for user
            cursor.execute("DELETE FROM sessions WHERE user_id = ?", (row["user_id"],))
            conn.commit()
        except Exception:
            conn.close()
            return jsonify({"success": False, "message": "Unable to set new password."}), 500

        conn.close()
        log_event(str(row["user_id"]), "Password reset completed", "Success")
        return jsonify({"success": True, "message": "Password has been reset."})


    @app.route("/api/reset-password-with-otp", methods=["POST"])
    def reset_password_with_otp():
        payload = request.get_json(silent=True) or {}
        email = str(payload.get("email", "")).strip().lower()
        otp = str(payload.get("otp", "")).strip()
        new_password = str(payload.get("password", "")).strip()

        if not email or not otp or not new_password:
            return jsonify({"success": False, "message": "Email, OTP and new password are required."}), 400

        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM users WHERE email = ?", (email,))
        user = cursor.fetchone()
        if not user:
            conn.close()
            return jsonify({"success": False, "message": "Invalid email or OTP."}), 400

        otp_hash = hash_token(otp)
        cursor.execute("SELECT id, expires_at, used_at FROM password_otps WHERE user_id = ? AND otp_hash = ? ORDER BY id DESC LIMIT 1", (user["id"], otp_hash))
        row = cursor.fetchone()
        if not row:
            conn.close()
            return jsonify({"success": False, "message": "Invalid OTP."}), 400

        if row["used_at"]:
            conn.close()
            return jsonify({"success": False, "message": "OTP already used."}), 400

        try:
            expires = datetime.fromisoformat(row["expires_at"])
        except Exception:
            conn.close()
            return jsonify({"success": False, "message": "Invalid OTP record."}), 400

        if expires < now_utc():
            conn.close()
            return jsonify({"success": False, "message": "OTP expired."}), 400

        now = now_utc().isoformat()
        try:
            cursor.execute("UPDATE users SET password_hash = ?, must_reset = 0, updated_at = ? WHERE id = ?", (hash_password(new_password), now, user["id"]))
            cursor.execute("UPDATE password_otps SET used_at = ? WHERE id = ?", (now, row["id"]))
            cursor.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))
            conn.commit()
        except Exception:
            conn.close()
            return jsonify({"success": False, "message": "Unable to set new password."}), 500

        conn.close()
        log_event(str(user["id"]), "Password reset via OTP", "Success")
        return jsonify({"success": True, "message": "Password has been reset."})

    @app.route("/api/dashboard", methods=["GET"])
    @require_auth
    def dashboard_data():
        conn = get_connection()
        cursor = conn.cursor()

        cursor.execute("SELECT COUNT(*) AS total FROM bubble_sheets")
        bubble_total = cursor.fetchone()["total"]

        cursor.execute("SELECT COUNT(*) AS total FROM bubble_sheets WHERE verified_status = 'approved'")
        approved_total = cursor.fetchone()["total"]

        cursor.execute("SELECT COUNT(*) AS total FROM essay_uploads")
        essay_total = cursor.fetchone()["total"]

        cursor.execute("SELECT COUNT(*) AS total FROM report_exports")
        report_total = cursor.fetchone()["total"]

        stats = {
            "bubble_sheets_uploaded": int(bubble_total or 0),
            "essays_uploaded": int(essay_total or 0),
            "evaluations_completed": int(approved_total or 0),
            "reports_generated": int(report_total or 0),
        }

        if g.user["role"] == "Admin":
            cursor.execute(
                """
                SELECT timestamp, action, status
                FROM system_logs
                ORDER BY id DESC
                LIMIT 8
                """
            )
            log_rows = cursor.fetchall()
        else:
            cursor.execute(
                """
                SELECT timestamp, action, status
                FROM system_logs
                WHERE action LIKE '%Fold%' OR action LIKE '%sheet%'
                ORDER BY id DESC
                LIMIT 8
                """
            )
            log_rows = cursor.fetchall()
        conn.close()

        activity = []
        for row in log_rows:
            action = row["action"]
            status = row["status"]
            action_lower = action.lower()
            if "report" in action_lower:
                item_type = "report"
            elif "approved" in action_lower:
                item_type = "success"
            elif "rejected" in action_lower or status.lower() == "failed":
                item_type = "warning"
            else:
                item_type = "upload"

            activity.append({
                "type": item_type,
                "title": action,
                "time": row["timestamp"],
            })

        return jsonify({
            "stats": stats,
            "recent_activity": activity,
        })

    @app.route("/api/reports", methods=["GET"])
    @require_auth
    def list_reports():
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, report_name, report_type, created_by, created_at, row_count, summary_json
            FROM report_exports
            ORDER BY id DESC
            """
        )
        exports = [dict(row) for row in cursor.fetchall()]

        cursor.execute(
            """
            SELECT ev.id, ev.file_name, ev.total_awarded, ev.total_marks, ev.created_at,
                   ev.created_by, rub.name AS rubric_name, rub.subject, rub.grade_level, rub.topic
            FROM essay_evaluations AS ev
            JOIN essay_rubrics AS rub ON rub.id = ev.rubric_id
            ORDER BY ev.id DESC
            """
        )
        essay_rows = [dict(row) for row in cursor.fetchall()]
        conn.close()

        reports = []
        for export in exports:
            summary_json = export["summary_json"] or "[]"
            try:
                summary_rows = json.loads(summary_json)
            except json.JSONDecodeError:
                summary_rows = []

            avg_score = 0.0
            if summary_rows:
                scores = [float(item.get("Score") or 0.0) for item in summary_rows]
                avg_score = round(sum(scores) / len(scores), 2)

            reports.append({
                "id": export["id"],
                "kind": "bubble",
                "name": export["report_name"],
                "type": export["report_type"],
                "created_by": export["created_by"],
                "created_at": export["created_at"],
                "row_count": int(export["row_count"] or len(summary_rows)),
                "avg_score": avg_score,
            })

        for essay in essay_rows:
            try:
                total_awarded = float(essay.get("total_awarded") or 0.0)
                total_marks = float(essay.get("total_marks") or 0.0)
                avg_score = round((total_awarded / total_marks * 100.0) if total_marks else 0.0, 2)
            except (TypeError, ValueError):
                avg_score = 0.0

            reports.append({
                "id": essay["id"],
                "kind": "essay",
                "name": essay.get("rubric_name") or essay.get("file_name") or "Essay Evaluation",
                "type": "Essay",
                "created_by": essay["created_by"],
                "created_at": essay["created_at"],
                "row_count": 1,
                "avg_score": avg_score,
                "subject": essay.get("subject"),
                "grade_level": essay.get("grade_level"),
                "topic": essay.get("topic"),
            })

        reports.sort(key=lambda item: item.get("created_at") or "", reverse=True)

        return jsonify({"reports": reports})

    @app.route("/api/reports/<int:report_id>", methods=["DELETE"])
    @require_admin
    def delete_report(report_id: int):
        kind = str(request.args.get("kind", "")).strip().lower()
        if kind not in {"bubble", "essay"}:
            return jsonify({"success": False, "message": "Query param 'kind' must be 'bubble' or 'essay'."}), 400

        conn = get_connection()
        cursor = conn.cursor()

        if kind == "bubble":
            cursor.execute(
                """
                SELECT id, report_name
                FROM report_exports
                WHERE id = ?
                """,
                (report_id,),
            )
            row = cursor.fetchone()
            if not row:
                conn.close()
                return jsonify({"success": False, "message": "Bubble report not found."}), 404

            cursor.execute("DELETE FROM report_exports WHERE id = ?", (report_id,))
            conn.commit()
            conn.close()

            log_event(g.user["username"], f"Deleted bubble report {row['report_name']} (#{report_id})", "Success")
            return jsonify({"success": True, "message": "Bubble report deleted."})

        cursor.execute(
            """
            SELECT id, file_name
            FROM essay_evaluations
            WHERE id = ?
            """,
            (report_id,),
        )
        row = cursor.fetchone()
        if not row:
            conn.close()
            return jsonify({"success": False, "message": "Essay report not found."}), 404

        cursor.execute("DELETE FROM essay_evaluations WHERE id = ?", (report_id,))
        conn.commit()
        conn.close()

        file_name = row["file_name"] or f"essay #{report_id}"
        log_event(g.user["username"], f"Deleted essay report {file_name} (#{report_id})", "Success")
        return jsonify({"success": True, "message": "Essay report deleted."})

    @app.route("/api/reports/<int:report_id>/students", methods=["GET"])
    @require_auth
    def report_students(report_id: int):
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, report_name, report_type, created_by, created_at, summary_json, details_json
            FROM report_exports
            WHERE id = ?
            """,
            (report_id,),
        )
        export = cursor.fetchone()
        conn.close()

        if not export:
            return jsonify({"success": False, "message": "Report not found."}), 404

        details_json = export["details_json"] or "[]"
        summary_json = export["summary_json"] or "[]"

        try:
            detail_rows = json.loads(details_json)
        except json.JSONDecodeError:
            detail_rows = []

        if not detail_rows:
            try:
                summary_rows = json.loads(summary_json)
            except json.JSONDecodeError:
                summary_rows = []

            detail_rows = []
            for item in summary_rows:
                detail_rows.append({
                    "CNIC": item.get("CNIC") or "",
                    "SeatNumber": item.get("SeatNumber") or "",
                    "Name": item.get("Name") or "",
                    "FatherName": item.get("FatherName") or "",
                    "Correct": int(item.get("Correct") or 0),
                    "Total": int(item.get("Total") or 0),
                    "Score": float(item.get("Score") or 0.0),
                    "MatchSource": item.get("MatchSource") or "ocr",
                    "QuestionResults": [],
                })

        students = []
        for idx, item in enumerate(detail_rows):
            question_results = item.get("QuestionResults") or []
            students.append({
                "student_index": idx,
                "cnic": item.get("CNIC") or "",
                "seat_no": item.get("SeatNumber") or "",
                "name": item.get("Name") or "",
                "father_name": item.get("FatherName") or "",
                "correct": int(item.get("Correct") or 0),
                "total": int(item.get("Total") or 0),
                "score": float(item.get("Score") or 0.0),
                "match_source": item.get("MatchSource") or "ocr",
                "answers_count": len(question_results),
            })

        return jsonify({
            "report": {
                "id": export["id"],
                "name": export["report_name"],
                "type": export["report_type"],
                "created_by": export["created_by"],
                "created_at": export["created_at"],
            },
            "students": students,
        })

    @app.route("/api/reports/<int:report_id>/students/<int:student_index>/answers", methods=["GET"])
    @require_auth
    def report_student_answers(report_id: int, student_index: int):
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, report_name, details_json
            FROM report_exports
            WHERE id = ?
            """,
            (report_id,),
        )
        export = cursor.fetchone()
        conn.close()

        if not export:
            return jsonify({"success": False, "message": "Report not found."}), 404

        details_json = export["details_json"] or "[]"
        try:
            detail_rows = json.loads(details_json)
        except json.JSONDecodeError:
            detail_rows = []

        if student_index < 0 or student_index >= len(detail_rows):
            return jsonify({"success": False, "message": "Student detail not found."}), 404

        item = detail_rows[student_index]
        answers = item.get("QuestionResults") or []

        return jsonify({
            "report": {
                "id": export["id"],
                "name": export["report_name"],
            },
            "student": {
                "cnic": item.get("CNIC") or "",
                "seat_no": item.get("SeatNumber") or "",
                "name": item.get("Name") or "",
                "father_name": item.get("FatherName") or "",
                "correct": int(item.get("Correct") or 0),
                "total": int(item.get("Total") or 0),
                "score": float(item.get("Score") or 0.0),
                "match_source": item.get("MatchSource") or "ocr",
            },
            "answers": answers,
        })

    @app.route("/api/reports/<int:report_id>/matrix", methods=["GET"])
    @require_auth
    def report_matrix(report_id: int):
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, report_name, report_type, created_by, created_at, details_json
            FROM report_exports
            WHERE id = ?
            """,
            (report_id,),
        )
        export = cursor.fetchone()
        conn.close()

        if not export:
            return jsonify({"success": False, "message": "Report not found."}), 404

        details_json = export["details_json"] or "[]"
        try:
            detail_rows = json.loads(details_json)
        except json.JSONDecodeError:
            detail_rows = []

        image_names = [str(item.get("Image") or "").strip() for item in detail_rows]
        image_names = [name for name in image_names if name]
        filename_to_path = {}
        if image_names:
            conn = get_connection()
            cursor = conn.cursor()
            placeholders = ",".join(["?"] * len(set(image_names)))
            cursor.execute(
                f"""
                SELECT filename, path
                FROM bubble_sheets
                WHERE filename IN ({placeholders})
                ORDER BY id DESC
                """,
                tuple(set(image_names)),
            )
            for row in cursor.fetchall():
                filename = row["filename"]
                if filename not in filename_to_path and row["path"]:
                    filename_to_path[filename] = row["path"]
            conn.close()

        questions = []
        question_seen = set()
        for item in detail_rows:
            for question in item.get("QuestionResults") or []:
                question_id = str(question.get("Question") or "").strip()
                if not question_id or question_id in question_seen:
                    continue
                question_seen.add(question_id)
                questions.append(question_id)

        def _question_sort_key(value: str) -> tuple[int, str]:
            try:
                return int(value), value
            except Exception:
                return 10**9, value

        questions.sort(key=_question_sort_key)

        matrix_rows = []
        for idx, item in enumerate(detail_rows):
            question_map = {}
            for question in item.get("QuestionResults") or []:
                question_id = str(question.get("Question") or "").strip()
                if question_id:
                    question_map[question_id] = question

            answer_cells = []
            for question_id in questions:
                question = question_map.get(question_id) or {}
                answer_cells.append({
                    "question": question_id,
                    "selected": question.get("SelectedOption") or "",
                    "correct": question.get("CorrectOption") or "",
                    "is_correct": bool(question.get("IsCorrect")),
                })

            source_path = str(item.get("SourcePath") or "").strip()
            if not source_path:
                source_path = str(filename_to_path.get(str(item.get("Image") or "").strip()) or "").strip()

            matrix_rows.append({
                "student_index": idx,
                "cnic": item.get("CNIC") or "",
                "seat_no": item.get("SeatNumber") or "",
                "name": item.get("Name") or "",
                "father_name": item.get("FatherName") or "",
                "correct": int(item.get("Correct") or 0),
                "total": int(item.get("Total") or 0),
                "score": float(item.get("Score") or 0.0),
                "match_source": item.get("MatchSource") or "ocr",
                "image_name": item.get("Image") or "",
                "preview_available": bool(source_path and os.path.isfile(source_path)),
                "answers": answer_cells,
            })

        return jsonify({
            "report": {
                "id": export["id"],
                "name": export["report_name"],
                "type": export["report_type"],
                "created_by": export["created_by"],
                "created_at": export["created_at"],
            },
            "questions": questions,
            "rows": matrix_rows,
        })

    @app.route("/api/reports/<int:report_id>/matrix", methods=["PATCH"])
    @require_admin
    def update_report_matrix(report_id: int):
        payload = request.get_json(silent=True) or {}
        student_index = payload.get("student_index")
        question_id = str(payload.get("question_id") or "").strip()
        selected_option = str(payload.get("selected_option") or "").strip().upper()

        if not question_id:
            return jsonify({"success": False, "message": "Question id is required."}), 400

        if selected_option in {"-", "", "BLANK"}:
            selected_option = ""
        elif not (re.fullmatch(r"[A-E](?:/[A-E])?", selected_option) or selected_option in {"A", "B", "C", "D", "E"}):
            return jsonify({"success": False, "message": "Selected option is invalid."}), 400

        try:
            student_index = int(student_index)
        except (TypeError, ValueError):
            return jsonify({"success": False, "message": "Student index is invalid."}), 400

        updated, error = _apply_bubble_answer_change(report_id, student_index, question_id, selected_option)
        if error:
            return jsonify({"success": False, "message": error}), 404

        log_event(g.user["username"], f"Updated bubble answer in report #{report_id} (student {student_index}, question {question_id})", "Success")
        return jsonify({"success": True, "updated": updated})

    @app.route("/api/reports/<int:report_id>/change-requests", methods=["POST"])
    @require_auth
    def create_change_requests(report_id: int):
        payload = request.get_json(silent=True) or {}
        changes = payload.get("changes") or []
        comment = str(payload.get("comment") or "").strip()

        if not isinstance(changes, list) or not changes:
            return jsonify({"success": False, "message": "At least one change is required."}), 400

        conn = get_connection()
        cursor = conn.cursor()
        export = _load_bubble_export(cursor, report_id)
        if not export:
            conn.close()
            return jsonify({"success": False, "message": "Report not found."}), 404

        if str(export["report_type"] or "").strip().lower() != "bubble":
            conn.close()
            return jsonify({"success": False, "message": "Only bubble reports can be changed."}), 400

        try:
            detail_rows = json.loads(export["details_json"] or "[]")
        except json.JSONDecodeError:
            detail_rows = []

        created_at = now_utc().isoformat()
        created_count = 0

        for change in changes:
            try:
                student_index = int(change.get("student_index"))
            except (TypeError, ValueError):
                continue

            question_id = str(change.get("question_id") or "").strip()
            new_selected = str(change.get("new_selected") or "").strip().upper()
            old_selected = str(change.get("old_selected") or "").strip().upper()

            if student_index < 0 or student_index >= len(detail_rows) or not question_id:
                continue

            student_detail = detail_rows[student_index] or {}
            seat_no = str(student_detail.get("SeatNumber") or "").strip()
            student_name = str(student_detail.get("Name") or "").strip()
            image_name = str(student_detail.get("Image") or "").strip()

            cursor.execute(
                """
                INSERT INTO bubble_change_requests
                (report_id, student_index, question_id, old_selected, new_selected, comment, requested_by, requested_role, seat_no, student_name, image_name, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
                """,
                (
                    report_id,
                    student_index,
                    question_id,
                    old_selected,
                    new_selected,
                    comment,
                    g.user["username"],
                    g.user["role"],
                    seat_no,
                    student_name,
                    image_name,
                    created_at,
                ),
            )
            created_count += 1

        conn.commit()
        conn.close()

        if not created_count:
            return jsonify({"success": False, "message": "No valid changes were submitted."}), 400

        log_event(g.user["username"], f"Submitted {created_count} bubble change request(s) for report #{report_id}", "Success")
        return jsonify({"success": True, "count": created_count})

    @app.route("/api/admin/change-requests/count", methods=["GET"])
    @require_admin
    def bubble_change_request_count():
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) AS total FROM bubble_change_requests WHERE status = 'pending'")
        total = int(cursor.fetchone()["total"] or 0)
        conn.close()
        return jsonify({"success": True, "count": total})

    @app.route("/api/admin/change-requests", methods=["GET"])
    @require_admin
    def list_bubble_change_requests():
        status = str(request.args.get("status", "pending")).strip().lower()
        report_id = request.args.get("report_id")
        limit = request.args.get("limit")

        conn = get_connection()
        cursor = conn.cursor()

        query = "SELECT * FROM bubble_change_requests"
        params = []
        filters = []
        if status in {"pending", "approved", "rejected"}:
            filters.append("status = ?")
            params.append(status)
        if report_id not in {None, ""}:
            try:
                report_id = int(report_id)
                filters.append("report_id = ?")
                params.append(report_id)
            except (TypeError, ValueError):
                conn.close()
                return jsonify({"success": False, "message": "Invalid report id."}), 400

        limit_sql = ""
        if limit not in {None, ""}:
            try:
                limit = max(1, min(100, int(limit)))
                limit_sql = " LIMIT ?"
            except (TypeError, ValueError):
                conn.close()
                return jsonify({"success": False, "message": "Invalid limit."}), 400

        if filters:
            query += " WHERE " + " AND ".join(filters)
        query += " ORDER BY id DESC"
        if limit_sql:
            query += limit_sql
            params.append(limit)

        cursor.execute(query, tuple(params))
        rows = [dict(row) for row in cursor.fetchall()]

        report_ids = sorted({int(row.get("report_id")) for row in rows if row.get("report_id") is not None})
        report_map = {}
        if report_ids:
            placeholders = ",".join(["?"] * len(report_ids))
            cursor.execute(
                f"""
                SELECT id, report_name, details_json
                FROM report_exports
                WHERE id IN ({placeholders})
                """,
                tuple(report_ids),
            )
            for rep in cursor.fetchall():
                report_map[int(rep["id"])] = {
                    "name": rep["report_name"],
                    "details_json": rep["details_json"] or "[]",
                }

        enriched = []
        for row in rows:
            item = dict(row)
            rep = report_map.get(int(item.get("report_id") or 0))
            item["report_name"] = rep["name"] if rep else f"Report #{item.get('report_id')}"
            item["seat_no"] = str(item.get("seat_no") or "").strip()
            item["student_name"] = str(item.get("student_name") or "").strip()
            item["image_name"] = str(item.get("image_name") or "").strip()

            if rep:
                try:
                    details = json.loads(rep.get("details_json") or "[]")
                except json.JSONDecodeError:
                    details = []

                idx = int(item.get("student_index") or -1)

                # Use robust index candidates so legacy one-based rows still resolve.
                candidate_indices = [idx]
                if idx > 0:
                    candidate_indices.append(idx - 1)
                if idx + 1 < len(details):
                    candidate_indices.append(idx + 1)

                for candidate in candidate_indices:
                    if candidate < 0 or candidate >= len(details):
                        continue
                    student = details[candidate] or {}
                    if not item["seat_no"]:
                        item["seat_no"] = str(student.get("SeatNumber") or "").strip()
                    if not item["student_name"]:
                        item["student_name"] = str(student.get("Name") or "").strip()
                    if not item["image_name"]:
                        item["image_name"] = str(student.get("Image") or "").strip()
                    if item["seat_no"] or item["student_name"]:
                        break

            enriched.append(item)

        conn.close()
        return jsonify({"success": True, "requests": enriched})

    @app.route("/api/admin/change-requests/<int:request_id>", methods=["PATCH"])
    @require_admin
    def review_bubble_change_request(request_id: int):
        payload = request.get_json(silent=True) or {}
        action = str(payload.get("action", "approve")).strip().lower()
        admin_comment = str(payload.get("comment") or "").strip()

        if action not in {"approve", "reject"}:
            return jsonify({"success": False, "message": "Action must be approve or reject."}), 400

        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM bubble_change_requests WHERE id = ?", (request_id,))
        change_request = cursor.fetchone()
        if not change_request:
            conn.close()
            return jsonify({"success": False, "message": "Change request not found."}), 404

        if change_request["status"] != "pending":
            conn.close()
            return jsonify({"success": False, "message": "Change request already reviewed."}), 400

        reviewed_at = now_utc().isoformat()
        if action == "approve":
            updated, error = _apply_bubble_answer_change(
                int(change_request["report_id"]),
                int(change_request["student_index"]),
                str(change_request["question_id"]),
                str(change_request["new_selected"]),
            )
            if error:
                conn.close()
                return jsonify({"success": False, "message": error}), 400

            cursor.execute(
                """
                UPDATE bubble_change_requests
                SET status = 'approved', reviewed_by = ?, reviewed_at = ?, admin_comment = ?
                WHERE id = ?
                """,
                (g.user["username"], reviewed_at, admin_comment, request_id),
            )
            conn.commit()
            conn.close()
            log_event(g.user["username"], f"Approved bubble change request #{request_id}", "Success")
            return jsonify({"success": True, "status": "approved", "updated": updated})

        cursor.execute(
            """
            UPDATE bubble_change_requests
            SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, admin_comment = ?
            WHERE id = ?
            """,
            (g.user["username"], reviewed_at, admin_comment, request_id),
        )
        conn.commit()
        conn.close()
        log_event(g.user["username"], f"Rejected bubble change request #{request_id}", "Success")
        return jsonify({"success": True, "status": "rejected"})

    @app.route("/api/reports/<int:report_id>/preview/<int:student_index>", methods=["GET"])
    @require_auth
    def report_student_preview(report_id: int, student_index: int):
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT details_json
            FROM report_exports
            WHERE id = ?
            """,
            (report_id,),
        )
        export = cursor.fetchone()

        if not export:
            conn.close()
            return jsonify({"success": False, "message": "Report not found."}), 404

        details_json = export["details_json"] or "[]"
        try:
            detail_rows = json.loads(details_json)
        except json.JSONDecodeError:
            detail_rows = []

        if student_index < 0 or student_index >= len(detail_rows):
            conn.close()
            return jsonify({"success": False, "message": "Student detail not found."}), 404

        item = detail_rows[student_index] or {}
        source_path = str(item.get("SourcePath") or "").strip()

        if not source_path:
            image_name = str(item.get("Image") or "").strip()
            if image_name:
                cursor.execute(
                    """
                    SELECT path
                    FROM bubble_sheets
                    WHERE filename = ?
                    ORDER BY id DESC
                    LIMIT 1
                    """,
                    (image_name,),
                )
                row = cursor.fetchone()
                if row and row["path"]:
                    source_path = row["path"]

        conn.close()

        if not source_path or not os.path.isfile(source_path):
            return jsonify({"success": False, "message": "Preview image not available."}), 404

        try:
            from PIL import Image
            with Image.open(source_path) as img:
                img = img.convert("RGB")
                img.thumbnail((1100, 1100))
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=90)
                buf.seek(0)
        except Exception:
            return jsonify({"success": False, "message": "Unable to render preview."}), 500

        return Response(buf.getvalue(), mimetype="image/jpeg")

    @app.route("/api/bubble/approved-folders", methods=["GET"])
    @require_auth
    def list_approved_folders():
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT DISTINCT folder_path
            FROM bubble_scan_runs
            ORDER BY folder_path ASC
            """
        )
        folders = [row["folder_path"] for row in cursor.fetchall()]

        if g.user["role"] == "Admin":
            conn.close()
            return jsonify({"folders": [f for f in folders if f]})

        approved = []
        for folder in folders:
            if not folder:
                continue
            cursor.execute(
                """
                SELECT COUNT(*) AS pending
                FROM bubble_sheets
                WHERE status = 'folded'
                  AND verified_status = 'pending'
                  AND path LIKE ?
                """,
                (f"{folder}%",),
            )
            pending = cursor.fetchone()["pending"]
            if pending != 0:
                continue

            cursor.execute(
                """
                SELECT COUNT(*) AS approved
                FROM bubble_sheets
                WHERE verified_status = 'approved'
                  AND path LIKE ?
                """,
                (f"{folder}%",),
            )
            approved_count = cursor.fetchone()["approved"]
            if approved_count > 0:
                approved.append(folder)

        conn.close()
        return jsonify({"folders": approved})

    @app.route("/api/answer-keys", methods=["GET"])
    @require_auth
    def list_answer_keys():
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, exam_name, created_by, created_at
            FROM answer_key_uploads
            ORDER BY created_at DESC
            """
        )
        rows = [dict(row) for row in cursor.fetchall()]
        conn.close()
        return jsonify({"keys": rows})

    @app.route("/api/rubrics", methods=["GET"])
    @require_auth
    def list_rubrics():
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, name, subject, grade_level, topic, total_marks, is_active, created_by, created_at
            FROM essay_rubrics
            ORDER BY is_active DESC, created_at DESC, id DESC
            LIMIT 200
            """
        )
        rows = [dict(row) for row in cursor.fetchall()]
        conn.close()
        return jsonify({"rubrics": rows})

    @app.route("/api/rubrics/<int:rubric_id>", methods=["GET"])
    @require_auth
    def get_rubric(rubric_id: int):
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, name, subject, grade_level, topic, total_marks, rubric_json, is_active, created_by, created_at
            FROM essay_rubrics
            WHERE id = ?
            """,
            (rubric_id,),
        )
        row = cursor.fetchone()
        conn.close()

        if not row:
            return jsonify({"success": False, "message": "Rubric not found."}), 404

        item = dict(row)
        try:
            item["rubric"] = json.loads(item.get("rubric_json") or "{}")
        except json.JSONDecodeError:
            item["rubric"] = {}
        item.pop("rubric_json", None)
        return jsonify({"success": True, "rubric": item})

    @app.route("/api/rubrics/generate", methods=["POST"])
    @require_admin
    def generate_rubric_api():
        payload = request.get_json(silent=True) or {}
        subject = str(payload.get("subject", "")).strip()
        grade_level = str(payload.get("grade_level", "")).strip()
        topic = str(payload.get("topic", "")).strip()
        name = str(payload.get("name", "")).strip()
        model = str(payload.get("model", "gemini-2.5-flash")).strip() or "gemini-2.5-flash"
        set_active = bool(payload.get("set_active", True))

        try:
            total_marks = int(payload.get("total_marks", 10))
        except (TypeError, ValueError):
            return jsonify({"success": False, "message": "Total marks must be a number."}), 400

        if not subject or not grade_level or not topic:
            return jsonify({"success": False, "message": "Subject, grade level, and topic are required."}), 400
        if total_marks <= 0:
            return jsonify({"success": False, "message": "Total marks must be greater than 0."}), 400
        if not GEMINI_API_KEY:
            return jsonify({"success": False, "message": "Gemini API key is not configured."}), 500

        try:
            generate_ai_rubric.model = model
            rubric = generate_ai_rubric(subject, grade_level, topic, total_marks)
        except Exception as exc:
            return jsonify({"success": False, "message": f"Rubric generation failed: {exc}"}), 500

        rubric_name = name or f"{subject} - {topic}"
        now = now_utc().isoformat()

        conn = get_connection()
        cursor = conn.cursor()
        if set_active:
            cursor.execute("UPDATE essay_rubrics SET is_active = 0")

        cursor.execute(
            """
            INSERT INTO essay_rubrics
            (name, subject, grade_level, topic, total_marks, rubric_json, is_active, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                rubric_name,
                subject,
                grade_level,
                topic,
                int(total_marks),
                json.dumps(rubric, ensure_ascii=False),
                1 if set_active else 0,
                g.user["username"],
                now,
            ),
        )
        rubric_id = cursor.lastrowid
        conn.commit()
        conn.close()

        log_event(g.user["username"], f"Generated essay rubric #{rubric_id}", "Success")
        return jsonify({"success": True, "rubric_id": rubric_id, "rubric": rubric})

    @app.route("/api/rubrics/<int:rubric_id>/activate", methods=["POST"])
    @require_admin
    def activate_rubric(rubric_id: int):
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id, name FROM essay_rubrics WHERE id = ?", (rubric_id,))
        row = cursor.fetchone()
        if not row:
            conn.close()
            return jsonify({"success": False, "message": "Rubric not found."}), 404

        cursor.execute("UPDATE essay_rubrics SET is_active = 0")
        cursor.execute("UPDATE essay_rubrics SET is_active = 1 WHERE id = ?", (rubric_id,))
        conn.commit()
        conn.close()

        log_event(g.user["username"], f"Activated essay rubric {row['name']}", "Success")
        return jsonify({"success": True})

    @app.route("/api/rubrics/<int:rubric_id>", methods=["PUT"])
    @require_admin
    def update_rubric(rubric_id: int):
        payload = request.get_json(silent=True) or {}
        name = str(payload.get("name", "")).strip()
        subject = str(payload.get("subject", "")).strip()
        grade_level = str(payload.get("grade_level", "")).strip()
        topic = str(payload.get("topic", "")).strip()

        try:
            total_marks = int(payload.get("total_marks", 0))
        except (TypeError, ValueError):
            return jsonify({"success": False, "message": "Total marks must be a number."}), 400

        criteria = payload.get("criteria")
        instructions = payload.get("instructions_for_students")

        if not name or not subject or not grade_level or not topic:
            return jsonify({"success": False, "message": "Name, subject, grade level, and topic are required."}), 400
        if total_marks <= 0:
            return jsonify({"success": False, "message": "Total marks must be greater than 0."}), 400
        if not isinstance(criteria, list) or not criteria:
            return jsonify({"success": False, "message": "At least one criterion is required."}), 400

        normalized_criteria = []
        for row in criteria:
            row_name = str((row or {}).get("name", "")).strip()
            row_desc = str((row or {}).get("description", "")).strip()
            try:
                row_marks = int((row or {}).get("marks", 0))
            except (TypeError, ValueError):
                row_marks = 0

            if not row_name or not row_desc or row_marks <= 0:
                return jsonify({"success": False, "message": "Each criterion must have name, positive marks, and description."}), 400

            normalized_criteria.append({
                "name": row_name,
                "marks": row_marks,
                "description": row_desc,
            })

        normalized_instructions = []
        if isinstance(instructions, list):
            normalized_instructions = [str(item).strip() for item in instructions if str(item).strip()]

        rubric_json = {
            "subject": subject,
            "grade_level": grade_level,
            "topic": topic,
            "total_marks": total_marks,
            "criteria": normalized_criteria,
            "instructions_for_students": normalized_instructions,
        }

        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM essay_rubrics WHERE id = ?", (rubric_id,))
        existing = cursor.fetchone()
        if not existing:
            conn.close()
            return jsonify({"success": False, "message": "Rubric not found."}), 404

        cursor.execute(
            """
            UPDATE essay_rubrics
            SET name = ?, subject = ?, grade_level = ?, topic = ?, total_marks = ?, rubric_json = ?
            WHERE id = ?
            """,
            (
                name,
                subject,
                grade_level,
                topic,
                total_marks,
                json.dumps(rubric_json, ensure_ascii=False),
                rubric_id,
            ),
        )
        conn.commit()
        conn.close()

        log_event(g.user["username"], f"Updated essay rubric #{rubric_id}", "Success")
        return jsonify({"success": True})

    @app.route("/api/essay/evaluate", methods=["POST"])
    @require_auth
    def evaluate_essay_api():
        rubric_id_raw = str(request.form.get("rubric_id", "")).strip()
        file = request.files.get("file")
        essay_text = str(request.form.get("essay_text", "")).strip()
        model = str(request.form.get("model", "gemini-2.5-flash")).strip() or "gemini-2.5-flash"

        if not rubric_id_raw.isdigit():
            return jsonify({"success": False, "message": "Valid rubric is required."}), 400
        if not file:
            return jsonify({"success": False, "message": "Essay image file is required."}), 400
        if not GEMINI_API_KEY:
            return jsonify({"success": False, "message": "Gemini API key is not configured."}), 500

        original_name = file.filename or "essay.png"
        extension = os.path.splitext(original_name)[1].lower()
        if extension not in {".jpg", ".jpeg", ".png"}:
            return jsonify({"success": False, "message": "Only JPG and PNG files are supported."}), 400

        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, name, rubric_json, total_marks
            FROM essay_rubrics
            WHERE id = ?
            """,
            (int(rubric_id_raw),),
        )
        rubric_row = cursor.fetchone()
        if not rubric_row:
            conn.close()
            return jsonify({"success": False, "message": "Rubric not found."}), 404

        try:
            rubric_payload = json.loads(rubric_row["rubric_json"] or "{}")
        except json.JSONDecodeError:
            conn.close()
            return jsonify({"success": False, "message": "Rubric data is corrupted."}), 500

        safe_name = Path(original_name).name.replace(" ", "_")
        stamp = now_utc().strftime("%Y%m%d_%H%M%S")
        stored_name = f"{stamp}_{uuid.uuid4().hex[:8]}_{safe_name}"
        upload_dir = Path(DATA_DIR) / "essay_uploads"
        upload_dir.mkdir(parents=True, exist_ok=True)
        saved_path = upload_dir / stored_name

        try:
            file.save(str(saved_path))
        except Exception:
            conn.close()
            return jsonify({"success": False, "message": "Unable to store uploaded file."}), 500

        try:
            if not essay_text:
                extract_handwritten_text.model = model
                essay_text = extract_handwritten_text(str(saved_path))

            evaluate_ai_essay.model = model
            evaluation = evaluate_ai_essay(essay_text, rubric_payload)
        except Exception as exc:
            conn.close()
            return jsonify({"success": False, "message": f"Essay evaluation failed: {exc}"}), 500

        total_awarded = float(evaluation.get("total_awarded") or 0.0)
        total_marks = float(evaluation.get("total_marks") or rubric_row["total_marks"] or 0.0)
        now = now_utc().isoformat()
        word_count = len([token for token in essay_text.split() if token.strip()])

        cursor.execute(
            """
            INSERT INTO essay_uploads (exam_name, file_name, row_count, created_by, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (rubric_row["name"], original_name, max(1, word_count), g.user["username"], now),
        )

        cursor.execute(
            """
            INSERT INTO essay_evaluations
            (rubric_id, file_name, ocr_text, evaluation_json, total_awarded, total_marks, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                int(rubric_id_raw),
                original_name,
                essay_text,
                json.dumps(evaluation, ensure_ascii=False),
                total_awarded,
                total_marks,
                g.user["username"],
                now,
            ),
        )
        evaluation_id = cursor.lastrowid
        conn.commit()
        conn.close()

        log_event(g.user["username"], f"Evaluated essay #{evaluation_id} with rubric #{rubric_id_raw}", "Success")
        return jsonify({
            "success": True,
            "evaluation_id": evaluation_id,
            "rubric_id": int(rubric_id_raw),
            "rubric_name": rubric_row["name"],
            "essay_text": essay_text,
            "evaluation": evaluation,
        })

    @app.route("/api/essay/evaluations", methods=["GET"])
    @require_auth
    def list_essay_evaluations():
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT ev.id, ev.file_name, ev.total_awarded, ev.total_marks, ev.created_at,
                   ev.created_by, rub.name AS rubric_name, rub.subject, rub.grade_level, rub.topic
            FROM essay_evaluations AS ev
            JOIN essay_rubrics AS rub ON rub.id = ev.rubric_id
            ORDER BY ev.id DESC
            LIMIT 25
            """
        )
        rows = [dict(row) for row in cursor.fetchall()]
        conn.close()
        return jsonify({"evaluations": rows})

    @app.route("/api/essay/evaluations/<int:evaluation_id>", methods=["GET"])
    @require_auth
    def get_essay_evaluation(evaluation_id: int):
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT ev.id, ev.file_name, ev.ocr_text, ev.evaluation_json, ev.total_awarded, ev.total_marks,
                   ev.created_at, ev.created_by,
                   rub.id AS rubric_id, rub.name AS rubric_name, rub.subject, rub.grade_level, rub.topic, rub.rubric_json
            FROM essay_evaluations AS ev
            JOIN essay_rubrics AS rub ON rub.id = ev.rubric_id
            WHERE ev.id = ?
            """,
            (evaluation_id,),
        )
        row = cursor.fetchone()
        conn.close()

        if not row:
            return jsonify({"success": False, "message": "Essay evaluation not found."}), 404

        item = dict(row)
        try:
            item["evaluation"] = json.loads(item.get("evaluation_json") or "{}")
        except json.JSONDecodeError:
            item["evaluation"] = {}
        try:
            item["rubric"] = json.loads(item.get("rubric_json") or "{}")
        except json.JSONDecodeError:
            item["rubric"] = {}

        item.pop("evaluation_json", None)
        item.pop("rubric_json", None)
        return jsonify({"success": True, "evaluation": item})

    @app.route("/api/essay/extract", methods=["POST"])
    @require_auth
    def extract_essay_text_api():
        file = request.files.get("file")
        model = str(request.form.get("model", "gemini-2.5-flash")).strip() or "gemini-2.5-flash"

        if not file:
            return jsonify({"success": False, "message": "Essay image file is required."}), 400
        if not GEMINI_API_KEY:
            return jsonify({"success": False, "message": "Gemini API key is not configured."}), 500

        original_name = file.filename or "essay.png"
        extension = os.path.splitext(original_name)[1].lower()
        if extension not in {".jpg", ".jpeg", ".png"}:
            return jsonify({"success": False, "message": "Only JPG and PNG files are supported."}), 400

        safe_name = Path(original_name).name.replace(" ", "_")
        stamp = now_utc().strftime("%Y%m%d_%H%M%S")
        stored_name = f"{stamp}_{uuid.uuid4().hex[:8]}_{safe_name}"
        upload_dir = Path(DATA_DIR) / "essay_uploads"
        upload_dir.mkdir(parents=True, exist_ok=True)
        saved_path = upload_dir / stored_name

        try:
            file.save(str(saved_path))
        except Exception:
            return jsonify({"success": False, "message": "Unable to store uploaded file."}), 500

        try:
            extract_handwritten_text.model = model
            essay_text = extract_handwritten_text(str(saved_path))
        except Exception as exc:
            return jsonify({"success": False, "message": f"Essay extraction failed: {exc}"}), 500

        return jsonify({
            "success": True,
            "file_name": original_name,
            "essay_text": essay_text,
            "preview_path": str(saved_path),
        })

    @app.route("/api/essay/preview", methods=["GET"])
    @require_auth
    def essay_preview():
        raw_path = str(request.args.get("path") or "").strip()
        if not raw_path:
            return jsonify({"success": False, "message": "Preview path is required."}), 400

        uploads_dir = (Path(DATA_DIR) / "essay_uploads").resolve()
        candidate = Path(raw_path)
        if not candidate.is_absolute():
            candidate = (uploads_dir / candidate).resolve()
        else:
            candidate = candidate.resolve()

        # Restrict previews to the essay_uploads directory only.
        if uploads_dir not in candidate.parents:
            return jsonify({"success": False, "message": "Invalid preview path."}), 400

        if not candidate.is_file():
            return jsonify({"success": False, "message": "Preview file not found."}), 404

        try:
            from PIL import Image
            with Image.open(str(candidate)) as img:
                img = img.convert("RGB")
                img.thumbnail((2400, 2400))
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=92)
                buf.seek(0)
        except Exception:
            return jsonify({"success": False, "message": "Unable to render preview."}), 500

        return Response(buf.getvalue(), mimetype="image/jpeg")

    @app.route("/api/students/import", methods=["POST"])
    @require_admin
    def import_students():
        inserted, skipped, message = _import_student_registry()
        return jsonify({
            "success": inserted > 0,
            "inserted": inserted,
            "skipped": skipped,
            "message": message,
        })

    class BubbleEvaluationError(Exception):
        def __init__(self, message: str, status_code: int = 400):
            super().__init__(message)
            self.message = message
            self.status_code = status_code

    def _build_bubble_evaluation_response(folder_path: str, answer_key_id: int, username: str, job_id: Optional[str] = None) -> dict:
        if not folder_path or not os.path.isdir(folder_path):
            raise BubbleEvaluationError("Folder path is invalid.", 400)

        if not answer_key_id:
            raise BubbleEvaluationError("Answer key is required.", 400)

        if job_id:
            _update_bubble_evaluation_job(job_id, stage="validating", message="Validating inputs...")

        model_path = Path(str(OMR_MODEL_PATH))
        if not model_path.is_file():
            alt_model_path = model_path.with_suffix(".pk")
            if alt_model_path.is_file():
                model_path = alt_model_path
            else:
                raise BubbleEvaluationError(f"OMR model not found: {OMR_MODEL_PATH}", 400)

        conn = get_connection()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT COUNT(*) AS pending
            FROM bubble_sheets
            WHERE status = 'folded'
              AND verified_status = 'pending'
              AND path LIKE ?
            """,
            (f"{folder_path}%",),
        )
        pending = cursor.fetchone()["pending"]
        if pending > 0:
            conn.close()
            raise BubbleEvaluationError("Folder has pending sheets. Ask admin to approve first.", 403)

        cursor.execute(
            """
            SELECT exam_name FROM answer_key_uploads WHERE id = ?
            """,
            (int(answer_key_id),),
        )
        key_row = cursor.fetchone()
        if not key_row:
            conn.close()
            raise BubbleEvaluationError("Answer key not found.", 404)

        cursor.execute(
            """
            SELECT question_id, correct_answer
            FROM answer_key_items
            WHERE upload_id = ?
            """,
            (int(answer_key_id),),
        )
        key_items = cursor.fetchall()

        cursor.execute(
            """
            SELECT path
            FROM bubble_sheets
            WHERE verified_status = 'approved'
              AND path LIKE ?
            ORDER BY path ASC
            """,
            (f"{folder_path}%",),
        )
        approved_rows = cursor.fetchall()

        cursor.execute("SELECT COUNT(*) AS total FROM student_registry")
        registry_total = cursor.fetchone()["total"]
        conn.close()

        approved_paths = [row["path"] for row in approved_rows if row["path"]]
        if not approved_paths:
            raise BubbleEvaluationError("No approved sheets found in this folder.", 400)

        if registry_total == 0:
            _import_student_registry()

        registry = _load_student_registry()

        def _normalize_question_id(value: str) -> str:
            raw = str(value).strip().upper()
            if raw.startswith("Q"):
                raw = raw[1:]
            raw = raw.lstrip("0")
            return raw or "0"

        key_map = {}
        for item in key_items:
            key_map[_normalize_question_id(item["question_id"])] = str(item["correct_answer"]).strip().upper()

        output_root = DATA_DIR / "bubble_results"
        output_root.mkdir(parents=True, exist_ok=True)
        run_folder = output_root / datetime.now().strftime("%Y%m%d_%H%M%S")
        run_folder.mkdir(parents=True, exist_ok=True)
        known_seats_norm = {
            _normalize_seat(seat)
            for seat in registry["by_seat"].keys()
            if _normalize_seat(seat)
        }

        students = []
        eval_failures = []
        total_sheets = len(approved_paths)

        for index, src_path in enumerate(approved_paths, start=1):
            if job_id:
                _update_bubble_evaluation_job(
                    job_id,
                    stage="running",
                    message=f"Evaluating sheet {index} of {total_sheets}...",
                    processed=index - 1,
                    total=total_sheets,
                )

            try:
                result = run_omr_backend(
                    image_path=src_path,
                    model_path=str(model_path),
                    key_path=None,
                    output_dir=str(run_folder),
                    annotate=False,
                    extract_barcode=True,
                    known_seats=known_seats_norm,
                    write_csv=False,
                )
            except Exception as exc:
                eval_failures.append({"path": src_path, "error": str(exc)})
                continue

            raw_answers = result.get("answers") or {}
            answer_rows = []
            for q_raw, selected in raw_answers.items():
                try:
                    q_num = int(q_raw)
                except Exception:
                    continue
                answer_rows.append({
                    "Question": q_num,
                    "SelectedOption": str(selected or "").upper(),
                })

            answer_rows.sort(key=lambda row: int(row["Question"]))
            barcode_text = str(result.get("barcode") or "").strip()
            seat_from_barcode = _normalize_seat(barcode_text)

            students.append({
                "Image": result.get("image") or os.path.basename(src_path),
                "SourcePath": src_path,
                "CNIC": "",
                "SeatNumber": seat_from_barcode or barcode_text,
                "Name": "",
                "FatherName": "",
                "Answers": answer_rows,
                "Barcode": barcode_text,
                "BarcodeCandidates": result.get("barcode_candidates") or [],
                "BarcodeSource": result.get("barcode_source") or "",
            })

        if job_id:
            _update_bubble_evaluation_job(job_id, processed=total_sheets, total=total_sheets)

        if not students:
            first_error = eval_failures[0]["error"] if eval_failures else "No sheets could be evaluated."
            raise BubbleEvaluationError(f"Evaluation failed: {first_error}", 500)

        summary_rows = []
        corrected_students = []
        for student in students:
            cnic_value = student.get("CNIC")
            cnic_norm = _normalize_cnic(cnic_value)
            seat_no = student.get("SeatNumber")
            name = student.get("Name")
            father_name = student.get("FatherName")

            match_source = None
            registry_row = None

            if cnic_norm and len(cnic_norm) == 13:
                registry_row = registry["by_cnic"].get(cnic_norm)
                match_source = "cnic" if registry_row else None

            if not registry_row and seat_no:
                seat_key = _normalize_seat(seat_no)
                registry_row = registry["by_seat"].get(seat_key)
                match_source = "seat" if registry_row else None

            if not registry_row and seat_no:
                approx_row = _best_seat_approx(registry, seat_no)
                if approx_row:
                    registry_row = approx_row
                    match_source = "seat_approx"

            if not registry_row and name and father_name:
                name_key = _normalize_name(name)
                father_key = _normalize_name(father_name)
                if name_key and father_key:
                    key = f"{name_key}|{father_key}"
                    registry_row = registry["by_name_father"].get(key)
                    match_source = "name_father" if registry_row else None

            if not registry_row:
                registry_row, fuzzy_source = _best_registry_match(registry, cnic_norm, seat_no, name, father_name)
                if registry_row:
                    match_source = fuzzy_source or "registry_best"

            if registry_row:
                cnic_value = registry_row.get("cnic") or registry_row.get("cnic_norm") or cnic_value
                seat_no = registry_row.get("seat_no") or seat_no
                name = registry_row.get("name") or name
                father_name = registry_row.get("father_name") or father_name

            corrected_student = dict(student)
            corrected_student["CNIC"] = cnic_value or ""
            corrected_student["SeatNumber"] = seat_no or ""
            corrected_student["Name"] = name or ""
            corrected_student["FatherName"] = father_name or ""
            corrected_student["MatchSource"] = match_source or "ocr"
            corrected_student["SeatFromBarcode"] = student.get("SeatNumber") or ""
            corrected_student["Barcode"] = student.get("Barcode") or ""
            corrected_student["BarcodeCandidates"] = student.get("BarcodeCandidates") or []
            corrected_student["BarcodeSource"] = student.get("BarcodeSource") or ""
            corrected_student["SourcePath"] = student.get("SourcePath") or ""

            answers = student.get("Answers", [])
            correct = 0
            total = 0
            question_results = []
            for ans in answers:
                q = _normalize_question_id(ans.get("Question"))
                selected = str(ans.get("SelectedOption", "")).upper()
                if q not in key_map:
                    continue
                total += 1
                correct_option = key_map[q]
                is_correct = selected == correct_option
                if is_correct:
                    correct += 1
                question_results.append({
                    "Question": q,
                    "SelectedOption": selected,
                    "CorrectOption": correct_option,
                    "IsCorrect": is_correct,
                })
            score = round((correct / total) * 100, 2) if total else 0

            corrected_student["Correct"] = correct
            corrected_student["Total"] = total
            corrected_student["Score"] = score
            corrected_student["QuestionResults"] = question_results
            corrected_students.append(corrected_student)

            summary_rows.append({
                "CNIC": cnic_value,
                "SeatNumber": seat_no,
                "Name": name,
                "FatherName": father_name,
                "Correct": correct,
                "Total": total,
                "Score": score,
                "MatchSource": match_source or "ocr",
            })

        conn = get_connection()
        cursor = conn.cursor()
        now = now_utc().isoformat()
        summary_json = json.dumps(summary_rows, indent=4)
        details_json = json.dumps(corrected_students, indent=4)
        cursor.execute(
            """
            INSERT INTO report_exports (report_name, report_type, created_by, created_at, row_count, summary_json, details_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                f"Bubble Report - {key_row['exam_name']}",
                "bubble",
                username,
                now,
                len(summary_rows),
                summary_json,
                details_json,
            ),
        )
        export_id = cursor.lastrowid
        cursor.execute(
            """
            SELECT summary_json
            FROM report_exports
            WHERE id = ?
            """,
            (export_id,),
        )
        stored_export = cursor.fetchone()
        conn.commit()
        conn.close()

        stored_summary_rows = []
        if stored_export and stored_export["summary_json"]:
            try:
                stored_summary_rows = json.loads(stored_export["summary_json"])
            except json.JSONDecodeError:
                stored_summary_rows = summary_rows
        else:
            stored_summary_rows = summary_rows

        all_students_json = run_folder / "ALL_STUDENTS_RESULTS.json"
        with open(all_students_json, "w") as f:
            json.dump(corrected_students, f, indent=4)

        report_json = run_folder / "report_summary.json"
        with open(report_json, "w") as f:
            json.dump(stored_summary_rows, f, indent=4)

        report_csv = run_folder / "report_summary.csv"
        pd.DataFrame(stored_summary_rows).to_csv(report_csv, index=False)

        log_event(username, f"Bubble evaluation completed for {key_row['exam_name']}", "Success")
        return {
            "success": True,
            "report_json": str(report_json),
            "report_csv": str(report_csv),
            "results": stored_summary_rows,
        }

    def _run_bubble_evaluation_job(job_id: str, folder_path: str, answer_key_id: int, username: str) -> None:
        try:
            response = _build_bubble_evaluation_response(folder_path, answer_key_id, username, job_id=job_id)
            _update_bubble_evaluation_job(
                job_id,
                status="done",
                stage="done",
                message="Evaluation completed.",
                result=response,
                error=None,
            )
        except BubbleEvaluationError as exc:
            _update_bubble_evaluation_job(
                job_id,
                status="error",
                stage="error",
                message=exc.message,
                error=exc.message,
                status_code=exc.status_code,
            )
        except Exception:
            _update_bubble_evaluation_job(
                job_id,
                status="error",
                stage="error",
                message="Evaluation failed.",
                error="Evaluation failed.",
                status_code=500,
            )

    @app.route("/api/bubble/evaluate", methods=["POST"])
    @require_auth
    def evaluate_bubble_sheets():
        payload = request.get_json(silent=True) or {}
        folder_path = str(payload.get("folder_path", "")).strip()
        answer_key_id = payload.get("answer_key_id")

        try:
            response = _build_bubble_evaluation_response(folder_path, int(answer_key_id), g.user["username"])
        except BubbleEvaluationError as exc:
            return jsonify({"success": False, "message": exc.message}), exc.status_code

        return jsonify(response)

    @app.route("/api/bubble/evaluate/start", methods=["POST"])
    @require_auth
    def start_bubble_evaluation():
        payload = request.get_json(silent=True) or {}
        folder_path = str(payload.get("folder_path", "")).strip()
        answer_key_id = payload.get("answer_key_id")

        if not folder_path or not os.path.isdir(folder_path):
            return jsonify({"success": False, "message": "Folder path is invalid."}), 400

        try:
            answer_key_id = int(answer_key_id)
        except (TypeError, ValueError):
            return jsonify({"success": False, "message": "Answer key is required."}), 400

        job_id = uuid.uuid4().hex
        with bubble_evaluation_lock:
            bubble_evaluation_jobs[job_id] = {
                "status": "running",
                "stage": "queued",
                "message": "Evaluation queued in background.",
                "processed": 0,
                "total": 0,
                "result": None,
                "error": None,
                "status_code": 200,
            }

        thread = threading.Thread(
            target=_run_bubble_evaluation_job,
            args=(job_id, folder_path, answer_key_id, g.user["username"]),
            daemon=True,
        )
        thread.start()

        return jsonify({"success": True, "job_id": job_id, "message": "Evaluation started."})

    @app.route("/api/bubble/evaluate/status", methods=["GET"])
    @require_auth
    def bubble_evaluation_status():
        job_id = str(request.args.get("job_id", "")).strip()
        if not job_id:
            return jsonify({"success": False, "message": "Job id is required."}), 400

        job = _get_bubble_evaluation_job(job_id)
        if not job:
            return jsonify({"success": False, "message": "Job not found."}), 404

        status = job.get("status")
        if status == "error":
            return jsonify({"success": False, "status": "error", "message": job.get("message") or job.get("error") or "Evaluation failed."}), int(job.get("status_code") or 500)

        if status == "done":
            return jsonify({"success": True, "status": "done", "message": job.get("message") or "Evaluation completed.", "result": job.get("result")})

        return jsonify({
            "success": True,
            "status": "running",
            "stage": job.get("stage") or "running",
            "message": job.get("message") or "Evaluation running in background.",
            "processed": int(job.get("processed") or 0),
            "total": int(job.get("total") or 0),
        })

    @app.route("/api/session", methods=["GET"])
    @require_auth
    def session_info():
        user = g.user
        return jsonify({
            "id": user["id"],
            "username": user["username"],
            "email": user["email"],
            "role": user["role"],
            "status": user["status"],
        })

    @app.route("/api/users", methods=["GET"])
    @require_admin
    def list_users():
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id, username, email, role, status FROM users ORDER BY id")
        users = [dict(row) for row in cursor.fetchall()]
        conn.close()
        return jsonify({"users": users})

    @app.route("/api/users", methods=["POST"])
    @require_admin
    def create_user():
        payload = request.get_json(silent=True) or {}
        username = str(payload.get("username", "")).strip()
        email = str(payload.get("email", "")).strip()
        password = str(payload.get("password", "")).strip()
        role = str(payload.get("role", "Examiner")).strip() or "Examiner"
        status = str(payload.get("status", "Active")).strip() or "Active"

        if not username or not email or not password:
            return jsonify({"success": False, "message": "Username, email, and password are required."}), 400

        conn = get_connection()
        cursor = conn.cursor()
        now = now_utc().isoformat()
        try:
            cursor.execute(
                """
                INSERT INTO users (username, email, password_hash, role, status, must_reset, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (username, email, hash_password(password), role, status, 0, now, now),
            )
            conn.commit()
        except Exception:
            conn.close()
            return jsonify({"success": False, "message": "User already exists."}), 409

        conn.close()
        log_event(g.user["username"], f"Created user {username}", "Success")
        return jsonify({"success": True})

    @app.route("/api/users/<int:user_id>", methods=["PATCH"])
    @require_admin
    def update_user(user_id: int):
        payload = request.get_json(silent=True) or {}
        username = payload.get("username")
        email = payload.get("email")
        password = payload.get("password")
        role = payload.get("role")
        status = payload.get("status")

        fields = []
        values = []

        if username:
            fields.append("username = ?")
            values.append(str(username).strip())
        if email:
            fields.append("email = ?")
            values.append(str(email).strip())
        if password:
            fields.append("password_hash = ?")
            values.append(hash_password(str(password).strip()))
            fields.append("must_reset = 0")
        if role:
            fields.append("role = ?")
            values.append(str(role).strip())
        if status:
            fields.append("status = ?")
            values.append(str(status).strip())

        if not fields:
            return jsonify({"success": False, "message": "No updates provided."}), 400

        fields.append("updated_at = ?")
        values.append(now_utc().isoformat())
        values.append(user_id)

        conn = get_connection()
        cursor = conn.cursor()
        try:
            cursor.execute(f"UPDATE users SET {', '.join(fields)} WHERE id = ?", values)
            conn.commit()
        except Exception:
            conn.close()
            return jsonify({"success": False, "message": "Update failed."}), 400

        conn.close()
        log_event(g.user["username"], f"Updated user {user_id}", "Success")
        return jsonify({"success": True})

    @app.route("/api/users/<int:user_id>", methods=["DELETE"])
    @require_admin
    def delete_user(user_id: int):
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT role FROM users WHERE id = ?", (user_id,))
        target = cursor.fetchone()

        if not target:
            conn.close()
            return jsonify({"success": False, "message": "User not found."}), 404

        if user_id == g.user["id"]:
            conn.close()
            return jsonify({"success": False, "message": "You cannot delete your own account."}), 400

        if target["role"] == "Admin":
            cursor.execute("SELECT COUNT(*) AS admin_count FROM users WHERE role = 'Admin'")
            admin_count = cursor.fetchone()["admin_count"]
            if admin_count <= 1:
                conn.close()
                return jsonify({"success": False, "message": "Cannot delete the last admin."}), 400

        cursor.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
        conn.close()
        log_event(g.user["username"], f"Deleted user {user_id}", "Success")
        return jsonify({"success": True})

    @app.route("/api/answer-keys/upload", methods=["POST"])
    @require_admin
    def upload_answer_key():
        exam_name = request.form.get("examName", "").strip()
        if not exam_name:
            return jsonify({"success": False, "message": "Exam name is required."}), 400

        file = request.files.get("file")
        if not file:
            return jsonify({"success": False, "message": "File is required."}), 400

        filename = file.filename or ""
        extension = os.path.splitext(filename)[1].lower()
        if extension not in [".csv", ".xlsx", ".xls"]:
            return jsonify({"success": False, "message": "Unsupported file type."}), 400

        try:
            if extension == ".csv":
                data = pd.read_csv(file)
            else:
                data = pd.read_excel(file)
        except Exception:
            return jsonify({"success": False, "message": "Unable to read the file."}), 400

        required = {"question_id", "correct_answer"}
        normalized = {col.strip().lower(): col for col in data.columns}
        if not required.issubset(set(normalized.keys())):
            return jsonify({"success": False, "message": "Required columns: question_id, correct_answer."}), 400

        data = data.rename(columns={
            normalized["question_id"]: "question_id",
            normalized["correct_answer"]: "correct_answer",
        })

        data["question_id"] = data["question_id"].fillna("").astype(str).str.strip()
        data["correct_answer"] = data["correct_answer"].fillna("").astype(str).str.strip()

        # Extract numeric question number if possible (e.g. 'Q1' -> 1)
        import re

        def _extract_qnum(val):
            if val is None:
                return None
            m = re.search(r"(\d+)", str(val))
            return int(m.group(1)) if m else None

        data = data.copy()
        data["qnum"] = data["question_id"].apply(_extract_qnum)

        # Rows that mention a question number
        rows_with_qnum = data[data["qnum"].notnull()]

        # Questions that are present with a non-empty option
        valid_rows = rows_with_qnum[rows_with_qnum["correct_answer"].astype(str).str.strip() != ""].copy()
        present_with_option = set(valid_rows["qnum"].astype(int).tolist())

        # Questions that are present but have empty option
        present_without_option = set(
            rows_with_qnum[rows_with_qnum["correct_answer"].astype(str).str.strip() == ""]["qnum"].astype(int).tolist()
        )

        required_qs = set(range(1, 101))
        out_of_range_questions = sorted([q for q in present_with_option.union(present_without_option) if q not in required_qs])
        missing_questions = sorted([q for q in required_qs if q not in present_with_option])
        missing_options = sorted(list(present_without_option))

        duplicate_questions = sorted(
            valid_rows["qnum"]
            .astype(int)
            .value_counts()
            .loc[lambda s: s > 1]
            .index
            .tolist()
        )

        if out_of_range_questions or missing_questions or missing_options or duplicate_questions:
            errors = {
                "missing_questions": missing_questions,
                "missing_options": missing_options,
                "out_of_range_questions": out_of_range_questions,
                "duplicate_questions": duplicate_questions,
                "expected_question_count": 100,
                "valid_question_count": int(len(present_with_option)),
            }
            return jsonify({"success": False, "message": "Answer key validation failed.", "errors": errors}), 400

        # Must match exactly 100 unique questions (1..100) with answers.
        if present_with_option != required_qs or len(valid_rows) != 100:
            return jsonify({
                "success": False,
                "message": "Answer key must contain exactly 100 unique questions from 1 to 100.",
                "errors": {
                    "expected_question_count": 100,
                    "valid_question_count": int(len(present_with_option)),
                    "row_count": int(len(valid_rows)),
                },
            }), 400

        # Keep only rows that have a numeric qnum and a non-empty option for insertion
        data = valid_rows.copy()

        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM answer_key_uploads WHERE exam_name = ?", (exam_name,))
        existing = cursor.fetchone()
        if existing:
            conn.close()
            return jsonify({"success": False, "message": "Answer key already exists for this exam. Delete it first to re-upload."}), 409

        now = now_utc().isoformat()
        cursor.execute(
            """
            INSERT INTO answer_key_uploads (exam_name, file_name, row_count, created_by, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (exam_name, filename, int(len(data)), g.user["username"], now),
        )
        upload_id = cursor.lastrowid

        # Insert normalized question numbers and answers
        items = [
            (upload_id, int(row["qnum"]), row["correct_answer"].strip())
            for _, row in data.iterrows()
        ]
        cursor.executemany(
            """
            INSERT INTO answer_key_items (upload_id, question_id, correct_answer)
            VALUES (?, ?, ?)
            """,
            items,
        )
        conn.commit()
        conn.close()

        log_event(g.user["username"], f"Uploaded answer key for {exam_name}", "Success")
        return jsonify({"success": True, "count": int(len(data))})

    @app.route("/api/answer-keys/<int:upload_id>", methods=["DELETE"])
    @require_admin
    def delete_answer_key(upload_id: int):
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT exam_name FROM answer_key_uploads WHERE id = ?",
            (upload_id,),
        )
        upload = cursor.fetchone()
        if not upload:
            conn.close()
            return jsonify({"success": False, "message": "Answer key not found."}), 404

        cursor.execute("DELETE FROM answer_key_items WHERE upload_id = ?", (upload_id,))
        cursor.execute("DELETE FROM answer_key_uploads WHERE id = ?", (upload_id,))
        conn.commit()
        conn.close()

        log_event(g.user["username"], f"Deleted answer key for {upload['exam_name']}", "Success")
        return jsonify({"success": True})

    @app.route("/api/answer-keys/recent", methods=["GET"])
    @require_admin
    def recent_answer_keys():
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, exam_name, file_name, row_count, created_by, created_at
            FROM answer_key_uploads
            ORDER BY created_at DESC
            LIMIT 5
            """
        )
        uploads = [dict(row) for row in cursor.fetchall()]
        conn.close()
        return jsonify({"uploads": uploads})

    @app.route("/api/answer-keys/preview", methods=["GET"])
    @require_admin
    def preview_answer_key():
        upload_id = request.args.get("upload_id", "").strip()
        limit_param = request.args.get("limit", "15").strip().lower()
        if not upload_id.isdigit():
            return jsonify({"success": False, "message": "Invalid upload id."}), 400

        limit = 15
        if limit_param == "all":
            limit = None
        elif limit_param.isdigit():
            limit = max(1, int(limit_param))

        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT exam_name, file_name, row_count, created_by, created_at
            FROM answer_key_uploads
            WHERE id = ?
            """,
            (int(upload_id),),
        )
        upload = cursor.fetchone()
        if not upload:
            conn.close()
            return jsonify({"success": False, "message": "Upload not found."}), 404

        cursor.execute(
            """
            SELECT question_id, correct_answer
            FROM answer_key_items
            WHERE upload_id = ?
            ORDER BY id ASC
            """,
            (int(upload_id),),
        )
        all_rows = [dict(row) for row in cursor.fetchall()]
        rows = all_rows if limit is None else all_rows[:limit]
        conn.close()

        return jsonify({
            "success": True,
            "upload": dict(upload),
            "rows": rows,
            "total": len(all_rows)
        })

    @app.route("/api/bubble/fold-check", methods=["POST"])
    @require_admin
    def fold_check():
        payload = request.get_json(silent=True) or {}
        folder_path = str(payload.get("folderPath", "")).strip()
        recursive = bool(payload.get("recursive", False))

        if not folder_path:
            return jsonify({"success": False, "message": "Folder path is required."}), 400

        if not os.path.isdir(folder_path):
            return jsonify({"success": False, "message": "Folder path is invalid."}), 400

        try:
            result = scan_folder(folder_path, 0.5, recursive)
        except Exception:
            return jsonify({"success": False, "message": "Unable to run fold detection."}), 500

        response = _store_scan_results(result, folder_path, g.user["username"])
        return jsonify(response)

    @app.route("/api/bubble/fold-check/start", methods=["POST"])
    @require_admin
    def fold_check_start():
        payload = request.get_json(silent=True) or {}
        folder_path = str(payload.get("folderPath", "")).strip()
        recursive = bool(payload.get("recursive", False))

        if not folder_path:
            return jsonify({"success": False, "message": "Folder path is required."}), 400

        if not os.path.isdir(folder_path):
            return jsonify({"success": False, "message": "Folder path is invalid."}), 400

        job_id = uuid.uuid4().hex
        with scan_lock:
            scan_jobs[job_id] = {
                "status": "running",
                "processed": 0,
                "total": 0,
                "result": None,
                "error": None,
            }

        thread = threading.Thread(
            target=_run_scan_job,
            args=(job_id, folder_path, recursive, g.user["username"]),
            daemon=True,
        )
        thread.start()

        return jsonify({"success": True, "job_id": job_id})

    @app.route("/api/bubble/fold-check/status", methods=["GET"])
    @require_admin
    def fold_check_status():
        job_id = str(request.args.get("job_id", "")).strip()
        if not job_id:
            return jsonify({"success": False, "message": "Job id is required."}), 400

        with scan_lock:
            job = scan_jobs.get(job_id)

        if not job:
            return jsonify({"success": False, "message": "Job not found."}), 404

        status = job.get("status")
        if status == "error":
            return jsonify({"success": False, "status": "error", "message": job.get("error")}), 500

        if status == "done":
            return jsonify({"success": True, "status": "done", "result": job.get("result")})

        return jsonify({
            "success": True,
            "status": "running",
            "processed": int(job.get("processed") or 0),
            "total": int(job.get("total") or 0),
        })

    @app.route("/api/bubble/flagged", methods=["GET"])
    @require_admin
    def list_flagged_sheets():
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, filename, path, confidence, scan_id
            FROM bubble_sheets
            WHERE status = 'folded' AND verified_status = 'pending'
            ORDER BY id DESC
            LIMIT 200
            """
        )
        rows = [dict(row) for row in cursor.fetchall()]
        conn.close()
        return jsonify({"rows": rows})

    @app.route("/api/bubble/scan-history", methods=["GET"])
    @require_admin
    def list_scan_history():
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT
                runs.id,
                runs.folder_path,
                runs.created_by,
                runs.created_at,
                COUNT(sheets.id) AS total,
                SUM(CASE WHEN sheets.status = 'folded' AND sheets.verified_status = 'pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN sheets.verified_status = 'approved' THEN 1 ELSE 0 END) AS approved,
                SUM(CASE WHEN sheets.verified_status = 'rejected' THEN 1 ELSE 0 END) AS rejected
            FROM bubble_scan_runs AS runs
            LEFT JOIN bubble_sheets AS sheets
                ON sheets.scan_id = runs.id
            GROUP BY runs.id
            ORDER BY runs.id DESC
            LIMIT 50
            """
        )
        rows = [dict(row) for row in cursor.fetchall()]
        conn.close()
        return jsonify({"rows": rows})

    @app.route("/api/bubble/folders", methods=["GET"])
    @require_admin
    def list_bubble_folders():
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT DISTINCT folder_path
            FROM bubble_scan_runs
            ORDER BY folder_path ASC
            """,
        )
        rows = [row["folder_path"] for row in cursor.fetchall()]
        conn.close()
        return jsonify({"folders": rows})

    @app.route("/api/bubble/scan-history/<int:scan_id>", methods=["GET"])
    @require_admin
    def scan_history_detail(scan_id: int):
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, folder_path, created_by, created_at
            FROM bubble_scan_runs
            WHERE id = ?
            """,
            (scan_id,),
        )
        run = cursor.fetchone()
        if not run:
            conn.close()
            return jsonify({"success": False, "message": "Scan not found."}), 404

        cursor.execute(
            """
            SELECT id, filename, path, confidence, verified_status, verified_by, verified_at, merged_from_path, merged_at
            FROM bubble_sheets
            WHERE scan_id = ? AND status = 'folded'
            ORDER BY id DESC
            LIMIT 200
            """,
            (scan_id,),
        )
        folded_rows = [dict(row) for row in cursor.fetchall()]

        cursor.execute(
            """
            SELECT
                COUNT(id) AS total,
                SUM(CASE WHEN status = 'folded' AND verified_status = 'pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN verified_status = 'approved' THEN 1 ELSE 0 END) AS approved,
                SUM(CASE WHEN verified_status = 'rejected' THEN 1 ELSE 0 END) AS rejected
            FROM bubble_sheets
            WHERE scan_id = ?
            """,
            (scan_id,),
        )
        counts = dict(cursor.fetchone())
        conn.close()

        return jsonify({
            "success": True,
            "run": dict(run),
            "counts": counts,
            "folded_rows": folded_rows,
        })

    @app.route("/api/bubble/scan-history/<int:scan_id>", methods=["DELETE"])
    @require_admin
    def delete_scan_history(scan_id: int):
        conn = get_connection()
        cursor = conn.cursor()
        
        # Verify scan exists
        cursor.execute("SELECT id FROM bubble_scan_runs WHERE id = ?", (scan_id,))
        if not cursor.fetchone():
            conn.close()
            return jsonify({"success": False, "message": "Scan not found."}), 404
        
        try:
            # Delete associated bubble sheets first
            cursor.execute("DELETE FROM bubble_sheets WHERE scan_id = ?", (scan_id,))
            
            # Delete the scan run
            cursor.execute("DELETE FROM bubble_scan_runs WHERE id = ?", (scan_id,))
            
            conn.commit()
            conn.close()
            
            return jsonify({"success": True, "message": "Scan deleted successfully."})
        except Exception as e:
            conn.rollback()
            conn.close()
            return jsonify({"success": False, "message": str(e)}), 500

    @app.route("/api/bubble/flagged/<int:sheet_id>", methods=["PATCH"])
    @require_admin
    def approve_flagged_sheet(sheet_id: int):
        payload = request.get_json(silent=True) or {}
        action = str(payload.get("action", "approve")).lower()
        if action not in {"approve", "reject"}:
            return jsonify({"success": False, "message": "Invalid action."}), 400

        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT filename FROM bubble_sheets WHERE id = ?", (sheet_id,))
        row = cursor.fetchone()
        if not row:
            conn.close()
            return jsonify({"success": False, "message": "Sheet not found."}), 404

        new_status = "approved" if action == "approve" else "rejected"
        cursor.execute(
            """
            UPDATE bubble_sheets
            SET verified_status = ?, verified_by = ?, verified_at = ?
            WHERE id = ?
            """,
            (new_status, g.user["username"], now_utc().isoformat(), sheet_id),
        )
        conn.commit()
        conn.close()
        log_event(g.user["username"], f"{new_status.title()} folded sheet {row['filename']}", "Success")
        return jsonify({"success": True})

    @app.route("/api/bubble/merge-rescan", methods=["POST"])
    @require_admin
    def merge_rescan_results():
        payload = request.get_json(silent=True) or {}
        items = payload.get("items", [])
        scan_id = payload.get("scan_id")

        if not isinstance(items, list) or not items:
            return jsonify({"success": False, "message": "No merge items provided."}), 400

        conn = get_connection()
        cursor = conn.cursor()
        merged = 0
        skipped = 0
        now = now_utc().isoformat()

        for item in items:
            old_id = item.get("old_id")
            source_path = str(item.get("new_path", "")).strip()
            confidence = item.get("confidence")

            if not old_id or not source_path or not os.path.isfile(source_path):
                skipped += 1
                continue

            cursor.execute(
                """
                SELECT id, filename, path
                FROM bubble_sheets
                WHERE id = ? AND verified_status = 'rejected'
                """,
                (int(old_id),),
            )
            row = cursor.fetchone()
            if not row:
                skipped += 1
                continue

            target_path = row["path"]
            os.makedirs(os.path.dirname(target_path), exist_ok=True)

            try:
                shutil.copy2(source_path, target_path)
            except Exception:
                skipped += 1
                continue

            cursor.execute(
                """
                UPDATE bubble_sheets
                SET status = 'clear',
                    confidence = ?,
                    verified_status = 'approved',
                    verified_by = ?,
                    verified_at = ?,
                    scan_id = ?,
                    merged_from_path = ?,
                    merged_at = ?
                WHERE id = ?
                """,
                (confidence, g.user["username"], now, scan_id, source_path, now, row["id"]),
            )
            merged += 1

        conn.commit()
        conn.close()

        log_event(g.user["username"], f"Merged {merged} rescanned sheets", "Success")
        return jsonify({"success": True, "merged": merged, "skipped": skipped})

    @app.route("/api/bubble/merge-folder", methods=["POST"])
    @require_admin
    def merge_folder_results():
        payload = request.get_json(silent=True) or {}
        items = payload.get("items", [])
        target_folder = str(payload.get("target_folder", "")).strip()
        target_scan_id = payload.get("target_scan_id")
        source_scan_id = payload.get("source_scan_id")

        if not isinstance(items, list) or not items:
            return jsonify({"success": False, "message": "No merge items provided."}), 400

        if target_scan_id is None and (not target_folder or not os.path.isdir(target_folder)):
            return jsonify({"success": False, "message": "Target folder is invalid."}), 400

        conn = get_connection()
        cursor = conn.cursor()
        now = now_utc().isoformat()

        if target_scan_id is not None:
            cursor.execute(
                """
                SELECT id, folder_path
                FROM bubble_scan_runs
                WHERE id = ?
                """,
                (int(target_scan_id),),
            )
            row = cursor.fetchone()
            if not row:
                conn.close()
                return jsonify({"success": False, "message": "Target scan not found."}), 404
            target_scan_id = row["id"]
            target_folder = row["folder_path"]
        else:
            cursor.execute(
                """
                SELECT id
                FROM bubble_scan_runs
                WHERE folder_path = ?
                ORDER BY id DESC
                LIMIT 1
                """,
                (target_folder,),
            )
            row = cursor.fetchone()
            if row:
                target_scan_id = row["id"]
            else:
                cursor.execute(
                    """
                    INSERT INTO bubble_scan_runs (folder_path, created_by, created_at)
                    VALUES (?, ?, ?)
                    """,
                    (target_folder, g.user["username"], now),
                )
                target_scan_id = cursor.lastrowid

        merged = 0
        skipped = 0

        for item in items:
            source_path = str(item.get("path", "")).strip()
            filename = str(item.get("filename", "")).strip()
            status = item.get("status")
            confidence = item.get("confidence")

            if not source_path or not filename or not os.path.isfile(source_path):
                skipped += 1
                continue

            dest_path = os.path.join(target_folder, filename)
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)

            same_path = os.path.abspath(dest_path) == os.path.abspath(source_path)
            if not same_path:
                try:
                    shutil.copy2(source_path, dest_path)
                except Exception:
                    skipped += 1
                    continue

            verified_status = "pending" if status == "folded" else "approved"

            cursor.execute(
                """
                INSERT INTO bubble_sheets
                (scan_id, filename, path, status, confidence, verified_status, verified_by, verified_at, merged_from_path, merged_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(path) DO UPDATE SET
                    scan_id = excluded.scan_id,
                    filename = excluded.filename,
                    status = excluded.status,
                    confidence = excluded.confidence,
                    verified_status = excluded.verified_status,
                    verified_by = excluded.verified_by,
                    verified_at = excluded.verified_at,
                    merged_from_path = excluded.merged_from_path,
                    merged_at = excluded.merged_at
                """,
                (
                    target_scan_id,
                    filename,
                    dest_path,
                    status,
                    confidence,
                    verified_status,
                    None,
                    None,
                    source_path,
                    now,
                ),
            )
            merged += 1

        conn.commit()

        if source_scan_id and isinstance(source_scan_id, int) and source_scan_id != target_scan_id:
            cursor.execute("DELETE FROM bubble_sheets WHERE scan_id = ?", (source_scan_id,))
            cursor.execute("DELETE FROM bubble_scan_runs WHERE id = ?", (source_scan_id,))
            conn.commit()
        conn.close()

        log_event(g.user["username"], f"Merged {merged} files into {target_folder}", "Success")
        return jsonify({"success": True, "merged": merged, "skipped": skipped})

    @app.route("/api/bubble/preview", methods=["GET"])
    @require_admin
    def bubble_preview():
        path = request.args.get("path", "").strip()
        if not path or not os.path.isfile(path):
            return jsonify({"success": False, "message": "File not found."}), 404

        try:
            from PIL import Image
            with Image.open(path) as img:
                img = img.convert("RGB")
                img.thumbnail((900, 900))
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=90)
                buf.seek(0)
        except Exception:
            return jsonify({"success": False, "message": "Unable to render preview."}), 500

        return Response(buf.getvalue(), mimetype="image/jpeg")

    @app.route("/api/logs", methods=["GET"])
    @require_admin
    def list_logs():
        query = request.args.get("q", "").strip()
        user_filter = request.args.get("user", "").strip()
        action_filter = request.args.get("action", "").strip()
        status_filter = request.args.get("status", "").strip()
        exact_date = request.args.get("date", "").strip()
        date_from = request.args.get("from", "").strip()
        date_to = request.args.get("to", "").strip()
        try:
            limit = int(request.args.get("limit", "50"))
        except Exception:
            limit = 50
        limit = max(1, min(limit, 200))

        where = []
        params = []

        if query:
            where.append("action LIKE ?")
            params.append(f"%{query}%")
        if user_filter:
            where.append("user = ?")
            params.append(user_filter)
        if action_filter:
            where.append("action = ?")
            params.append(action_filter)
        if status_filter:
            where.append("status = ?")
            params.append(status_filter)
        if exact_date:
            where.append("date(timestamp) = date(?)")
            params.append(exact_date)
        if date_from:
            where.append("date(timestamp) >= date(?)")
            params.append(date_from)
        if date_to:
            where.append("date(timestamp) <= date(?)")
            params.append(date_to)

        where_sql = f"WHERE {' AND '.join(where)}" if where else ""

        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            f"SELECT id, timestamp, user, action, status FROM system_logs {where_sql} ORDER BY timestamp DESC LIMIT ?",
            (*params, limit),
        )
        logs = [dict(row) for row in cursor.fetchall()]

        cursor.execute("SELECT DISTINCT user FROM system_logs ORDER BY user")
        users = [row["user"] for row in cursor.fetchall()]
        cursor.execute("SELECT DISTINCT action FROM system_logs ORDER BY action")
        actions = [row["action"] for row in cursor.fetchall()]

        conn.close()
        return jsonify({"logs": logs, "users": users, "actions": actions})

    @app.route("/api/logs/export", methods=["GET"])
    @require_admin
    def export_logs():
        query = request.args.get("q", "").strip()
        user_filter = request.args.get("user", "").strip()
        action_filter = request.args.get("action", "").strip()
        status_filter = request.args.get("status", "").strip()
        exact_date = request.args.get("date", "").strip()
        date_from = request.args.get("from", "").strip()
        date_to = request.args.get("to", "").strip()

        where = []
        params = []

        if query:
            where.append("action LIKE ?")
            params.append(f"%{query}%")
        if user_filter:
            where.append("user = ?")
            params.append(user_filter)
        if action_filter:
            where.append("action = ?")
            params.append(action_filter)
        if status_filter:
            where.append("status = ?")
            params.append(status_filter)
        if exact_date:
            where.append("date(timestamp) = date(?)")
            params.append(exact_date)
        if date_from:
            where.append("date(timestamp) >= date(?)")
            params.append(date_from)
        if date_to:
            where.append("date(timestamp) <= date(?)")
            params.append(date_to)

        where_sql = f"WHERE {' AND '.join(where)}" if where else ""

        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            f"SELECT timestamp, user, action, status FROM system_logs {where_sql} ORDER BY timestamp DESC",
            params,
        )
        rows = cursor.fetchall()
        conn.close()

        lines = ["timestamp,user,action,status"]
        for row in rows:
            timestamp = row["timestamp"].replace("\"", "\"\"")
            user = row["user"].replace("\"", "\"\"")
            action = row["action"].replace("\"", "\"\"")
            status = row["status"].replace("\"", "\"\"")
            lines.append(f"\"{timestamp}\",\"{user}\",\"{action}\",\"{status}\"")

        csv_content = "\n".join(lines)
        return Response(
            csv_content,
            mimetype="text/csv",
            headers={"Content-Disposition": "attachment; filename=system_logs.csv"},
        )

    @app.route("/api/users/sync-json", methods=["POST"])
    @require_admin
    def sync_users_from_json():
        imported = _sync_users_from_json()
        if imported:
            log_event(g.user["username"], f"Imported {imported} users from users.json", "Success")
        return jsonify({"success": True, "imported": imported})

    return app


def require_auth(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        token = _get_bearer_token()
        if not token:
            return jsonify({"success": False, "message": "Unauthorized"}), 401

        user, token_hash = _get_user_for_token(token)
        if not user:
            return jsonify({"success": False, "message": "Unauthorized"}), 401

        g.user = user
        g.session_token_hash = token_hash
        return func(*args, **kwargs)

    return wrapper


def require_admin(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        token = _get_bearer_token()
        if not token:
            return jsonify({"success": False, "message": "Unauthorized"}), 401

        user, token_hash = _get_user_for_token(token)
        if not user:
            return jsonify({"success": False, "message": "Unauthorized"}), 401

        if user["role"] != "Admin":
            return jsonify({"success": False, "message": "Forbidden"}), 403
        g.user = user
        g.session_token_hash = token_hash
        return func(*args, **kwargs)

    return wrapper


def _get_bearer_token() -> Optional[str]:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth.split(" ", 1)[1].strip()
    return None


def _get_user_for_token(token: str):
    token_hash = hash_token(token)
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT sessions.token_hash, sessions.expires_at, users.*
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ?
        """,
        (token_hash,),
    )
    row = cursor.fetchone()
    if not row:
        conn.close()
        return None, None

    if datetime.fromisoformat(row["expires_at"]) < now_utc():
        cursor.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
        conn.commit()
        conn.close()
        return None, None

    conn.close()
    return row, token_hash


def start_api_server(host: str = "127.0.0.1", port: int = 5000) -> None:
    app = create_app()
    app.run(host=host, port=port, debug=False, use_reloader=False, threaded=True)
