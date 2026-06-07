import json
import os
import random
import smtplib
from pathlib import Path
from email.message import EmailMessage

from dotenv import load_dotenv


load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
USERS_FILE = BASE_DIR / "users.json"


def load_users(file_path: Path = USERS_FILE) -> dict:
    if not file_path.exists():
        return {}

    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    return data if isinstance(data, dict) else {}


def save_users(users: dict, file_path: Path = USERS_FILE) -> None:
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(users, f, indent=4)


def generate_otp(length: int = 6) -> str:
    if length < 4:
        length = 6
    start = 10 ** (length - 1)
    end = (10 ** length) - 1
    return str(random.randint(start, end))


def send_otp_email(to_email: str, otp: str) -> tuple[bool, str]:
    smtp_host = os.getenv("SMTP_HOST", "").strip()
    smtp_port_raw = os.getenv("SMTP_PORT", "587").strip()
    smtp_username = os.getenv("SMTP_USERNAME", "").strip()
    smtp_password = "".join(os.getenv("SMTP_PASSWORD", "").split())
    smtp_from_email = os.getenv("SMTP_FROM_EMAIL", "").strip() or smtp_username
    smtp_use_tls = os.getenv("SMTP_USE_TLS", "true").strip().lower() in {"1", "true", "yes", "on"}

    if not smtp_host:
        return False, "Missing SMTP_HOST in environment."
    if not smtp_port_raw.isdigit():
        return False, "SMTP_PORT must be a number."
    smtp_port = int(smtp_port_raw)

    if not smtp_username:
        return False, "Missing SMTP_USERNAME in environment."
    if not smtp_password:
        return False, "Missing SMTP_PASSWORD in environment."
    if not smtp_from_email:
        return False, "Missing SMTP_FROM_EMAIL in environment."

    message = EmailMessage()
    message["Subject"] = "Your OTP for Password Reset"
    message["From"] = smtp_from_email
    message["To"] = to_email
    message.set_content(f"Your OTP is: {otp}. It will expire in 10 minutes.")

    try:
        with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as client:
            if smtp_use_tls:
                client.starttls()
            client.login(smtp_username, smtp_password)
            client.send_message(message)
        return True, "OTP sent successfully."
    except Exception as exc:
        return False, f"SMTP send failed: {exc}"
