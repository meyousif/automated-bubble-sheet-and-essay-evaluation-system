try:
    from sendgrid import SendGridAPIClient
    from sendgrid.helpers.mail import Mail
except Exception:
    SendGridAPIClient = None
    Mail = None

from .config import APP_RESET_BASE_URL, SENDGRID_API_KEY, SENDGRID_FROM_EMAIL


def send_reset_email(to_email: str, token: str) -> bool:
    if not SENDGRID_API_KEY or not SENDGRID_FROM_EMAIL or not SendGridAPIClient or not Mail:
        return False

    reset_link = f"{APP_RESET_BASE_URL}/reset-password.html?token={token}"
    subject = "Password Reset Request"
    html = (
        "<p>We received a password reset request.</p>"
        f"<p>Click the link below to reset your password:</p>"
        f"<p><a href=\"{reset_link}\">Reset Password</a></p>"
        "<p>If you did not request this, you can ignore this email.</p>"
    )

    message = Mail(
        from_email=SENDGRID_FROM_EMAIL,
        to_emails=to_email,
        subject=subject,
        html_content=html,
    )

    try:
        client = SendGridAPIClient(SENDGRID_API_KEY)
        client.send(message)
        return True
    except Exception:
        return False


def send_otp_email(to_email: str, otp: str) -> bool:
    if not SENDGRID_API_KEY or not SENDGRID_FROM_EMAIL or not SendGridAPIClient or not Mail:
        return False

    message = Mail(
        from_email=SENDGRID_FROM_EMAIL,
        to_emails=to_email,
        subject="Your OTP for Password Reset",
        html_content=(
            "<p>We received a password reset request.</p>"
            f"<p>Your OTP is: <strong>{otp}</strong></p>"
            "<p>This OTP will expire shortly. If you did not request this, you can ignore this email.</p>"
        ),
    )

    try:
        client = SendGridAPIClient(SENDGRID_API_KEY)
        client.send(message)
        return True
    except Exception:
        return False
