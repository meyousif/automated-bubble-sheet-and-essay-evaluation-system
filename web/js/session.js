const API_BASE = "http://127.0.0.1:5000/api";

function getLoginUrl() {
    const origin = window.location.origin;
    if (origin && origin !== "null" && origin.startsWith("http")) {
        return `${origin}/index.html?ts=${Date.now()}`;
    }
    return `./index.html?ts=${Date.now()}`;
}

function getSession() {
    const raw = localStorage.getItem("intellilearn_session");
    return raw ? JSON.parse(raw) : null;
}

function setSession(session) {
    localStorage.setItem("intellilearn_session", JSON.stringify(session));
}

function clearSession() {
    localStorage.removeItem("intellilearn_session");
}

function getSessionToken() {
    const session = getSession();
    return session?.sessionToken || "";
}

function getAuthHeaders() {
    const token = getSessionToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
}

function protectPage() {
    const session = getSession();

    if (!session || !session.isAuthenticated || !session.sessionToken) {
        window.location.href = getLoginUrl();
        return false;
    }

    return true;
}

function isAdminRole(role) {
    const normalized = String(role || "").trim().toLowerCase();
    return normalized === "admin" || normalized === "administrator" || normalized === "super admin";
}

function getCurrentPageName() {
    const path = window.location.pathname || "";
    return path.split("/").pop().toLowerCase();
}

function getSidebarConfig(isAdmin) {
    if (isAdmin) {
        return [
            { key: "dashboard", href: "dashboard.html", icon: "fas fa-border-all", label: "Dashboard" },
            { key: "admin-users", href: "admin-users.html", icon: "fas fa-user-group", label: "User Management" },
            { key: "admin-keys", href: "admin-answer-keys.html", icon: "fas fa-key", label: "Answer Key Management" },
            { key: "admin-upload", href: "admin-bubble-upload.html", icon: "fas fa-upload", label: "Bubble Sheet Upload" },
            { key: "admin-rubrics", href: "admin-rubrics.html", icon: "fas fa-pen-ruler", label: "Essay Rubric Management" },
            { key: "bubble", href: "bubble.html", icon: "fas fa-file-alt", label: "Bubble Sheet Evaluation" },
            { key: "essay", href: "essay.html", icon: "fas fa-file-lines", label: "Essay Evaluation" },
            { key: "reports", href: "admin-reports.html", icon: "fas fa-chart-column", label: "Result" },
            { key: "admin-logs", href: "admin-logs.html", icon: "fas fa-wave-square", label: "System Logs" }
        ];
    }

    return [
        { key: "dashboard", href: "dashboard.html", icon: "fas fa-border-all", label: "Dashboard" },
        { key: "bubble", href: "bubble.html", icon: "fas fa-file-alt", label: "Bubble Sheet Evaluation" },
        { key: "essay", href: "essay.html", icon: "fas fa-file-lines", label: "Essay Evaluation" },
        { key: "reports", href: "reports.html", icon: "fas fa-chart-column", label: "Result" }
    ];
}

function resolveActiveTabKey() {
    const page = getCurrentPageName();
    const map = {
        "dashboard.html": "dashboard",
        "bubble.html": "bubble",
        "essay.html": "essay",
        "reports.html": "reports",
        "admin-reports.html": "reports",
        "admin-users.html": "admin-users",
        "admin-answer-keys.html": "admin-keys",
        "admin-bubble-upload.html": "admin-upload",
        "admin-rubrics.html": "admin-rubrics",
        "admin-logs.html": "admin-logs"
    };
    return map[page] || "";
}

function applyRoleBasedSidebar() {
    const nav = document.querySelector(".sidebar .sidebar-nav");
    if (!nav) return;

    const session = getSession();
    const admin = isAdminRole(session?.role);
    const activeKey = resolveActiveTabKey();
    const links = getSidebarConfig(admin);

    nav.innerHTML = links.map((item) => `
        <a class="nav-link ${item.key === activeKey ? "active" : ""}" href="${item.href}">
            <i class="${item.icon}"></i>
            <span>${item.label}</span>
        </a>
    `).join("");
}

