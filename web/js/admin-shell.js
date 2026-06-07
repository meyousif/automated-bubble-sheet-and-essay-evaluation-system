function getAdminSidebar(activePage) {
    return `
        <aside class="sidebar">
            <div class="sidebar-top">
                <div class="brand">
                    <div class="brand-icon">
                        <i class="fas fa-graduation-cap"></i>
                    </div>
                    <div class="brand-text">
                        <h2>Automated Evaluation System</h2>
                        <p>Bubble Sheet &amp; Essay</p>
                    </div>
                </div>

                <nav class="sidebar-nav">
                    <a class="nav-link ${activePage === 'dashboard' ? 'active' : ''}" href="dashboard.html">
                        <i class="fas fa-border-all"></i>
                        <span>Dashboard</span>
                    </a>

                    <a class="nav-link ${activePage === 'users' ? 'active' : ''}" href="admin-users.html">
                        <i class="fas fa-user-group"></i>
                        <span>User Management</span>
                    </a>

                    <a class="nav-link ${activePage === 'keys' ? 'active' : ''}" href="admin-answer-keys.html">
                        <i class="fas fa-key"></i>
                        <span>Answer Key Management</span>
                    </a>

                    <a class="nav-link ${activePage === 'bubble' ? 'active' : ''}" href="admin-bubble-upload.html">
                        <i class="fas fa-upload"></i>
                        <span>Bubble Sheet Upload</span>
                    </a>

                    <a class="nav-link ${activePage === 'rubrics' ? 'active' : ''}" href="admin-rubrics.html">
                        <i class="fas fa-pen-ruler"></i>
                        <span>Essay Rubric Management</span>
                    </a>

                    <a class="nav-link ${activePage === 'bubble-evaluation' ? 'active' : ''}" href="bubble.html">
                        <i class="fas fa-file-alt"></i>
                        <span>Bubble Sheet Evaluation</span>
                    </a>

                    <a class="nav-link ${activePage === 'essay-evaluation' ? 'active' : ''}" href="essay.html">
                        <i class="fas fa-file-lines"></i>
                        <span>Essay Evaluation</span>
                    </a>

                    <a class="nav-link ${activePage === 'reports' ? 'active' : ''}" href="admin-reports.html">
                        <i class="fas fa-chart-column"></i>
                        <span>Result</span>
                    </a>

                    <a class="nav-link ${activePage === 'logs' ? 'active' : ''}" href="admin-logs.html">
                        <i class="fas fa-wave-square"></i>
                        <span>System Logs</span>
                    </a>
                </nav>
            </div>

            <div class="sidebar-footer">
                © Sukkur IBA University<br>
                FYP Code: 22F-20
            </div>
        </aside>
    `;
}

function getAdminTopbar() {
    const session = getSession();
    const roleName = session?.role || "Admin";

    return `
        <header class="topbar admin-topbar">
            <div class="topbar-right">
                <div class="role-badge admin-role-badge">${roleName}</div>

                <button class="btn btn-outline topbar-logout-btn" id="logoutMenuBtn" type="button">
                    Logout
                </button>
            </div>
        </header>
    `;
}

const ADMIN_NOTIFY_CACHE_KEY = "adminNotifyCacheV1";
const ADMIN_NOTIFY_CACHE_TTL_MS = 15000;

function getCachedAdminNotifyData() {
    try {
        const raw = sessionStorage.getItem(ADMIN_NOTIFY_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Number.isFinite(parsed.fetchedAt)) return null;
        if ((Date.now() - parsed.fetchedAt) > ADMIN_NOTIFY_CACHE_TTL_MS) return null;
        return parsed;
    } catch (_error) {
        return null;
    }
}

function setCachedAdminNotifyData(data) {
    try {
        sessionStorage.setItem(ADMIN_NOTIFY_CACHE_KEY, JSON.stringify({
            fetchedAt: Date.now(),
            ...data,
        }));
    } catch (_error) {
        // ignore cache write failures
    }
}

