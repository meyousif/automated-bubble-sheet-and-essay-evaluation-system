document.addEventListener("DOMContentLoaded", () => {
    if (!protectPage()) return;

    const session = getSession();
    const roleBadge = document.getElementById("roleBadge");

    if (session && roleBadge) {
        roleBadge.textContent = session.role || "Examiner";
    }

    initializeTopbarMenu();
    initializeLogoutModal();
});

// ========== TOPBAR & LOGOUT ==========
function initializeTopbarMenu() {
    const topbarDropdownBtn = document.getElementById("topbarDropdownBtn");
    const userMenu = document.getElementById("userMenu");
    const logoutMenuBtn = document.getElementById("logoutMenuBtn");

    if (topbarDropdownBtn && userMenu) {
        topbarDropdownBtn.addEventListener("click", () => {
            userMenu.classList.toggle("active");
        });

        document.addEventListener("click", (e) => {
            if (!e.target.closest(".user-circle") && !e.target.closest(".dropdown-btn") && !e.target.closest(".user-menu")) {
                userMenu.classList.remove("active");
            }
        });
    }

    if (logoutMenuBtn) {
        logoutMenuBtn.addEventListener("click", () => {
            document.getElementById("logoutModal").classList.add("active");
        });
    }
}

function initializeLogoutModal() {
    const logoutModal = document.getElementById("logoutModal");
    const logoutCancelBtn = document.getElementById("logoutCancelBtn");
    const logoutConfirmBtn = document.getElementById("logoutConfirmBtn");
    const logoutModalCloseBtn = document.getElementById("logoutModalCloseBtn");

    if (logoutCancelBtn) {
        logoutCancelBtn.addEventListener("click", () => {
            logoutModal.classList.remove("active");
        });
    }

    if (logoutModalCloseBtn) {
        logoutModalCloseBtn.addEventListener("click", () => {
            logoutModal.classList.remove("active");
        });
    }

    if (logoutConfirmBtn) {
        logoutConfirmBtn.addEventListener("click", logoutUser);
    }
}