async function loadSharedAdminNotifications() {
    const badge = document.getElementById("sharedNotifyBadge");
    const dot = document.getElementById("sharedNotifyDot");
    const list = document.getElementById("sharedNotifyList");
    if (!badge || !list) return;

    try {
        const countRes = await fetch(`${API_BASE}/admin/change-requests/count`, {
            headers: { ...getAuthHeaders() }
        });
        const countData = await countRes.json().catch(() => ({}));
        const count = countRes.ok ? Number(countData.count || 0) : 0;

        if (count > 0) {
            badge.textContent = `${count} Pending Review`;
            badge.style.display = "inline-flex";
            if (dot) dot.style.display = "inline-flex";
        } else {
            badge.style.display = "none";
            if (dot) dot.style.display = "none";
        }

        const listRes = await fetch(`${API_BASE}/admin/change-requests?status=pending&limit=8`, {
            headers: { ...getAuthHeaders() }
        });
        const listData = await listRes.json().catch(() => ({}));
        const requests = listRes.ok && listData.success && Array.isArray(listData.requests)
            ? listData.requests
            : [];

        if (!requests.length) {
            list.innerHTML = `<div class="shared-notify-empty">No pending requests.</div>`;
            return;
        }

        list.innerHTML = requests.map((request) => {
            const reportName = String(request.report_name || `Report #${request.report_id}`);
            const seat = String(request.seat_no || "-");
            const student = String(request.student_name || "Unknown");
            const question = String(request.question_id || "-");
            return `
                <a class="shared-notify-item" href="admin-reports.html?report=${encodeURIComponent(request.report_id)}&request=${encodeURIComponent(request.id)}">
                    <strong>${reportName}</strong>
                    <span>Seat: ${seat} | ${student}</span>
                    <span>Q${question}: ${request.old_selected || "-"} -> ${request.new_selected || "-"}</span>
                </a>
            `;
        }).join("");
    } catch (_error) {
        list.innerHTML = `<div class="shared-notify-empty">Unable to load notifications.</div>`;
        badge.style.display = "none";
        if (dot) dot.style.display = "none";
    }
}

function injectSharedAdminNotifications() {
    const session = getSession();
    if (!isAdminRole(session?.role)) return;

    if (document.getElementById("adminNotifyWrap") || document.getElementById("sharedNotifyWrap")) {
        return;
    }

    const topbarRight = document.querySelector(".topbar-right");
    if (!topbarRight) return;

    const wrapper = document.createElement("div");
    wrapper.className = "shared-notify-wrap";
    wrapper.id = "sharedNotifyWrap";
    wrapper.innerHTML = `
        <button class="shared-notify-btn" id="sharedNotifyBtn" type="button" title="Pending reviews">
            <i class="fas fa-bell"></i>
            <span class="shared-notify-dot" id="sharedNotifyDot" style="display:none;"></span>
        </button>
        <div class="shared-notify-menu" id="sharedNotifyMenu">
            <div class="shared-notify-title">Pending Review Requests</div>
            <div class="shared-notify-list" id="sharedNotifyList">
                <div class="shared-notify-empty">Loading...</div>
            </div>
            <a class="shared-notify-link" href="admin-reports.html">Open Result Tab</a>
        </div>
        <div class="role-badge" id="sharedNotifyBadge" style="display:none;"></div>
    `;

    const userCircle = topbarRight.querySelector(".user-circle");
    if (userCircle) {
        topbarRight.insertBefore(wrapper, userCircle);
    } else {
        topbarRight.prepend(wrapper);
    }

    const btn = document.getElementById("sharedNotifyBtn");
    const menu = document.getElementById("sharedNotifyMenu");

    if (btn && menu) {
        btn.addEventListener("click", (event) => {
            event.stopPropagation();
            menu.classList.toggle("show");
        });

        document.addEventListener("click", (event) => {
            if (!wrapper.contains(event.target)) {
                menu.classList.remove("show");
            }
        });
    }

    loadSharedAdminNotifications();
}



function logoutUser() {
    fetch(`${API_BASE}/logout`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...getAuthHeaders()
        }
    }).finally(() => {
        clearSession();
        window.location.href = getLoginUrl();
    });
}

function initializeTopbarMenu() {
    applyRoleBasedSidebar();

    const dropdownBtn = document.getElementById("topbarDropdownBtn");
    const userMenu = document.getElementById("userMenu");
    const logoutMenuBtn = document.getElementById("logoutMenuBtn");

    if (dropdownBtn && userMenu) {
        dropdownBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            userMenu.classList.toggle("show");
        });

        document.addEventListener("click", (event) => {
            if (!userMenu.contains(event.target) && !dropdownBtn.contains(event.target)) {
                userMenu.classList.remove("show");
            }
        });

        if (logoutMenuBtn) {
            logoutMenuBtn.addEventListener("click", () => {
                userMenu.classList.remove("show");
                openLogoutModal();
            });
        }
        return;
    }

    if (logoutMenuBtn) {
        logoutMenuBtn.addEventListener("click", openLogoutModal);
    }
}

function openLogoutModal() {
    const modal = document.getElementById("logoutModal");
    if (modal) modal.classList.add("show");
}

function closeLogoutModal() {
    const modal = document.getElementById("logoutModal");
    if (modal) modal.classList.remove("show");
}

function initializeLogoutModal() {
    const closeBtn = document.getElementById("logoutModalCloseBtn");
    const cancelBtn = document.getElementById("logoutCancelBtn");
    const confirmBtn = document.getElementById("logoutConfirmBtn");
    const modal = document.getElementById("logoutModal");

    if (!modal) return;

    if (closeBtn) closeBtn.addEventListener("click", closeLogoutModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeLogoutModal);
    if (confirmBtn) confirmBtn.addEventListener("click", logoutUser);

    modal.addEventListener("click", (event) => {
        if (event.target === modal) {
            closeLogoutModal();
        }
    });
}

function refreshOnBackForwardCache() {
    window.addEventListener("pageshow", (event) => {
        if (event.persisted) {
            window.location.reload();
        }
    });
}

refreshOnBackForwardCache();
