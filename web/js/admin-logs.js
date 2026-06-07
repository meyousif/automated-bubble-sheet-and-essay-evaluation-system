let logsLoadController = null;
let logsLoadSeq = 0;
let cachedLogFilters = null;
let cachedLogFiltersAt = 0;
const LOG_FILTER_CACHE_TTL_MS = 60000;

function getCachedLogFilters() {
    if (!cachedLogFilters) return null;
    if ((Date.now() - cachedLogFiltersAt) > LOG_FILTER_CACHE_TTL_MS) return null;
    return cachedLogFilters;
}

function setCachedLogFilters(users, actions) {
    cachedLogFilters = { users, actions };
    cachedLogFiltersAt = Date.now();
}

document.addEventListener("DOMContentLoaded", () => {
    if (!protectPage()) return;

    renderAdminShell({
        activePage: "logs",
        pageContent: `
            <section class="admin-page-header">
                <div>
                    <h1 class="page-title">System Logs</h1>
                    <p class="page-subtitle">Review and audit system activities, user actions, and statuses for debugging and compliance.</p>
                </div>
            </section>

            <section class="logs-card">
                <div class="logs-header">
                    <div class="report-list-header">
                        <i class="fas fa-filter"></i>
                        <span>Filter Logs</span>
                    </div>
                    <div class="logs-actions">
                        <button type="button" id="refreshLogsBtn"><i class="fas fa-rotate"></i> Refresh</button>
                        <button type="button" id="exportLogsBtn"><i class="fas fa-file-arrow-down"></i> Export</button>
                    </div>
                </div>

                <div class="logs-filters">
                    <input class="filter-input" id="logSearchInput" type="text" placeholder="Search actions...">
                    <select class="filter-input" id="logUserFilter">
                        <option value="">All Users</option>
                    </select>
                    <select class="filter-input" id="logActionFilter">
                        <option value="">All Actions</option>
                    </select>
                    <select class="filter-input" id="logStatusFilter">
                        <option value="">All Statuses</option>
                        <option value="Success">Success</option>
                        <option value="Pending">Pending</option>
                        <option value="Failed">Failed</option>
                        <option value="Info">Info</option>
                    </select>
                    <input class="filter-input" id="logDateFilter" type="date" aria-label="Log date">
                </div>
            </section>

            <section class="logs-card">
                <div class="report-list-header">
                    <i class="fas fa-clock"></i>
                    <span>Recent System Activities</span>
                </div>

                <table class="logs-table">
                    <thead>
                        <tr>
                            <th></th>
                            <th>Timestamp</th>
                            <th>User</th>
                            <th>Action</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody id="logsTableBody"></tbody>
                </table>

                <div class="logs-footer" id="logsFooter">Showing 0 entries</div>
            </section>
        `
    });

    bindLogEvents();
    loadLogs();
});

function bindLogEvents() {
    const refreshBtn = document.getElementById("refreshLogsBtn");
    if (refreshBtn) refreshBtn.addEventListener("click", loadLogs);

    const exportBtn = document.getElementById("exportLogsBtn");
    if (exportBtn) exportBtn.addEventListener("click", exportLogs);

    const inputs = [
        "logSearchInput",
        "logUserFilter",
        "logActionFilter",
        "logStatusFilter",
        "logDateFilter"
    ];

    inputs.forEach((id) => {
        const element = document.getElementById(id);
        if (!element) return;
        element.addEventListener("change", loadLogs);
        element.addEventListener("keyup", (event) => {
            if (id === "logSearchInput" && event.key === "Enter") {
                loadLogs();
            }
        });
    });
}

function getLogQueryParams() {
    const params = new URLSearchParams();
    const query = document.getElementById("logSearchInput")?.value.trim() || "";
    const user = document.getElementById("logUserFilter")?.value || "";
    const action = document.getElementById("logActionFilter")?.value || "";
    const status = document.getElementById("logStatusFilter")?.value || "";
    const date = document.getElementById("logDateFilter")?.value || "";

    if (query) params.set("q", query);
    if (user) params.set("user", user);
    if (action) params.set("action", action);
    if (status) params.set("status", status);
    if (date) params.set("date", date);

    return params;
}

