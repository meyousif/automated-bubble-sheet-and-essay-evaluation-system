function qsParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
}

function goToLogin() {
    const currentOrigin = window.location.origin;
    const loginUrl = currentOrigin && currentOrigin !== "null" && currentOrigin.startsWith("http")
        ? `${currentOrigin}/index.html?ts=${Date.now()}`
        : `./index.html?ts=${Date.now()}`;
    window.location.href = loginUrl;
}

document.addEventListener('DOMContentLoaded', () => {
    const emailParam = qsParam('email');
    const otpEmail = document.getElementById('emailOtp');
    if (emailParam && otpEmail) {
        otpEmail.value = emailParam;
    }

    const token = qsParam('token');
    if (token) {
        document.getElementById('token-section').style.display = '';
        document.getElementById('otp-section').style.display = 'none';
        window._resetToken = token;
    } else {
        document.getElementById('token-section').style.display = 'none';
        document.getElementById('otp-section').style.display = '';
    }

    const backLink = document.getElementById('backToLoginLink');
    if (backLink) {
        backLink.addEventListener('click', (event) => {
            event.preventDefault();
            goToLogin();
        });
    }
});

async function resetWithToken() {
    const pw = document.getElementById('newPasswordToken').value.trim();
    const msg = document.getElementById('message');
    msg.textContent = '';
    if (!pw) { msg.textContent = 'Password is required.'; return; }
    try {
        const res = await fetch(`${API_BASE}/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: window._resetToken, password: pw }),
        });
        const data = await res.json();
        msg.textContent = data.message || 'Password reset.';
        if (data.success) setTimeout(goToLogin, 1200);
    } catch (err) { msg.textContent = 'Unable to reset password.'; }
}

async function resetWithOtp() {
    const email = document.getElementById('emailOtp').value.trim();
    const otp = document.getElementById('otp').value.trim();
    const pw = document.getElementById('newPasswordOtp').value.trim();
    const msg = document.getElementById('message');
    msg.textContent = '';
    if (!email || !otp || !pw) { msg.textContent = 'Email, OTP and password are required.'; return; }
    try {
        const res = await fetch(`${API_BASE}/reset-password-with-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, otp, password: pw }),
        });
        const data = await res.json();
        msg.textContent = data.message || 'Password reset.';
        if (data.success) setTimeout(goToLogin, 1200);
    } catch (err) { msg.textContent = 'Unable to reset password.'; }
}
