async function attemptLogin() {
    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value.trim();
    const errorMessage = document.getElementById("errorMessage");

    errorMessage.textContent = "";

    if (!username || !password) {
        errorMessage.textContent = "Please enter username and password.";
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/login`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (data.success) {
            setSession({
                username: data.username,
                name: data.name,
                role: data.role,
                sessionToken: data.sessionToken,
                isAuthenticated: true
            });

            window.location.href = data.redirect;
        } else {
            errorMessage.textContent = data.message || "Login failed.";
        }
    } catch (error) {
        console.error("Login error:", error);
        errorMessage.textContent = "Unable to connect to system.";
    }
}

async function exitApp() {
    try {
        await eel.exit_application()();
    } catch (error) {
        console.error("Exit error:", error);
        window.close();
    }
}

document.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
        attemptLogin();
    }
});