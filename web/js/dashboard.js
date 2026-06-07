function getActivityIcon(type) {
    switch (type) {
        case "upload":
            return {
                icon: "fa-solid fa-cloud-arrow-up",
                className: "icon-blue"
            };
        case "success":
            return {
                icon: "fa-solid fa-check",
                className: "icon-green"
            };
        case "warning":
            return {
                icon: "fa-solid fa-exclamation",
                className: "icon-orange"
            };
        case "report":
            return {
                icon: "fa-solid fa-file-lines",
                className: "icon-purple"
            };
        default:
            return {
                icon: "fa-solid fa-bell",
                className: "icon-blue"
            };
    }
}

async function loadDashboard() {
    try {
        const response = await fetch(`${API_BASE}/dashboard`, {
            headers: {
                ...getAuthHeaders()
            }
        });

        if (!response.ok) {
            throw new Error("Dashboard request failed");
        }

        const data = await response.json();

        document.getElementById("bubbleSheetsCount").textContent =
            data.stats.bubble_sheets_uploaded;

        document.getElementById("essaysCount").textContent =
            data.stats.essays_uploaded;

        document.getElementById("evaluationsCount").textContent =
            data.stats.evaluations_completed;

        document.getElementById("reportsCount").textContent =
            data.stats.reports_generated;

        const activityList = document.getElementById("activityList");
        activityList.innerHTML = "";

        data.recent_activity.forEach((item) => {
            const meta = getActivityIcon(item.type);

            const row = document.createElement("div");
            row.className = "activity-item";

            row.innerHTML = `
                <div class="activity-icon ${meta.className}">
                    <i class="${meta.icon}"></i>
                </div>
                <div class="activity-content">
                    <h4>${item.title}</h4>
                    <p>${item.time}</p>
                </div>
            `;

            activityList.appendChild(row);
        });
    } catch (error) {
        console.error("Dashboard load error:", error);
    }
}

document.addEventListener("DOMContentLoaded", async () => {
    if (!protectPage()) return;

    const session = getSession();
    const roleBadge = document.getElementById("roleBadge");

    if (session && roleBadge) {
        roleBadge.textContent = session.role || "Examiner";
    }

    await loadDashboard();

    initializeTopbarMenu();
    initializeLogoutModal();
});