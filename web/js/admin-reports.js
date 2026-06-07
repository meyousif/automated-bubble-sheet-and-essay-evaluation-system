let reportsData = [];
let currentReportId = null;
let currentMatrix = null;
let currentPreviewIndex = 0;
let isPreviewVisible = true;
let currentPreviewObjectUrl = null;
let currentPendingRequests = [];
let focusedRequestId = null;
let initialRequestIdFromQuery = null;

const ADMIN_BUBBLE_CHOICES = ["A", "B", "C", "D", "E", "-"];

function normalizeDateOnly(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function getFilteredAdminReports() {
    const searchText = String(document.getElementById("adminSearchFilter")?.value || "").trim().toLowerCase();
    const typeValue = String(document.getElementById("adminTypeFilter")?.value || "all").toLowerCase();
    const fromValue = document.getElementById("adminFromDateFilter")?.value || "";
    const toValue = document.getElementById("adminToDateFilter")?.value || "";

    const fromDate = fromValue ? new Date(`${fromValue}T00:00:00`) : null;
    const toDate = toValue ? new Date(`${toValue}T23:59:59.999`) : null;

    return reportsData.filter((report) => {
        const reportName = String(report?.name || "").toLowerCase();
        const reportType = String(report?.type || report?.kind || "").toLowerCase();
        const createdAt = report?.created_at ? new Date(report.created_at) : null;

        const matchesSearch = !searchText || reportName.includes(searchText);
        const matchesType = typeValue === "all" || reportType.includes(typeValue);
        const matchesFrom = !fromDate || (createdAt && createdAt >= fromDate);
        const matchesTo = !toDate || (createdAt && createdAt <= toDate);

        return matchesSearch && matchesType && matchesFrom && matchesTo;
    });
}

function applyAdminFilters() {
    const filtered = getFilteredAdminReports();
    renderReportCards(filtered);
}

function bindAdminFilterEvents() {
    const search = document.getElementById("adminSearchFilter");
    const type = document.getElementById("adminTypeFilter");
    const from = document.getElementById("adminFromDateFilter");
    const to = document.getElementById("adminToDateFilter");

    [search, type, from, to].forEach((element) => {
        if (!element) return;
        const eventName = element.tagName === "INPUT" && element.type === "text" ? "input" : "change";
        element.addEventListener(eventName, applyAdminFilters);
    });
}

function renderAdminBubbleAnswerControl(studentIndex, questionId, selectedValue) {
    const value = String(selectedValue || "-").trim() || "-";
    return `
        <input class="admin-bubble-answer-input" type="text" inputmode="latin" maxlength="3" spellcheck="false" autocomplete="off" data-student-index="${studentIndex}" data-question-id="${escapeHtml(questionId)}" value="${escapeHtml(value)}" />
    `;
}

function normalizeAdminBubbleAnswer(rawValue) {
    const value = String(rawValue || "").trim().toUpperCase().replace(/\s+/g, "");
    if (!value) return "-";
    if (value === "-") return value;
    if (/^[A-E]$/.test(value)) return value;
    if (/^[A-E]\/[A-E]$/.test(value)) return value;
    return null;
}

function updateChangeRequestsPanelVisibility(show) {
    const panel = document.getElementById("changeRequestsPanel");
    if (panel) {
        panel.style.display = show ? "block" : "none";
    }
}

function renderChangeRequestsList(requests) {
    const list = document.getElementById("changeRequestsList");
    const count = document.getElementById("changeRequestsCount");
    if (count) {
        count.textContent = `${requests.length} pending`;
    }
    if (!list) return;

    if (!requests.length) {
        list.innerHTML = `<div class="change-request-empty">No pending change requests.</div>`;
        return;
    }

    list.innerHTML = requests.map((request) => `
        <div class="change-request-item ${Number(focusedRequestId) === Number(request.id) ? "is-active" : ""}" data-request-id="${request.id}" data-student-index="${escapeHtml(request.student_index)}">
            <div class="change-request-main">
                <strong>${escapeHtml(request.seat_no || "-")} | ${escapeHtml(request.student_name || "Unknown")}</strong>
                <span>Sheet #${escapeHtml(request.student_index)}</span>
                <span>Q${escapeHtml(request.question_id)}</span>
                <span>${escapeHtml(request.old_selected || "-")} → ${escapeHtml(request.new_selected || "-")}</span>
                <span>By ${escapeHtml(request.requested_by || "-")}</span>
            </div>
            <div class="change-request-comment">${escapeHtml(request.comment || "No comment")}</div>
            <div class="change-request-actions">
                <button class="export-btn change-request-approve-btn" data-request-id="${request.id}" type="button">Approve</button>
                <button class="export-btn change-request-reject-btn" data-request-id="${request.id}" type="button">Reject</button>
            </div>
        </div>
    `).join("");

    list.querySelectorAll(".change-request-approve-btn").forEach((button) => {
        button.addEventListener("click", () => reviewBubbleChangeRequest(Number(button.dataset.requestId), "approve"));
    });
    list.querySelectorAll(".change-request-reject-btn").forEach((button) => {
        button.addEventListener("click", () => reviewBubbleChangeRequest(Number(button.dataset.requestId), "reject"));
    });
    list.querySelectorAll(".change-request-item").forEach((item) => {
        item.addEventListener("click", () => {
            const requestId = Number(item.dataset.requestId);
            if (!Number.isFinite(requestId)) return;
            const req = currentPendingRequests.find((entry) => Number(entry.id) === requestId);
            if (!req) return;
            focusedRequestId = requestId;
            renderChangeRequestsList(currentPendingRequests);
            focusPreviewForRequest(req);
        });
    });
}

async function loadBubbleChangeRequests(reportId) {
    const panel = document.getElementById("changeRequestsPanel");
    const list = document.getElementById("changeRequestsList");
    if (panel) panel.style.display = "block";
    if (list) list.innerHTML = `<div class="change-request-empty">Loading pending requests...</div>`;

    try {
        const response = await fetch(`${API_BASE}/admin/change-requests?status=pending&report_id=${reportId}`, {
            headers: {
                ...getAuthHeaders()
            }
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.message || "Unable to load change requests.");
        }
        const requests = Array.isArray(data.requests) ? data.requests : [];
        currentPendingRequests = requests;
        if (!requests.length) {
            focusedRequestId = null;
            updateChangeRequestsPanelVisibility(false);
            return;
        }

        if (Number.isFinite(initialRequestIdFromQuery) && !Number.isFinite(focusedRequestId)) {
            focusedRequestId = initialRequestIdFromQuery;
            initialRequestIdFromQuery = null;
        }

        if (!Number.isFinite(focusedRequestId) || !requests.some((entry) => Number(entry.id) === Number(focusedRequestId))) {
            focusedRequestId = Number(requests[0].id);
        }

        updateChangeRequestsPanelVisibility(true);
        renderChangeRequestsList(requests);

        const focusedRequest = requests.find((entry) => Number(entry.id) === Number(focusedRequestId)) || requests[0];
        focusPreviewForRequest(focusedRequest);
    } catch (error) {
        console.error("Change requests load error:", error);
        currentPendingRequests = [];
        focusedRequestId = null;
        updateChangeRequestsPanelVisibility(false);
    }
}

function getReportIdFromQuery() {
    const params = new URLSearchParams(window.location.search || "");
    const reportRaw = params.get("report");
    if (!reportRaw) return null;
    const reportId = Number(reportRaw);
    return Number.isFinite(reportId) ? reportId : null;
}

function getRequestIdFromQuery() {
    const params = new URLSearchParams(window.location.search || "");
    const requestRaw = params.get("request");
    if (!requestRaw) return null;
    const requestId = Number(requestRaw);
    return Number.isFinite(requestId) ? requestId : null;
}

function getMatrixRowIndexByStudentIndex(studentIndex) {
    const rows = Array.isArray(currentMatrix?.rows) ? currentMatrix.rows : [];
    const numericIndex = Number(studentIndex);
    if (!rows.length || !Number.isFinite(numericIndex)) return -1;
    return rows.findIndex((row) => Number(row.student_index) === numericIndex);
}

function focusPreviewForRequest(requestEntry) {
    if (!requestEntry) return;

    const requestedStudentIndex = Number(requestEntry.student_index);
    const rowIndex = getMatrixRowIndexByStudentIndex(requestedStudentIndex);
    if (rowIndex >= 0) {
        currentPreviewIndex = rowIndex;
        updateSheetPreview();
    }
}

async function refreshCurrentReportMatrix() {
    if (!Number.isFinite(currentReportId)) return;
    const response = await fetch(`${API_BASE}/reports/${currentReportId}/matrix`, {
        headers: {
            ...getAuthHeaders()
        }
    });
    if (!response.ok) {
        throw new Error("Matrix request failed");
    }
    const data = await response.json();
    currentMatrix = data;
    renderMatrix(data);
}

async function reviewBubbleChangeRequest(requestId, action) {
    if (!Number.isFinite(requestId)) return;
    const activeRequest = currentPendingRequests.find((entry) => Number(entry.id) === Number(requestId));
    if (activeRequest) {
        focusedRequestId = Number(activeRequest.id);
        focusPreviewForRequest(activeRequest);
    }

    const comment = window.prompt(action === "reject" ? "Add rejection note (optional):" : "Add approval note (optional):", "") || "";

    try {
        const response = await fetch(`${API_BASE}/admin/change-requests/${requestId}`, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
                ...getAuthHeaders()
            },
            body: JSON.stringify({ action, comment })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
            throw new Error(data.message || "Unable to update change request.");
        }

        if (typeof loadAdminNotificationBadge === "function") {
            loadAdminNotificationBadge();
        }

        if (Number.isFinite(currentReportId)) {
            const previousIndex = currentPendingRequests.findIndex((entry) => Number(entry.id) === Number(requestId));
            await refreshCurrentReportMatrix();
            await loadBubbleChangeRequests(currentReportId);

            if (currentPendingRequests.length) {
                const nextRequest = currentPendingRequests[previousIndex] || currentPendingRequests[Math.max(0, previousIndex - 1)] || currentPendingRequests[0];
                if (nextRequest) {
                    focusedRequestId = Number(nextRequest.id);
                    renderChangeRequestsList(currentPendingRequests);
                    focusPreviewForRequest(nextRequest);
                }
            } else {
                focusedRequestId = null;
                updateSheetPreview();
            }
        }
    } catch (error) {
        console.error("Review request error:", error);
        alert(error.message || "Unable to review request.");
    }
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatReportTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || "-";
    return date.toLocaleString();
}