async function loadAdminNotificationBadge() {
    const badge = document.getElementById("changeRequestBadge");
    const dot = document.getElementById("changeRequestDot");
    const list = document.getElementById("notifyMenuList");
    if (!badge) return;

    const cached = getCachedAdminNotifyData();
    if (cached) {
        const count = Number(cached.count || 0);
        if (count > 0) {
            badge.textContent = `${count} Pending Review`;
            badge.style.display = "inline-flex";
            if (dot) dot.style.display = "inline-flex";
        } else {
            badge.style.display = "none";
            if (dot) dot.style.display = "none";
        }

        if (list) {
            const requests = Array.isArray(cached.requests) ? cached.requests : [];
            if (!requests.length) {
                list.innerHTML = `<div class="notify-empty">No pending requests.</div>`;
            } else {
                list.innerHTML = requests.map((request) => {
                    const reportName = String(request.report_name || `Report #${request.report_id}`);
                    const seat = String(request.seat_no || "-");
                    const student = String(request.student_name || "Unknown");
                    const question = String(request.question_id || "-");
                    return `
                        <a class="notify-item" href="admin-reports.html?report=${encodeURIComponent(request.report_id)}&request=${encodeURIComponent(request.id)}">
                            <strong>${reportName}</strong>
                            <span>Seat: ${seat} | ${student}</span>
                            <span>Q${question}: ${request.old_selected || "-"} -> ${request.new_selected || "-"}</span>
                        </a>
                    `;
                }).join("");
            }
        }

        return;
    }

    try {
        const response = await fetch(`${API_BASE}/admin/change-requests/count`, {
            headers: {
                ...getAuthHeaders()
            }
        });

        if (!response.ok) {
            badge.style.display = "none";
            return;
        }

        const data = await response.json();
        const count = Number(data.count || 0);
        if (count > 0) {
            badge.textContent = `${count} Pending Review`;
            badge.style.display = "inline-flex";
            if (dot) dot.style.display = "inline-flex";
        } else {
            badge.style.display = "none";
            if (dot) dot.style.display = "none";
        }

        if (list) {
            const pendingResponse = await fetch(`${API_BASE}/admin/change-requests?status=pending&limit=8`, {
                headers: {
                    ...getAuthHeaders()
                }
            });

            const pendingData = await pendingResponse.json().catch(() => ({}));
            const requests = pendingResponse.ok && pendingData.success && Array.isArray(pendingData.requests)
                ? pendingData.requests
                : [];

            if (!requests.length) {
                list.innerHTML = `<div class="notify-empty">No pending requests.</div>`;
            } else {
                list.innerHTML = requests.map((request) => {
                    const reportName = String(request.report_name || `Report #${request.report_id}`);
                    const seat = String(request.seat_no || "-");
                    const student = String(request.student_name || "Unknown");
                    const question = String(request.question_id || "-");
                    return `
                        <a class="notify-item" href="admin-reports.html?report=${encodeURIComponent(request.report_id)}&request=${encodeURIComponent(request.id)}">
                            <strong>${reportName}</strong>
                            <span>Seat: ${seat} | ${student}</span>
                            <span>Q${question}: ${request.old_selected || "-"} -> ${request.new_selected || "-"}</span>
                        </a>
                    `;
                }).join("");
            }

            setCachedAdminNotifyData({ count, requests });
        }
    } catch (_error) {
        badge.style.display = "none";
        if (dot) dot.style.display = "none";
        if (list) {
            list.innerHTML = `<div class="notify-empty">Unable to load notifications.</div>`;
        }
    }
}

function initializeAdminNotifications() {
    return;
}

function getAdminFooter() {
    return `
        <footer class="admin-footer">
            © 2026 ABS & EES Admin Panel. All rights reserved.
        </footer>
    `;
}

function getSharedLogoutModal() {
    return `
        <div class="modal-overlay" id="logoutModal">
            <div class="modal-card">
                <div class="modal-header">
                    <h3>Confirm Logout</h3>
                    <button class="modal-close" id="logoutModalCloseBtn" type="button">
                        <i class="fas fa-xmark"></i>
                    </button>
                </div>

                <div class="modal-body">
                    Are you sure you want to log out? Any unsaved changes will be lost.
                </div>

                <div class="modal-footer">
                    <button class="modal-secondary-btn" id="logoutCancelBtn" type="button">
                        Cancel
                    </button>
                    <button class="modal-primary-btn" id="logoutConfirmBtn" type="button">
                        Logout
                    </button>
                </div>
            </div>
        </div>
    `;
}

function renderAdminShell({ activePage, pageContent }) {
    const app = document.getElementById("adminApp");

    app.innerHTML = `
        <div class="app-layout admin-layout">
            ${getAdminSidebar(activePage)}

            <section class="main-panel admin-main-panel">
                ${getAdminTopbar()}

                <main class="content-area admin-content-area">
                    ${pageContent}
                </main>

                ${getAdminFooter()}
            </section>
        </div>

        ${getSharedLogoutModal()}
    `;

    initializeTopbarMenu();
    initializeLogoutModal();
    initializeAdminNotifications();
}