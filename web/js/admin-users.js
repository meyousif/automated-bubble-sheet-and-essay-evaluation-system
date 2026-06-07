let adminUsers = [];

function formatInitials(username) {
    if (!username) return "--";
    const parts = username.split(/[._\s]+/).filter(Boolean);
    if (parts.length >= 2) {
        return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return username.slice(0, 2).toUpperCase();
}

function getRoleBadge(role) {
    const roleClass = role === "Admin" ? "badge-role-admin" : "badge-role-user";
    const displayRole = role === "User" ? "Examiner" : role;
    return `<span class="table-badge ${roleClass}">${displayRole}</span>`;
}

function getStatusBadge(status) {
    const statusClass = status === "Active" ? "badge-status-active" : "badge-status-inactive";
    return `<span class="table-badge ${statusClass}">${status}</span>`;
}

function renderUsersTableRows() {
    const session = getSession();
    const currentUsername = session?.username || "";
    const adminCount = adminUsers.filter((user) => user.role === "Admin").length;

    return adminUsers.map((user) => {
        const isCurrentUser = user.username === currentUsername;
        const isLastAdmin = user.role === "Admin" && adminCount <= 1;
        const disableDelete = isCurrentUser || isLastAdmin;
        const deleteMessage = isCurrentUser
            ? "You cannot delete your own account."
            : isLastAdmin
                ? "Cannot delete the last admin."
                : "";
        const deleteTitle = deleteMessage || "Delete User";

        return `
        <tr>
            <td>
                <div class="user-cell">
                    <div class="user-avatar">${formatInitials(user.username)}</div>
                    <strong>${user.username}</strong>
                </div>
            </td>
            <td>${getRoleBadge(user.role)}</td>
            <td>${getStatusBadge(user.status)}</td>
            <td class="actions-cell">
                <button class="icon-action-btn" type="button" title="Edit User" data-user-id="${user.id}" data-action="edit">
                    <i class="fas fa-pen"></i>
                </button>
                <button class="icon-action-btn danger ${disableDelete ? "is-disabled" : ""}" type="button" title="${deleteTitle}" data-user-id="${user.id}" data-action="delete" data-disabled-message="${deleteMessage}">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        </tr>
    `;
    }).join("");
}

function renderUsersTable() {
    const tableBody = document.querySelector(".admin-table tbody");
    if (!tableBody) return;
    tableBody.innerHTML = renderUsersTableRows();

    const footerText = document.querySelector(".admin-table-footer span");
    if (footerText) {
        footerText.textContent = `Showing 1 to ${adminUsers.length} of ${adminUsers.length} results`;
    }
}

function getUserById(id) {
    return adminUsers.find((user) => String(user.id) === String(id)) || null;
}

function openModal(modal) {
    if (!modal) return;
    modal.classList.add("show");
    document.body.style.overflow = "hidden";
}

function closeModal(modal) {
    if (!modal) return;
    modal.classList.remove("show");
    document.body.style.overflow = "";
}

function closeAllModals() {
    document.querySelectorAll(".modal-overlay").forEach((modal) => modal.classList.remove("show"));
    document.body.style.overflow = "";
}

function setEditModalValues(user) {
    if (!user) return;
    const idField = document.getElementById("editUserId");
    const nameField = document.getElementById("editUsername");
    const emailField = document.getElementById("editUserEmail");
    const roleField = document.getElementById("editUserRole");
    const statusToggle = document.getElementById("editUserStatus");

    if (idField) idField.value = user.id;
    if (nameField) nameField.value = user.username;
    if (emailField) emailField.value = user.email || "";
    if (roleField) roleField.value = user.role === "Admin" ? "Admin" : "Examiner";
    if (statusToggle) statusToggle.checked = user.status === "Active";

    const statusLabel = document.getElementById("editUserStatusLabel");
    if (statusLabel) {
        statusLabel.textContent = user.status === "Active" ? "Active" : "Inactive";
    }
}

function setDeleteModalValues(user) {
    const nameSlot = document.getElementById("deleteUserName");
    if (nameSlot && user) {
        nameSlot.textContent = user.username;
    }

    const deleteBtn = document.getElementById("confirmDeleteBtn");
    if (deleteBtn && user) {
        deleteBtn.dataset.userId = user.id;
    }
}

document.addEventListener("DOMContentLoaded", () => {
    if (!protectPage()) return;

    renderAdminShell({
        activePage: "users",
        pageContent: `
            <section class="admin-page-header">
                <div>
                    <h1 class="page-title">User Accounts</h1>
                    <p class="page-subtitle">Manage existing user accounts and their roles.</p>
                </div>

                <button class="admin-primary-btn" id="addNewUserBtn" type="button">
                    <i class="fas fa-plus"></i>
                    <span>Add New User</span>
                </button>
            </section>

            <div class="admin-alert" id="userAlert" role="status"></div>

            <section class="admin-card users-card">
                <table class="admin-table">
                    <thead>
                        <tr>
                            <th>Username</th>
                            <th>Role</th>
                            <th>Status</th>
                            <th class="actions-header">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${renderUsersTableRows()}
                    </tbody>
                </table>

                <div class="admin-table-footer">
                    <span>Showing 0 of 0 results</span>

                    <div class="pager-controls">
                        <button type="button">Previous</button>
                        <button type="button">Next</button>
                    </div>
                </div>
            </section>

            <div class="modal-overlay" id="addUserModal">
                <div class="modal-card user-modal">
                    <div class="modal-header">
                        <h3>Add New User</h3>
                        <button class="modal-close" type="button" data-modal-close>
                            <i class="fas fa-xmark"></i>
                        </button>
                    </div>

                    <div class="modal-body">
                        <div class="modal-field">
                            <label class="form-label" for="addUsername">Username</label>
                            <input class="form-input" id="addUsername" type="text" placeholder="eg. j.smith">
                        </div>

                        <div class="modal-field">
                            <label class="form-label" for="addUserEmail">Email</label>
                            <input class="form-input" id="addUserEmail" type="email" placeholder="name@example.com">
                        </div>

                        <div class="modal-field">
                            <label class="form-label" for="addPassword">Password</label>
                            <input class="form-input" id="addPassword" type="password" placeholder="********">
                            <p class="form-hint">At least 8 characters long</p>
                        </div>

                        <div class="modal-field">
                            <label class="form-label" for="addUserRole">Role</label>
                            <select class="form-input" id="addUserRole">
                                <option value="Examiner" selected>Examiner</option>
                                <option value="Admin">Administrator</option>
                            </select>
                        </div>
                    </div>

                    <div class="modal-footer">
                        <button class="modal-secondary-btn" type="button" data-modal-close>Cancel</button>
                        <button class="modal-primary-btn" type="button" id="createUserBtn">Create User</button>
                    </div>
                </div>
            </div>

            <div class="modal-overlay" id="editUserModal">
                <div class="modal-card user-modal">
                    <div class="modal-header">
                        <h3>Edit User Account</h3>
                        <button class="modal-close" type="button" data-modal-close>
                            <i class="fas fa-xmark"></i>
                        </button>
                    </div>

                    <div class="modal-body">
                        <div class="modal-field">
                            <label class="form-label" for="editUserId">User ID</label>
                            <input class="form-input readonly-input" id="editUserId" type="text" readonly>
                        </div>

                        <div class="modal-field">
                            <label class="form-label" for="editUsername">Username</label>
                            <input class="form-input" id="editUsername" type="text" placeholder="admin.user">
                        </div>

                        <div class="modal-field">
                            <label class="form-label" for="editUserEmail">Email</label>
                            <input class="form-input" id="editUserEmail" type="email" placeholder="name@example.com">
                        </div>

                        <div class="modal-field">
                            <label class="form-label" for="editPassword">Password</label>
                            <input class="form-input" id="editPassword" type="password" placeholder="********">
                        </div>

                        <div class="modal-field">
                            <label class="form-label" for="editUserRole">Role</label>
                            <select class="form-input" id="editUserRole">
                                <option value="Admin">Administrator</option>
                                <option value="Examiner">Examiner</option>
                            </select>
                        </div>

                        <div class="modal-field switch-row">
                            <span class="form-label">Status</span>
                            <label class="switch">
                                <input id="editUserStatus" type="checkbox" checked>
                                <span class="switch-track"><span class="switch-thumb"></span></span>
                                <span class="switch-label" id="editUserStatusLabel">Active</span>
                            </label>
                        </div>
                    </div>

                    <div class="modal-footer">
                        <button class="modal-secondary-btn" type="button" data-modal-close>Cancel</button>
                        <button class="modal-primary-btn" type="button" id="saveUserBtn">Save Changes</button>
                    </div>
                </div>
            </div>

            <div class="modal-overlay" id="deleteUserModal">
                <div class="modal-card user-modal">
                    <div class="modal-header">
                        <h3>Delete User</h3>
                        <button class="modal-close" type="button" data-modal-close>
                            <i class="fas fa-xmark"></i>
                        </button>
                    </div>

                    <div class="modal-body delete-modal-body">
                        <div class="modal-danger-icon">
                            <i class="fas fa-triangle-exclamation"></i>
                        </div>
                        <div>
                            <h4>Are you sure?</h4>
                            <p>You are about to delete the user <strong id="deleteUserName">admin.user</strong>. This action cannot be undone and will remove all access for this account.</p>
                        </div>
                    </div>

                    <div class="modal-footer">
                        <button class="modal-secondary-btn" type="button" data-modal-close>Cancel</button>
                        <button class="modal-primary-btn danger" type="button" id="confirmDeleteBtn">Delete User</button>
                    </div>
                </div>
            </div>
        `
    });

    const addBtn = document.getElementById("addNewUserBtn");
    const addModal = document.getElementById("addUserModal");
    const editModal = document.getElementById("editUserModal");
    const deleteModal = document.getElementById("deleteUserModal");

    if (addBtn && addModal) {
        addBtn.addEventListener("click", () => openModal(addModal));
    }

    document.querySelectorAll("[data-modal-close]").forEach((button) => {
        button.addEventListener("click", () => closeAllModals());
    });

    document.querySelectorAll(".modal-overlay").forEach((overlay) => {
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                closeModal(overlay);
            }
        });
    });

    const tableBody = document.querySelector("tbody");
    if (tableBody) {
        tableBody.addEventListener("click", (event) => {
            const button = event.target.closest("button[data-action]");
            if (!button) return;
            const disabledMessage = button.dataset.disabledMessage;
            if (disabledMessage) {
                showUserAlert(disabledMessage);
                return;
            }
            const user = getUserById(button.dataset.userId);
            if (!user) return;

            if (button.dataset.action === "edit") {
                setEditModalValues(user);
                openModal(editModal);
            }

            if (button.dataset.action === "delete") {
                setDeleteModalValues(user);
                openModal(deleteModal);
            }
        });
    }

    const createBtn = document.getElementById("createUserBtn");
    if (createBtn) {
        createBtn.addEventListener("click", async () => {
            const username = document.getElementById("addUsername").value.trim();
            const email = document.getElementById("addUserEmail").value.trim();
            const password = document.getElementById("addPassword").value.trim();
            const role = document.getElementById("addUserRole").value;

            if (!username || !email || !password) {
                alert("Username, email, and password are required.");
                return;
            }

            const response = await fetch(`${API_BASE}/users`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...getAuthHeaders()
                },
                body: JSON.stringify({ username, email, password, role, status: "Active" })
            });

            if (!response.ok) {
                alert("Unable to create user.");
                return;
            }

            closeModal(addModal);
            await loadUsers();
        });
    }

    const saveBtn = document.getElementById("saveUserBtn");
    if (saveBtn) {
        saveBtn.addEventListener("click", async () => {
            const userId = document.getElementById("editUserId").value;
            const username = document.getElementById("editUsername").value.trim();
            const email = document.getElementById("editUserEmail").value.trim();
            const password = document.getElementById("editPassword").value.trim();
            const role = document.getElementById("editUserRole").value;
            const status = document.getElementById("editUserStatus").checked ? "Active" : "Inactive";

            const payload = {
                username,
                email,
                role,
                status
            };

            if (password) {
                payload.password = password;
            }

            const response = await fetch(`${API_BASE}/users/${userId}`, {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    ...getAuthHeaders()
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                alert("Unable to update user.");
                return;
            }

            closeModal(editModal);
            await loadUsers();
        });
    }

    const deleteBtn = document.getElementById("confirmDeleteBtn");
    if (deleteBtn) {
        deleteBtn.addEventListener("click", async () => {
            const userId = deleteBtn.dataset.userId;
            if (!userId) return;

            const response = await fetch(`${API_BASE}/users/${userId}`, {
                method: "DELETE",
                headers: {
                    "Content-Type": "application/json",
                    ...getAuthHeaders()
                }
            });

            if (!response.ok) {
                alert("Unable to delete user.");
                return;
            }

            closeModal(deleteModal);
            await loadUsers();
        });
    }

    const statusToggle = document.getElementById("editUserStatus");
    const statusLabel = document.getElementById("editUserStatusLabel");
    if (statusToggle && statusLabel) {
        statusToggle.addEventListener("change", () => {
            statusLabel.textContent = statusToggle.checked ? "Active" : "Inactive";
        });
    }

    loadUsers();
});

function showUserAlert(message) {
    const alertBox = document.getElementById("userAlert");
    if (!alertBox) return;
    alertBox.textContent = message;
    alertBox.classList.add("show");

    window.clearTimeout(alertBox.dataset.timerId);
    const timerId = window.setTimeout(() => {
        alertBox.classList.remove("show");
    }, 3500);
    alertBox.dataset.timerId = timerId;
}

async function loadUsers() {
    try {
        const response = await fetch(`${API_BASE}/users`, {
            headers: {
                ...getAuthHeaders()
            }
        });

        if (!response.ok) {
            console.error("Failed to load users");
            return;
        }

        const data = await response.json();
        adminUsers = data.users || [];
        renderUsersTable();
    } catch (error) {
        console.error("User load error:", error);
    }
}