function buildExcelTableHtml(headers, rows) {
    const headerCells = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
    const bodyRows = rows.map((row) => {
        const cells = row.map((value) => `<td>${escapeHtml(value)}</td>`).join("");
        return `<tr>${cells}</tr>`;
    }).join("");

    return `
        <table border="1">
            <thead><tr>${headerCells}</tr></thead>
            <tbody>${bodyRows}</tbody>
        </table>
    `;
}

function downloadExcelFile(filename, title, tableHtml) {
    const html = `
        <html xmlns:o="urn:schemas-microsoft-com:office:office"
              xmlns:x="urn:schemas-microsoft-com:office:excel"
              xmlns="http://www.w3.org/TR/REC-html40">
        <head>
            <meta charset="UTF-8">
            <!--[if gte mso 9]>
            <xml>
                <x:ExcelWorkbook>
                    <x:ExcelWorksheets>
                        <x:ExcelWorksheet>
                            <x:Name>${escapeHtml(title)}</x:Name>
                            <x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
                        </x:ExcelWorksheet>
                    </x:ExcelWorksheets>
                </x:ExcelWorkbook>
            </xml>
            <![endif]-->
        </head>
        <body>${tableHtml}</body>
        </html>
    `;

    const blob = new Blob([html], { type: "application/vnd.ms-excel" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function getTypeBadgeClass(type) {
    return String(type || "").toLowerCase().includes("essay") ? "type-essay" : "type-bubble";
}

function renderReportCards(reports) {
    const grid = document.getElementById("adminReportsGrid");
    const countLabel = document.getElementById("adminReportCount");

    if (countLabel) {
        countLabel.textContent = `Total ${reports.length} reports`;
    }

    if (!grid) return;

    if (!reports.length) {
        grid.innerHTML = `
            <div class="report-item">
                <div class="report-header">
                    <div>
                        <div class="report-title">No reports found</div>
                        <div class="report-tag failed"><i class="fas fa-circle-xmark"></i> Empty</div>
                    </div>
                    <div class="report-tag">Reports</div>
                </div>
                <div class="report-meta">
                    <span><i class="fas fa-info-circle"></i> Generate a bubble sheet evaluation to populate this list.</span>
                </div>
            </div>
        `;
        return;
    }

    grid.innerHTML = reports.map((report) => `
        <div class="report-item">
            <div class="report-header">
                <div>
                    <div class="report-title">${escapeHtml(report.name)}</div>
                    <div class="report-tag success"><i class="fas fa-circle-check"></i> Generated</div>
                </div>
                <div class="report-tag">${escapeHtml(report.type)}</div>
            </div>
            <div class="report-meta">
                <span><i class="fas fa-file"></i> ${escapeHtml(report.name)}.json</span>
                <span><i class="fas fa-users"></i> ${escapeHtml(report.row_count)} Students</span>
                <span><i class="fas fa-percent"></i> Average ${escapeHtml(report.avg_score)}%</span>
                <span><i class="fas fa-user"></i> ${escapeHtml(report.created_by)}</span>
                <span><i class="fas fa-clock"></i> ${escapeHtml(formatReportTime(report.created_at))}</span>
            </div>
            <div class="report-footer">
                <button class="primary" type="button" data-report-id="${report.id}" data-report-kind="${escapeHtml(report.kind || "bubble")}"><i class="fas fa-file-arrow-down"></i> ${report.kind === "essay" ? "View Feedback" : "View Data"}</button>
                <button class="danger-btn delete-report-btn" type="button" data-report-id="${report.id}" data-report-kind="${escapeHtml(report.kind || "bubble")}" title="Delete report"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    `).join("");

    grid.querySelectorAll("[data-report-id]").forEach((button) => {
        if (button.classList.contains("delete-report-btn")) {
            return;
        }
        button.addEventListener("click", () => {
            const reportId = Number(button.getAttribute("data-report-id"));
            const reportKind = String(button.getAttribute("data-report-kind") || "bubble");
            if (!Number.isFinite(reportId)) return;
            if (reportKind === "essay") {
                loadEssayEvaluationDetails(reportId);
            } else {
                loadReportDetails(reportId);
            }
        });
    });

    grid.querySelectorAll(".delete-report-btn").forEach((button) => {
        button.addEventListener("click", async () => {
            const reportId = Number(button.getAttribute("data-report-id"));
            const reportKind = String(button.getAttribute("data-report-kind") || "bubble");
            if (!Number.isFinite(reportId)) return;

            const ok = window.confirm("Are you sure you want to delete this report?");
            if (!ok) return;

            try {
                const response = await fetch(`${API_BASE}/reports/${reportId}?kind=${encodeURIComponent(reportKind)}`, {
                    method: "DELETE",
                    headers: {
                        ...getAuthHeaders()
                    }
                });

                const data = await response.json().catch(() => ({}));
                if (!response.ok || !data.success) {
                    throw new Error(data.message || "Unable to delete report.");
                }

                // If deleted report is currently open, close details panel before refresh.
                if (Number(currentReportId) === reportId) {
                    currentReportId = null;
                    currentMatrix = null;
                    currentPreviewIndex = 0;
                    if (currentPreviewObjectUrl) {
                        URL.revokeObjectURL(currentPreviewObjectUrl);
                        currentPreviewObjectUrl = null;
                    }
                    setPreviewVisibility(true);
                    setEssayDetailVisibility(false);
                    closePreviewModal();
                    showDetailsPanel(false);
                }

                await loadAdminReports();
            } catch (error) {
                alert(error.message || "Unable to delete report.");
            }
        });
    });
}

function showDetailsPanel(show) {
    const panel = document.getElementById("reportDetailsPanel");
    const contentArea = document.querySelector(".admin-content-area");
    if (panel) {
        panel.style.display = show ? "flex" : "none";
    }
    if (contentArea) {
        contentArea.classList.toggle("in-details-mode", !!show);
        if (show) {
            contentArea.scrollTop = 0;
        }
    }
}

function scrollDetailsToPreview() {
    const panel = document.getElementById("sheetPreviewPanel");
    if (panel && typeof panel.scrollIntoView === "function") {
        panel.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" });
    }
}

function setEssayDetailVisibility(show) {
    const panel = document.getElementById("essayDetailPanel");
    const matrixWrap = document.querySelector("#reportDetailsPanel .matrix-wrap");
    const exportBtn = document.getElementById("exportDetailsExcelBtn");
    const previewToggleBtn = document.getElementById("previewToggleBtn");
    const fullPreviewBtn = document.getElementById("fullPreviewBtn");
    if (panel) panel.style.display = show ? "block" : "none";
    if (matrixWrap) matrixWrap.style.display = show ? "none" : "block";
    if (exportBtn) exportBtn.style.display = show ? "none" : "inline-flex";
    if (previewToggleBtn) previewToggleBtn.style.display = show ? "none" : "inline-flex";
    if (fullPreviewBtn) fullPreviewBtn.style.display = show ? "none" : "inline-flex";
}

function updatePreviewToggleButton() {
    const btn = document.getElementById("previewToggleBtn");
    const fullBtn = document.getElementById("fullPreviewBtn");
    if (!btn) return;
    const text = btn.querySelector("span");
    const icon = btn.querySelector("i");
    if (text) text.textContent = isPreviewVisible ? "Hide Preview" : "Show Preview";
    if (icon) icon.className = isPreviewVisible ? "fas fa-image" : "fas fa-images";
    if (fullBtn) fullBtn.disabled = !isPreviewVisible || !currentPreviewObjectUrl;
}

function setPreviewVisibility(show) {
    isPreviewVisible = !!show;
    const panel = document.getElementById("sheetPreviewPanel");
    if (panel) {
        panel.classList.toggle("is-collapsed", !isPreviewVisible);
    }
    updatePreviewToggleButton();
}

function closePreviewModal() {
    const modal = document.getElementById("previewModal");
    if (modal) modal.classList.remove("show");
}

function openPreviewModal() {
    const modal = document.getElementById("previewModal");
    const modalImage = document.getElementById("previewModalImage");
    if (!modal || !modalImage || !currentPreviewObjectUrl) return;
    modalImage.src = currentPreviewObjectUrl;
    modal.classList.add("show");
}

function initializePreviewModalDragging() {
    const modalOverlay = document.getElementById("previewModal");
    const modalCard = document.querySelector(".preview-modal-card");
    const modalHeader = document.querySelector(".preview-modal-card .modal-header");

    if (!modalOverlay || !modalCard || !modalHeader) return;

    let isDragging = false;
    let isResizing = false;
    let startX = 0;
    let startY = 0;
    let offsetX = 0;
    let offsetY = 0;
    let startWidth = 0;
    let startHeight = 0;

    modalHeader.addEventListener("mousedown", (e) => {
        if (e.target.closest(".modal-close")) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = modalCard.getBoundingClientRect();
        offsetX = rect.left;
        offsetY = rect.top;
        modalHeader.style.cursor = "grabbing";
    });

    const resizeHandle = modalCard.querySelector("::after") || modalCard;
    modalCard.addEventListener("mousedown", (e) => {
        const rect = modalCard.getBoundingClientRect();
        const isOnResize = e.clientX >= rect.right - 20 && e.clientY >= rect.bottom - 20;
        
        if (isOnResize && e.target === modalCard || (e.target.tagName !== "BUTTON" && e.target.tagName !== "IMG")) {
            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;
            startWidth = rect.width;
            startHeight = rect.height;
            document.body.style.cursor = "nwse-resize";
        }
    }, true);

    document.addEventListener("mousemove", (e) => {
        if (!modalOverlay.classList.contains("show")) return;

        if (isDragging) {
            e.preventDefault();
            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;
            const newX = offsetX + deltaX;
            const newY = offsetY + deltaY;

            const maxX = window.innerWidth - modalCard.offsetWidth;
            const maxY = window.innerHeight - modalCard.offsetHeight;
            const finalX = Math.max(0, Math.min(newX, maxX));
            const finalY = Math.max(0, Math.min(newY, maxY));

            modalCard.style.left = finalX + "px";
            modalCard.style.top = finalY + "px";
        }

        if (isResizing) {
            e.preventDefault();
            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;
            const newWidth = Math.max(300, startWidth + deltaX);
            const newHeight = Math.max(250, startHeight + deltaY);

            modalCard.style.width = newWidth + "px";
            modalCard.style.maxWidth = "none";
            modalCard.style.height = newHeight + "px";
            modalCard.style.maxHeight = "none";
        }
    });

    document.addEventListener("mouseup", () => {
        if (isDragging) {
            isDragging = false;
            modalHeader.style.cursor = "grab";
        }
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = "auto";
        }
    });

    modalHeader.style.cursor = "grab";
}

function setActiveMatrixRow(studentIndex) {
    const rows = document.querySelectorAll("#matrixBody tr[data-student-index]");
    rows.forEach((row) => {
        row.classList.toggle("matrix-row-active", Number(row.dataset.studentIndex) === Number(studentIndex));
    });
}

function scrollActiveMatrixRowIntoView(studentIndex) {
    const matrixWrap = document.querySelector(".matrix-wrap");
    const activeRow = document.querySelector(`#matrixBody tr[data-student-index='${studentIndex}']`);
    if (!matrixWrap || !activeRow) return;

    const stickyHeaderSpace = 74;
    const targetTop = activeRow.offsetTop - stickyHeaderSpace;
    matrixWrap.scrollTop = Math.max(0, targetTop);
}

async function updateSheetPreview() {
    const previewImage = document.getElementById("sheetPreviewImage");
    const previewEmpty = document.getElementById("sheetPreviewEmpty");
    const previewMeta = document.getElementById("sheetPreviewMeta");
    const previewStudent = document.getElementById("sheetPreviewStudent");
    const prevBtn = document.getElementById("prevSheetBtn");
    const nextBtn = document.getElementById("nextSheetBtn");
    const rows = Array.isArray(currentMatrix?.rows) ? currentMatrix.rows : [];

    if (!previewImage || !previewEmpty || !previewMeta || !previewStudent) return;

    if (!rows.length) {
        previewMeta.textContent = "Sheet 0 / 0";
        previewStudent.textContent = "No student selected";
        previewImage.style.display = "none";
        previewImage.removeAttribute("src");
        previewEmpty.style.display = "block";
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
        return;
    }

    currentPreviewIndex = Math.max(0, Math.min(currentPreviewIndex, rows.length - 1));
    const row = rows[currentPreviewIndex] || {};
    const studentIndex = Number.isFinite(Number(row.student_index)) ? Number(row.student_index) : currentPreviewIndex;

    previewMeta.textContent = `Sheet ${currentPreviewIndex + 1} / ${rows.length}`;
    previewStudent.textContent = `${row.seat_no || "-"} | ${row.name || "Unknown"}`;
    if (prevBtn) prevBtn.disabled = rows.length <= 1;
    if (nextBtn) nextBtn.disabled = rows.length <= 1;

    setActiveMatrixRow(studentIndex);
    scrollActiveMatrixRowIntoView(studentIndex);

    try {
        const response = await fetch(`${API_BASE}/reports/${currentReportId}/preview/${studentIndex}`, {
            headers: {
                ...getAuthHeaders(),
            },
        });

        if (!response.ok) {
            throw new Error("Preview unavailable");
        }

        const blob = await response.blob();
        if (currentPreviewObjectUrl) {
            URL.revokeObjectURL(currentPreviewObjectUrl);
        }
        currentPreviewObjectUrl = URL.createObjectURL(blob);
        previewImage.src = currentPreviewObjectUrl;
        previewImage.style.display = "block";
        previewEmpty.style.display = "none";
        updatePreviewToggleButton();
        const fullBtn = document.getElementById("fullPreviewBtn");
        if (fullBtn) {
            fullBtn.disabled = !isPreviewVisible || !currentPreviewObjectUrl;
        }
    } catch (_error) {
        previewImage.style.display = "none";
        previewImage.removeAttribute("src");
        previewEmpty.style.display = "block";
        const fullBtn = document.getElementById("fullPreviewBtn");
        if (fullBtn) {
            fullBtn.disabled = true;
        }
        updatePreviewToggleButton();
    }
}

function renderMatrix(matrix) {
    const head = document.getElementById("matrixHead");
    const body = document.getElementById("matrixBody");
    if (!head || !body) return;
    head.innerHTML = "";
    body.innerHTML = "";

    const questions = Array.isArray(matrix?.questions) ? matrix.questions : [];
    const rows = Array.isArray(matrix?.rows) ? matrix.rows : [];

    const correctByQuestion = {};
    rows.forEach((student) => {
        (student.answers || []).forEach((cell) => {
            const key = String(cell.question || "").trim();
            if (!key || correctByQuestion[key]) return;
            correctByQuestion[key] = cell.correct || "-";
        });
    });

    const headerRow = document.createElement("tr");
    const headers = [
        "CNIC",
        "Seat No",
        "Name",
        "Father Name",
        ...questions.map((question) => `Q${question}`),
        "Number Correct",
        "All Incorrect",
        "Number Blank",
        "Total Score",
        "Match",
    ];
    headers.forEach((label, index) => {
        const th = document.createElement("th");
        th.textContent = label;
        if (index < 4) {
            th.className = "matrix-head-cell matrix-student-col";
        } else if (index < 4 + questions.length) {
            th.className = "matrix-head-cell matrix-question-col";
        } else {
            th.className = "matrix-head-cell matrix-summary-col";
        }
        headerRow.appendChild(th);
    });
    head.appendChild(headerRow);

    if (questions.length) {
        const correctRow = document.createElement("tr");
        correctRow.className = "matrix-correct-row";
        correctRow.innerHTML = `
            <td class="matrix-cell matrix-student-col" style="font-weight:600;">CORRECT OPTIONS</td>
            <td class="matrix-cell matrix-student-col"></td>
            <td class="matrix-cell matrix-student-col"></td>
            <td class="matrix-cell matrix-student-col"></td>
            ${questions.map((question) => {
                const value = correctByQuestion[String(question)] || "-";
                return `<td class="matrix-cell matrix-question-col matrix-question-correct" style="font-weight:600;">${escapeHtml(value)}</td>`;
            }).join("")}
            <td class="matrix-cell matrix-summary-col" style="font-weight:600;"></td>
            <td class="matrix-cell matrix-summary-col" style="font-weight:600;"></td>
            <td class="matrix-cell matrix-summary-col" style="font-weight:600;"></td>
            <td class="matrix-cell matrix-summary-col" style="font-weight:600;"></td>
            <td class="matrix-cell matrix-summary-col" style="font-weight:600;"></td>
        `;
        body.appendChild(correctRow);
    }

    if (!rows.length) {
        const emptyRow = document.createElement("tr");
        emptyRow.innerHTML = `
            <td colspan="${headers.length}" style="text-align:center; color:#6b7280; padding: 24px 10px;">
                No matrix data found for this evaluation.
            </td>
        `;
        body.appendChild(emptyRow);
        return;
    }

    rows.forEach((rowData, rowIndex) => {
        const row = document.createElement("tr");
        const studentIndex = Number.isFinite(Number(rowData.student_index)) ? Number(rowData.student_index) : rowIndex;
        const questionCells = questions.map((question, index) => rowData.answers?.[index] || {});
        const correctCount = questionCells.reduce((count, cell) => count + (cell.is_correct ? 1 : 0), 0);
        const blankCount = questionCells.reduce((count, cell) => {
            const selected = String(cell.selected || "").trim();
            return count + ((!selected || selected === "-") ? 1 : 0);
        }, 0);
        const incorrectCount = Math.max(0, questions.length - correctCount - blankCount);
        const totalScore = correctCount;
        row.dataset.studentIndex = String(studentIndex);
        row.innerHTML = `
            <td class="matrix-cell matrix-student-col">${escapeHtml(rowData.cnic || "-")}</td>
            <td class="matrix-cell matrix-student-col">${escapeHtml(rowData.seat_no || "-")}</td>
            <td class="matrix-cell matrix-student-col">${escapeHtml(rowData.name || "-")}</td>
            <td class="matrix-cell matrix-student-col">${escapeHtml(rowData.father_name || "-")}</td>
            ${questions.map((question, index) => {
                const cell = rowData.answers?.[index] || {};
                const className = cell.is_correct ? "matrix-question-correct" : "matrix-question-wrong";
                const value = cell.selected || "-";
                const tooltip = `Selected: ${cell.selected || "-"}, Correct: ${cell.correct || "-"}`;
                return `<td class="matrix-cell matrix-question-col ${className}" title="${escapeHtml(tooltip)}">${renderAdminBubbleAnswerControl(studentIndex, question, value)}</td>`;
            }).join("")}
            <td class="matrix-cell matrix-summary-col">${escapeHtml(correctCount)}</td>
            <td class="matrix-cell matrix-summary-col">${escapeHtml(incorrectCount)}</td>
            <td class="matrix-cell matrix-summary-col">${escapeHtml(blankCount)}</td>
            <td class="matrix-cell matrix-summary-col">${escapeHtml(totalScore)}</td>
            <td class="matrix-cell matrix-summary-col">${escapeHtml(rowData.match_source || "ocr")}</td>
        `;
        row.addEventListener("click", () => {
            currentPreviewIndex = rowIndex;
            updateSheetPreview();
        });
        row.querySelectorAll(".admin-bubble-answer-input").forEach((input) => {
            input.addEventListener("click", (event) => event.stopPropagation());
        });
        body.appendChild(row);
    });
}

function renderEssayEvaluationDetails(item) {
    const summary = document.getElementById("essayDetailSummary");
    const result = document.getElementById("essayDetailResult");
    const head = document.getElementById("matrixHead");
    const body = document.getElementById("matrixBody");
    const sheetPanel = document.getElementById("sheetPreviewPanel");

    if (head) head.innerHTML = "";
    if (body) body.innerHTML = "";
    if (sheetPanel) sheetPanel.style.display = "none";
    setEssayDetailVisibility(true);

    if (summary) {
        summary.innerHTML = `
            <div class="essay-detail-card">
                <div>
                    <h3>${escapeHtml(item.rubric_name || item.name || "Essay Evaluation")}</h3>
                    <p>${escapeHtml(item.subject || "")}${item.grade_level ? ` • Grade ${escapeHtml(item.grade_level)}` : ""}</p>
                    <p>${escapeHtml(item.topic || "")}</p>
                </div>
                <div class="essay-detail-score">${Number(item.total_awarded || 0)} / ${Number(item.total_marks || 0)}</div>
            </div>
            <div class="essay-detail-meta">Saved by ${escapeHtml(item.created_by || "-")} on ${escapeHtml(new Date(item.created_at).toLocaleString())}</div>
        `;
    }

    const evaluation = item.evaluation || {};
    const rows = Array.isArray(evaluation.criterion_scores) ? evaluation.criterion_scores : [];
    const strengths = Array.isArray(evaluation.strengths) ? evaluation.strengths : [];
    const weaknesses = Array.isArray(evaluation.weaknesses) ? evaluation.weaknesses : [];

    if (result) {
        result.innerHTML = `
            <div class="essay-detail-block">
                <h4>Extracted Essay Text</h4>
                <div class="essay-detail-text">${escapeHtml(item.ocr_text || "No text available.").replace(/\n/g, "<br>")}</div>
            </div>
            <div class="essay-detail-block">
                <h4>Criterion Scores</h4>
                <div class="essay-detail-table-wrap">
                    <table class="essay-detail-table">
                        <thead>
                            <tr>
                                <th>Criterion</th>
                                <th>Awarded</th>
                                <th>Reason</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.map((row) => `
                                <tr>
                                    <td>${escapeHtml(row.name)}</td>
                                    <td>${Number(row.awarded_marks || 0)} / ${Number(row.max_marks || 0)}</td>
                                    <td>${escapeHtml(row.reason)}</td>
                                </tr>
                            `).join("")}
                        </tbody>
                    </table>
                </div>
            </div>
            <div class="essay-detail-columns">
                <div class="essay-detail-block">
                    <h4>Strengths</h4>
                    <ul>${strengths.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("") || "<li>-</li>"}</ul>
                </div>
                <div class="essay-detail-block">
                    <h4>Weaknesses</h4>
                    <ul>${weaknesses.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("") || "<li>-</li>"}</ul>
                </div>
            </div>
            <div class="essay-detail-block">
                <h4>Final Feedback</h4>
                <div class="essay-detail-text">${escapeHtml(evaluation.final_feedback || "No final feedback available.").replace(/\n/g, "<br>")}</div>
            </div>
        `;
    }
}

async function ensureMatrixForExport() {
    if (currentMatrix?.rows?.length && currentMatrix?.questions?.length) {
        return currentMatrix;
    }

    if (!Number.isFinite(currentReportId)) {
        return null;
    }

    try {
        const response = await fetch(`${API_BASE}/reports/${currentReportId}/matrix`, {
            headers: {
                ...getAuthHeaders()
            }
        });
        if (!response.ok) {
            return null;
        }
        const data = await response.json();
        currentMatrix = data;
        return data;
    } catch (error) {
        console.error("Matrix fetch for export failed:", error);
        return null;
    }
}

function buildDetailedMatrixExport(matrix) {
    const questions = Array.isArray(matrix?.questions) ? matrix.questions : [];
    const rows = Array.isArray(matrix?.rows) ? matrix.rows : [];
    if (!questions.length || !rows.length) {
        return null;
    }

    const headers = [
        "SEAT NO",
        "CNIC",
        ...questions.map((question) => `Q${question}`),
        "Number Correct",
        "All Incorrect",
        "Number Blank",
        "Total Score",
    ];

    const correctByQuestion = {};
    rows.forEach((student) => {
        (student.answers || []).forEach((cell) => {
            const key = String(cell.question || "").trim();
            if (!key || correctByQuestion[key]) return;
            correctByQuestion[key] = cell.correct || "-";
        });
    });

    const tableRows = [];
    tableRows.push([
        "CORRECT OPTIONS",
        "",
        ...questions.map((question) => correctByQuestion[String(question)] || "-"),
        "",
        "",
        "",
        "",
    ]);

    rows.forEach((student) => {
        const answerByQuestion = {};
        (student.answers || []).forEach((cell) => {
            const key = String(cell.question || "").trim();
            if (!key) return;
            answerByQuestion[key] = (cell.selected || "-").toString().trim() || "-";
        });

        const selectedAnswers = questions.map((question) => answerByQuestion[String(question)] || "-");

        let correctCount = 0;
        let blankCount = 0;
        questions.forEach((question, idx) => {
            const selected = selectedAnswers[idx];
            const correct = correctByQuestion[String(question)] || "-";
            const isBlank = !selected || selected === "-" || selected.toUpperCase() === "BLANK" || selected === "?";
            if (isBlank) {
                blankCount += 1;
            }
            if (!isBlank && selected === correct) {
                correctCount += 1;
            }
        });

        const totalQuestions = questions.length;
        const incorrectCount = Math.max(0, totalQuestions - correctCount);

        tableRows.push([
            student.seat_no || "-",
            student.cnic || "-",
            ...selectedAnswers,
            String(correctCount),
            String(incorrectCount),
            String(blankCount),
            String(correctCount),
        ]);
    });

    return { headers, rows: tableRows };
}

async function exportCurrentResults() {
    if (!Number.isFinite(currentReportId)) {
        alert("Pehle View Data open karein, phir export karein.");
        return;
    }

    const matrix = await ensureMatrixForExport();
    const detailed = buildDetailedMatrixExport(matrix);
    if (detailed) {
        downloadExcelFile("all_students_detailed.xls", "All Students Detailed", buildExcelTableHtml(detailed.headers, detailed.rows));
        return;
    }

    alert("Detailed matrix data available nahi. Pehle detail view open karein, phir export karein.");
}

async function loadReportDetails(reportId) {
    try {
        currentReportId = reportId;
        currentMatrix = null;
        currentPreviewIndex = 0;
        if (currentPreviewObjectUrl) {
            URL.revokeObjectURL(currentPreviewObjectUrl);
            currentPreviewObjectUrl = null;
        }

        const response = await fetch(`${API_BASE}/reports/${reportId}/matrix`, {
            headers: {
                ...getAuthHeaders()
            }
        });

        if (!response.ok) {
            throw new Error("Matrix request failed");
        }

        const data = await response.json();
        currentMatrix = data;

        const detailsTitle = document.getElementById("detailsTitle");
        const detailsMeta = document.getElementById("detailsMeta");
        const sheetPanel = document.getElementById("sheetPreviewPanel");
        if (detailsTitle) detailsTitle.textContent = data.report?.name || "Evaluation Details";
        if (detailsMeta) detailsMeta.textContent = "Excel-style all students matrix";
        if (sheetPanel) sheetPanel.style.removeProperty("display");

        renderMatrix(data);
        if ((data.report?.type || "").toLowerCase() === "bubble") {
            loadBubbleChangeRequests(reportId);
        } else {
            updateChangeRequestsPanelVisibility(false);
        }
        currentPreviewIndex = 0;
        setPreviewVisibility(true);
        setEssayDetailVisibility(false);
        showDetailsPanel(true);
        requestAnimationFrame(() => {
            const contentArea = document.querySelector(".content-area");
            if (contentArea) contentArea.scrollTop = 0;
            scrollDetailsToPreview();
        });
        updateSheetPreview();
    } catch (error) {
        console.error("Report details load error:", error);
        currentReportId = null;
        currentMatrix = null;
        renderMatrix({ questions: [], rows: [] });
        updateChangeRequestsPanelVisibility(false);
        setEssayDetailVisibility(false);
        showDetailsPanel(true);
        alert("View Data load nahi hua. Session/login check karein ya page refresh karein.");
        updateSheetPreview();
    }
}

async function loadEssayEvaluationDetails(evaluationId) {
    try {
        currentReportId = null;
        currentMatrix = null;
        currentPreviewIndex = 0;
        if (currentPreviewObjectUrl) {
            URL.revokeObjectURL(currentPreviewObjectUrl);
            currentPreviewObjectUrl = null;
        }

        const detailsTitle = document.getElementById("detailsTitle");
        const detailsMeta = document.getElementById("detailsMeta");
        if (detailsTitle) detailsTitle.textContent = "Essay Evaluation Feedback";
        if (detailsMeta) detailsMeta.textContent = "Saved essay result with click-to-open feedback";

        const response = await fetch(`${API_BASE}/essay/evaluations/${evaluationId}`, {
            headers: {
                ...getAuthHeaders()
            }
        });

        if (!response.ok) {
            throw new Error("Essay detail request failed");
        }

        const data = await response.json();
        if (!data.success) {
            throw new Error(data.message || "Essay detail unavailable");
        }

        setPreviewVisibility(false);
        renderEssayEvaluationDetails(data.evaluation || {});
        updateChangeRequestsPanelVisibility(false);
        showDetailsPanel(true);
        requestAnimationFrame(() => {
            const contentArea = document.querySelector(".content-area");
            if (contentArea) contentArea.scrollTop = 0;
        });
    } catch (error) {
        console.error("Essay details load error:", error);
        alert("Essay feedback nahi khul saka. Page refresh karke dobara try karein.");
    }
}

async function loadAdminReports() {
    try {
        const response = await fetch(`${API_BASE}/reports`, {
            headers: {
                ...getAuthHeaders()
            }
        });

        if (!response.ok) {
            throw new Error("Reports request failed");
        }

        const data = await response.json();
        reportsData = Array.isArray(data.reports) ? data.reports : [];
        applyAdminFilters();
        showDetailsPanel(false);
    } catch (error) {
        console.error("Admin reports load error:", error);
        reportsData = [];
        applyAdminFilters();
        showDetailsPanel(false);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    if (!protectPage()) return;

    renderAdminShell({
        activePage: "reports",
        pageContent: `
            <section class="admin-page-header">
                <div>
                    <h1 class="page-title">Reports & Results</h1>
                    <p class="page-subtitle">View and export evaluation outcomes for bubble sheets and essays.</p>
                </div>
            </section>

            <div class="admin-reports-layout">
                <div class="admin-reports-list" id="reportsListPanel">
                    <section class="report-card">
                        <div class="filter-bar">
                            <div class="filter-field">
                                <label>Search exam name...</label>
                                <input class="filter-input" id="adminSearchFilter" type="text" placeholder="Search exam name">
                            </div>
                            <div class="filter-field">
                                <label>All Types</label>
                                <select class="filter-input" id="adminTypeFilter">
                                    <option value="all">All Types</option>
                                    <option value="bubble">Bubble</option>
                                    <option value="essay">Essay</option>
                                </select>
                            </div>
                            <div class="filter-field">
                                <label>From date</label>
                                <input class="filter-input" id="adminFromDateFilter" type="date">
                            </div>
                            <div class="filter-field">
                                <label>To date</label>
                                <input class="filter-input" id="adminToDateFilter" type="date">
                            </div>
                        </div>

                        <div class="filter-actions">
                            <span id="adminReportCount">Total 0 reports</span>
                        </div>

                        <div class="report-grid" id="adminReportsGrid"></div>
                    </section>
                </div>

                <section class="reports-panel details-panel admin-details-panel" id="reportDetailsPanel" style="display:none;">
                    <div class="details-header">
                        <div>
                            <h2 class="page-title" id="detailsTitle">Evaluation Details</h2>
                            <p class="page-subtitle" id="detailsMeta">Excel-style all students matrix</p>
                        </div>
                        <button class="export-btn" id="exportDetailsExcelBtn" type="button">
                            <i class="fas fa-file-export"></i>
                            <span>Export Detailed Excel</span>
                        </button>
                        <button class="export-btn" id="previewToggleBtn" type="button">
                            <i class="fas fa-image"></i>
                            <span>Hide Preview</span>
                        </button>
                        <button class="export-btn" id="fullPreviewBtn" type="button">
                            <i class="fas fa-up-right-and-down-left-from-center"></i>
                            <span>Full Size</span>
                        </button>
                        <button class="export-btn" id="detailsBackBtn" type="button">
                            <i class="fas fa-arrow-left"></i>
                            <span>Back to Evaluations</span>
                        </button>
                    </div>

                    <div class="change-requests-panel" id="changeRequestsPanel" style="display:none;">
                        <div class="change-requests-header">
                            <h3>Pending Change Requests</h3>
                            <span id="changeRequestsCount">0 pending</span>
                        </div>
                        <div class="change-requests-list" id="changeRequestsList"></div>
                    </div>

                    <div class="sheet-preview-panel" id="sheetPreviewPanel">
                        <div class="sheet-preview-image-wrap">
                            <img id="sheetPreviewImage" alt="Sheet preview" style="display:none;" />
                            <div class="sheet-preview-empty" id="sheetPreviewEmpty">Sheet preview not available for this row.</div>
                        </div>
                        <div class="sheet-preview-controls">
                            <div class="sheet-preview-meta" id="sheetPreviewMeta">Sheet 0 / 0</div>
                            <div class="sheet-preview-meta" id="sheetPreviewStudent">No student selected</div>
                            <div class="sheet-preview-btns">
                                <button class="export-btn" id="prevSheetBtn" type="button">
                                    <i class="fas fa-chevron-left"></i>
                                    <span>Previous</span>
                                </button>
                                <button class="export-btn" id="nextSheetBtn" type="button">
                                    <span>Next</span>
                                    <i class="fas fa-chevron-right"></i>
                                </button>
                            </div>
                        </div>
                    </div>

                    <div class="essay-detail-panel" id="essayDetailPanel" style="display:none;">
                        <div class="essay-detail-summary" id="essayDetailSummary"></div>
                        <div class="essay-detail-result" id="essayDetailResult"></div>
                    </div>

                    <div class="table-wrap matrix-wrap">
                        <table class="results-table matrix-table">
                            <thead id="matrixHead"></thead>
                            <tbody id="matrixBody"></tbody>
                        </table>
                    </div>
                </section>
            </div>

            <div class="modal-overlay" id="previewModal">
                <div class="modal-card preview-modal-card">
                    <div class="modal-header">
                        <h3>Sheet Preview</h3>
                        <button class="modal-close" id="previewModalCloseBtn" type="button">
                            <i class="fas fa-xmark"></i>
                        </button>
                    </div>
                    <div class="preview-modal-body">
                        <img id="previewModalImage" alt="Full size sheet preview" />
                    </div>
                    <div class="modal-footer">
                        <button class="modal-secondary-btn" id="previewModalBackBtn" type="button">
                            Back
                        </button>
                        <button class="modal-primary-btn" id="previewModalCloseActionBtn" type="button">
                            Close
                        </button>
                    </div>
                </div>
            </div>
        `
    });

    bindAdminFilterEvents();

    loadAdminReports().then(() => {
        initialRequestIdFromQuery = getRequestIdFromQuery();
        const reportIdFromQuery = getReportIdFromQuery();
        if (reportIdFromQuery) {
            loadReportDetails(reportIdFromQuery);
        }
    });

    document.getElementById("exportDetailsExcelBtn")?.addEventListener("click", exportCurrentResults);
    document.getElementById("detailsBackBtn")?.addEventListener("click", () => {
        currentReportId = null;
        currentMatrix = null;
        currentPreviewIndex = 0;
        updateChangeRequestsPanelVisibility(false);
        if (currentPreviewObjectUrl) {
            URL.revokeObjectURL(currentPreviewObjectUrl);
            currentPreviewObjectUrl = null;
        }
        setPreviewVisibility(true);
        setEssayDetailVisibility(false);
        closePreviewModal();
        showDetailsPanel(false);
    });
    document.getElementById("previewToggleBtn")?.addEventListener("click", () => {
        setPreviewVisibility(!isPreviewVisible);
    });
    document.getElementById("fullPreviewBtn")?.addEventListener("click", () => {
        if (isPreviewVisible && currentPreviewObjectUrl) {
            openPreviewModal();
        }
    });
    document.getElementById("prevSheetBtn")?.addEventListener("click", () => {
        const rows = Array.isArray(currentMatrix?.rows) ? currentMatrix.rows : [];
        if (!rows.length) return;
        currentPreviewIndex = (currentPreviewIndex - 1 + rows.length) % rows.length;
        updateSheetPreview();
    });
    document.getElementById("nextSheetBtn")?.addEventListener("click", () => {
        const rows = Array.isArray(currentMatrix?.rows) ? currentMatrix.rows : [];
        if (!rows.length) return;
        currentPreviewIndex = (currentPreviewIndex + 1) % rows.length;
        updateSheetPreview();
    });

    document.getElementById("previewModalCloseBtn")?.addEventListener("click", closePreviewModal);
    document.getElementById("previewModalCloseActionBtn")?.addEventListener("click", closePreviewModal);
    document.getElementById("previewModalBackBtn")?.addEventListener("click", closePreviewModal);

    initializePreviewModalDragging();

    document.getElementById("matrixBody")?.addEventListener("input", (event) => {
        const input = event.target.closest(".admin-bubble-answer-input");
        if (!input) return;

        input.value = String(input.value || "").toUpperCase().replace(/\s+/g, "");
        input.setCustomValidity("");
        input.classList.remove("is-invalid");
    });

    document.getElementById("matrixBody")?.addEventListener("keydown", (event) => {
        const input = event.target.closest(".admin-bubble-answer-input");
        if (!input) return;

        const controlKeys = ["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Tab", "Home", "End"];
        if (controlKeys.includes(event.key)) return;

        if (event.key === "Enter") {
            event.preventDefault();
            input.blur();
            return;
        }

        if (!/^[A-Ea-e\/-]$/.test(event.key)) {
            event.preventDefault();
            input.classList.add("is-invalid");
            input.setCustomValidity("Only A-E, '-', or A/B allowed.");
            input.reportValidity();
        }
    });

    document.getElementById("matrixBody")?.addEventListener("change", async (event) => {
        const input = event.target.closest(".admin-bubble-answer-input");
        if (!input || !Number.isFinite(currentReportId)) return;

        const studentIndex = Number(input.dataset.studentIndex);
        const questionId = String(input.dataset.questionId || "").trim();
        const selectedOption = normalizeAdminBubbleAnswer(input.value);
        if (!questionId) return;

        if (!selectedOption) {
            input.classList.add("is-invalid");
            input.setCustomValidity("Only A-E, '-', or A/B allowed.");
            input.reportValidity();
            input.focus();
            return;
        }

        try {
            const response = await fetch(`${API_BASE}/reports/${currentReportId}/matrix`, {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    ...getAuthHeaders()
                },
                body: JSON.stringify({
                    student_index: studentIndex,
                    question_id: questionId,
                    selected_option: selectedOption,
                })
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.success) {
                throw new Error(data.message || "Unable to update bubble answer.");
            }

            await loadReportDetails(currentReportId);
            currentPreviewIndex = studentIndex;
            updateSheetPreview();
            if (typeof loadAdminNotificationBadge === "function") {
                loadAdminNotificationBadge();
            }
        } catch (error) {
            console.error("Admin bubble edit error:", error);
            alert(error.message || "Unable to update bubble answer.");
            await loadReportDetails(currentReportId);
        }
    });
});
