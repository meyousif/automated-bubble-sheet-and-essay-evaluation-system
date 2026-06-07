async function requestOtp() {
    const email = document.getElementById('email').value.trim();
    const messageEl = document.getElementById('message');
    const continueWrap = document.getElementById('continueWrap');
    const continueLink = document.getElementById('continueLink');
    const existingLink = document.getElementById('resetFormLink');
    if (existingLink) existingLink.remove();
    messageEl.textContent = '';
    if (continueWrap) continueWrap.style.display = 'none';

    if (!email) {
        messageEl.textContent = 'Email is required.';
        return;
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const res = await fetch(`${API_BASE}/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            messageEl.textContent = data.message || 'Unable to request password reset.';
            return;
        }

        messageEl.textContent = data.message || 'If an account exists, an OTP has been sent.';
        const targetUrl = `reset-password.html?email=${encodeURIComponent(email)}&ts=${Date.now()}`;
        if (continueLink) continueLink.href = targetUrl;
        if (continueWrap) continueWrap.style.display = '';

        // Attempt automatic navigation, but keep manual fallback link visible.
        setTimeout(() => {
            window.location.assign(targetUrl);
        }, 500);
    } catch (err) {
        messageEl.textContent = 'Request is taking too long. Use Continue to open reset form.';
        const targetUrl = `reset-password.html?email=${encodeURIComponent(email)}&ts=${Date.now()}`;
        if (continueLink) continueLink.href = targetUrl;
        if (continueWrap) continueWrap.style.display = '';
    }
}

function goToLoginPage() {
    const currentOrigin = window.location.origin;
    const loginUrl = currentOrigin && currentOrigin !== "null" && currentOrigin.startsWith("http")
        ? `${currentOrigin}/index.html?ts=${Date.now()}`
        : `./index.html?ts=${Date.now()}`;
    window.location.href = loginUrl;
}

document.addEventListener('DOMContentLoaded', () => {
    const backLink = document.getElementById('backToLoginLink');
    if (backLink) {
        backLink.addEventListener('click', (event) => {
            event.preventDefault();
            goToLoginPage();
        });
    }
});
