# Final_Software

This project is a desktop-style Eel app with a Flask backend API.

## Password Reset Setup

The forgot-password flow sends an OTP by SMTP and then lets the user reset their password.

### Required `.env` values

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=your_email@gmail.com
SMTP_PASSWORD=your_gmail_app_password
SMTP_FROM_EMAIL=your_email@gmail.com
SMTP_USE_TLS=true
```

### Notes

- Use a Gmail App Password, not your normal Gmail password.
- `SMTP_USERNAME` and `SMTP_FROM_EMAIL` should usually be the same email address.
- The app removes spaces from `SMTP_PASSWORD`, so copied App Passwords with spaces still work.

## Flow

1. Open the login page.
2. Click `Forgot password?`.
3. Enter your email and request OTP.
4. Open `reset-password.html`.
5. Enter email, OTP, and new password.
6. Submit to reset the password.

## Run

```powershell
& e:\Final_Software\.venv310\Scripts\python.exe e:/Final_Software/main.py
```