function statusClass(status) {
    if (status === "Success") return "status-success";
    if (status === "Pending") return "status-pending";
    if (status === "Failed") return "status-failed";
    return "status-info";
}

function statusIcon(status) {
    if (status === "Success") return "fa-circle-check";
    if (status === "Pending") return "fa-hourglass";
    if (status === "Failed") return "fa-circle-xmark";
    return "fa-circle-info";
}

async function loadLogs() {
    const currentSeq = ++logsLoadSeq;
    if (logsLoadController) {
        logsLoadController.abort();
    }

    logsLoadController = new AbortController();
    const params = getLogQueryParams();
    if (!params.has("limit")) {
        params.set("limit", "50");
    }

    try {
        const response = await fetch(`${API_BASE}/logs?${params.toString()}`, {
            signal: logsLoadController.signal,
            headers: {
                ...getAuthHeaders()
            }
        });

        if (currentSeq !== logsLoadSeq) return;

        if (!response.ok) {
            console.error("Failed to load logs");
            return;
        }

        const data = await response.json();
        renderLogTable(data.logs || []);
        const cachedFilters = getCachedLogFilters();
        const users = Array.isArray(data.users) ? data.users : [];
        const actions = Array.isArray(data.actions) ? data.actions : [];
        if (!cachedFilters || users.length !== cachedFilters.users.length || actions.length !== cachedFilters.actions.length) {
            setCachedLogFilters(users, actions);
            populateFilters(users, actions);
        } else {
            populateFilters(cachedFilters.users, cachedFilters.actions);
        }
    } catch (error) {
        if (error && error.name === "AbortError") return;
        console.error("Log load error:", error);
    } finally {
        if (currentSeq === logsLoadSeq) {
            logsLoadController = null;
        }
    }
}

async function exportLogs() {
    const params = getLogQueryParams();
    const url = `${API_BASE}/logs/export?${params.toString()}`;
    try {
        const response = await fetch(url, {
            headers: {
                ...getAuthHeaders()
            }
        });

        if (!response.ok) {
            console.error("Failed to export logs");
            return;
        }

        const blob = await response.blob();
        const downloadUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = downloadUrl;
        link.download = "system_logs.csv";
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(downloadUrl);
    } catch (error) {
        console.error("Export error:", error);
    }
}

function renderLogTable(logs) {
    const body = document.getElementById("logsTableBody");
    const footer = document.getElementById("logsFooter");
    if (!body) return;

    body.innerHTML = logs.map((log) => {
        const timestamp = new Date(log.timestamp).toLocaleString();
        return `
            <tr class="log-row">
                <td><span class="log-icon"><i class="fas fa-chevron-right"></i></span></td>
                <td>${timestamp}</td>
                <td class="log-user"><i class="fas fa-user"></i> ${log.user}</td>
                <td>${log.action}</td>
                <td><span class="status-pill ${statusClass(log.status)}"><i class="fas ${statusIcon(log.status)}"></i> ${log.status}</span></td>
            </tr>
        `;
    }).join("");

    if (footer) {
        footer.textContent = `Showing ${logs.length} entries`;
    }
}

function populateFilters(users, actions) {
    const userSelect = document.getElementById("logUserFilter");
    const actionSelect = document.getElementById("logActionFilter");

    if (userSelect) {
        const current = userSelect.value;
        userSelect.innerHTML = `<option value="">All Users</option>` + users.map((user) => `<option value="${user}">${user}</option>`).join("");
        userSelect.value = current;
    }

    if (actionSelect) {
        const current = actionSelect.value;
        actionSelect.innerHTML = `<option value="">All Actions</option>` + actions.map((action) => `<option value="${action}">${action}</option>`).join("");
        actionSelect.value = current;
    }
}
