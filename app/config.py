import os
import re
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "app.db"
MODEL_PATH = Path(os.getenv("FOLD_MODEL_PATH", BASE_DIR / "model4_cnn.h5"))
BUBBLE_MASTER_PATH = Path(os.getenv("BUBBLE_MASTER_PATH", DATA_DIR / "master_sheet.tif"))
OMR_MODEL_PATH = Path(os.getenv("OMR_MODEL_PATH", BASE_DIR / "best.pt"))
STUDENT_REGISTRY_DB = Path(os.getenv("STUDENT_REGISTRY_DB", BASE_DIR / "database.db"))

def _read_legacy_sendgrid_api_key() -> str:
	legacy_utils = BASE_DIR / "utils.py"
	if not legacy_utils.is_file():
		return ""

	try:
		content = legacy_utils.read_text(encoding="utf-8")
	except Exception:
		return ""

	match = re.search(r'SENDGRID_API_KEY\s*=\s*["\']([^"\']+)["\']', content)
	return match.group(1).strip() if match else ""


SENDGRID_API_KEY = (os.getenv("SENDGRID_API_KEY", "") or _read_legacy_sendgrid_api_key()).strip()
SENDGRID_FROM_EMAIL = (os.getenv("SENDGRID_FROM_EMAIL", "") or "laraibshuaib838@gmail.com").strip()
APP_RESET_BASE_URL = os.getenv("APP_RESET_BASE_URL", "http://127.0.0.1:8000")

SESSION_TTL_MINUTES = int(os.getenv("SESSION_TTL_MINUTES", "480"))
RESET_TOKEN_TTL_MINUTES = int(os.getenv("RESET_TOKEN_TTL_MINUTES", "30"))

DEFAULT_ADMIN_USERNAME = os.getenv("DEFAULT_ADMIN_USERNAME", "admin")
DEFAULT_ADMIN_PASSWORD = os.getenv("DEFAULT_ADMIN_PASSWORD", "admin123")
DEFAULT_ADMIN_EMAIL = os.getenv("DEFAULT_ADMIN_EMAIL", "admin@example.com")
