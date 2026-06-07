# Automated Bubble Sheet and Essay Evaluation System

A professional final year capstone project for automated exam processing and evaluation.
This application combines optical mark recognition, essay OCR, rubric-based scoring, and admin reporting in a polished desktop-style interface.

## Project summary

This system is designed to help educators and examiners automatically process bubble-sheet answer forms and handwritten essays. It includes:

- OMR scanning for multiple-choice/bubble-sheet answer extraction
- Essay image OCR and evaluation workflows
- AI-assisted rubric generation for essay grading
- Web-based admin dashboard for report viewing and user management
- Local desktop deployment via Eel with a Flask backend API

## Repository contents

- `app/` - backend API, database initialization, authentication, and server logic
- `web/` - frontend HTML/CSS/JavaScript user interface
- `data/` - application data storage, sample files, and generated outputs
- `best.pt`, `model4_cnn.h5` - model weights used by the OMR and fold detection components
- `main.py` - application entry point for launching the desktop app

## Prerequisites

- Python 3.10 or newer
- Git (for cloning and pushing)

## Setup

From `F:\Final_Software`:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Environment variables

Create a `.env` file in the repository root with the following values:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=your_email@gmail.com
SMTP_PASSWORD=your_gmail_app_password
SMTP_FROM_EMAIL=your_email@gmail.com
SMTP_USE_TLS=true
GEMINI_API_KEY=your_gemini_api_key
DEFAULT_ADMIN_USERNAME=admin
DEFAULT_ADMIN_PASSWORD=admin123
DEFAULT_ADMIN_EMAIL=admin@example.com
```

### Notes

- Use a Gmail App Password for `SMTP_PASSWORD` if using Gmail SMTP.
- `GEMINI_API_KEY` is required only for rubric generation and essay evaluation features.
- `DEFAULT_ADMIN_*` values let the app create the initial admin user on first run.

## Run the app

```powershell
.\.venv\Scripts\Activate.ps1
python main.py
```

Then use the local Eel UI that opens in your browser.

## Default login

- Admin user: `admin`
- Password: `admin123`

If `DEFAULT_ADMIN_USERNAME` or `DEFAULT_ADMIN_PASSWORD` are changed in `.env`, use those values instead.

## Important files and folders

- `users.json` - optional user import source for the backend
- `data/app.db` - application database (generated at runtime; not included in Git)
- `data/sample_answer_key.csv` - sample answer key data
- `data/master_sheet.tif` - sample bubble sheet master image

## GitHub repository

This repository is configured to push only the necessary application code and UI files.
Generated and local files are ignored in `.gitignore`, including:

- `.venv/`
- `data/app.db`
- `database.db`
- `data.db`
- `*.pyc`
- `*.xlsx`
- `essay01.jpeg`, `essay02.jpeg`

## Contributors

- **Yousif Ali** — Lead developer and project owner

## Notes for contributors

- Do not commit local environment folders or generated database files.
- If you add new sample data, update `.gitignore` only if those files should remain local.
