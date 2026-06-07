let reportsData = [];
let currentReportId = null;
let currentMatrix = null;
let currentPreviewIndex = 0;
let isPreviewVisible = true;
let currentPreviewObjectUrl = null;
let currentDetailKind = "bubble";
let currentUserRole = "";
let bubbleAnswerState = new Map();

const BUBBLE_CHOICES = ["A", "B", "C", "D", "E", "-"];

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
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

function getStatusBadgeClass(status) {
    if (status === "Completed") return "status-completed";
    if (status === "Pending") return "status-pending";
    return "status-failed";
}

function isBubbleEditMode() {
    return currentDetailKind === "bubble" && currentUserRole !== "admin";
}

function getBubbleEditKey(studentIndex, questionId) {
    return `${studentIndex}:${questionId}`;
}

function getBubbleDisplaySelection(studentIndex, questionId, originalSelected) {
    const state = bubbleAnswerState.get(getBubbleEditKey(studentIndex, questionId));
    if (state) {
        return state.selected;
    }
    const fallback = String(originalSelected || "").trim();
    return fallback || "-";
}

function buildBubbleChoiceOptions(selectedValue) {
    const current = String(selectedValue || "-").trim() || "-";
    return BUBBLE_CHOICES.map((choice) => {
        const optionLabel = choice === "-" ? "Blank" : choice;
        const isSelected = choice === current ? "selected" : "";
        return `<option value="${choice}" ${isSelected}>${optionLabel}</option>`;
    }).join("");
}

function getBubbleDraftChanges() {
    return Array.from(bubbleAnswerState.values()).filter((entry) => entry.status === "draft");
}

function updateBubbleRequestButton() {
    const button = document.getElementById("submitChangeRequestBtn");
    if (!button) return;

    const visible = isBubbleEditMode();
    button.style.display = visible ? "inline-flex" : "none";

    const drafts = getBubbleDraftChanges();
    button.disabled = !visible || !drafts.length;

    const text = button.querySelector("span");
    if (text) {
        text.textContent = drafts.length ? `Send Change Request (${drafts.length})` : "Send Change Request";
    }
}

function clearBubbleAnswerState() {
    bubbleAnswerState.clear();
    updateBubbleRequestButton();
}

function setBubbleAnswerState(studentIndex, questionId, originalSelected, selectedValue) {
    const key = getBubbleEditKey(studentIndex, questionId);
    const original = String(originalSelected || "").trim() || "-";
    const selected = String(selectedValue || "").trim() || "-";

    if (selected === original) {
        bubbleAnswerState.delete(key);
    } else {
        const existing = bubbleAnswerState.get(key) || {};
        bubbleAnswerState.set(key, {
            studentIndex,
            questionId,
            originalSelected: existing.originalSelected || original,
            selected,
            status: existing.status === "pending" ? "draft" : "draft"
        });
    }

    updateBubbleRequestButton();
}

function markBubbleStatePending(changes) {
    changes.forEach((change) => {
        const key = getBubbleEditKey(change.student_index, change.question_id);
        const existing = bubbleAnswerState.get(key);
        if (existing) {
            bubbleAnswerState.set(key, {
                ...existing,
                status: "pending",
                selected: String(change.new_selected || existing.selected || "-").trim() || "-"
            });
        }
    });
    updateBubbleRequestButton();
}

async function submitBubbleChangeRequests() {
    const drafts = getBubbleDraftChanges();
    if (!drafts.length || !Number.isFinite(currentReportId)) {
        return;
    }

    const comment = window.prompt("Add a short comment for admin approval (optional):", "") || "";
    try {
        const response = await fetch(`${API_BASE}/reports/${currentReportId}/change-requests`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...getAuthHeaders()
            },
            body: JSON.stringify({
                comment,
                changes: drafts.map((entry) => ({
                    student_index: entry.studentIndex,
                    question_id: entry.questionId,
                    old_selected: entry.originalSelected,
                    new_selected: entry.selected,
                })),
            }),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
            throw new Error(data.message || "Unable to submit change request.");
        }

        markBubbleStatePending(drafts.map((entry) => ({
            student_index: entry.studentIndex,
            question_id: entry.questionId,
            new_selected: entry.selected,
        })));
        alert("Change request sent for admin approval.");
    } catch (error) {
        console.error("Change request submit error:", error);
        alert(error.message || "Unable to submit change request.");
    }
}

function renderReportsTable(data) {
    const grid = document.getElementById("resultsTableBody");
    if (!grid) return;
    grid.innerHTML = "";

    if (!data.length) {
        grid.innerHTML = `
            <div class="report-item user-report-item">
                <div class="report-header">
                    <div>
                        <div class="report-title">No evaluations found</div>
                        <div class="report-tag failed"><i class="fas fa-circle-xmark"></i> Empty</div>
                    </div>
                    <div class="report-tag">Reports</div>
                </div>
                <div class="report-meta">
                    <span><i class="fas fa-info-circle"></i> Run an evaluation to populate this list.</span>
                </div>
            </div>
        `;
        return;
    }

    grid.innerHTML = data.map((item) => {
        const createdAt = new Date(item.created_at);
        const dateText = Number.isNaN(createdAt.getTime()) ? item.created_at : createdAt.toLocaleString();
        return `
            <div class="report-item user-report-item">
                <div class="report-header">
                    <div>
                        <div class="report-title">${escapeHtml(item.name)}</div>
                        <div class="report-tag success"><i class="fas fa-circle-check"></i> Generated</div>
                    </div>
                    <div class="report-tag ${getTypeBadgeClass(item.type)}">${escapeHtml(item.type)}</div>
                </div>
                <div class="report-meta">
                    <span><i class="fas fa-file"></i> ${escapeHtml(item.name)}.json</span>
                    <span><i class="fas fa-users"></i> ${escapeHtml(item.row_count)} Students</span>
                    <span><i class="fas fa-percent"></i> Average ${escapeHtml(item.avg_score)}%</span>
                    <span><i class="fas fa-user"></i> ${escapeHtml(item.created_by)}</span>
                    <span><i class="fas fa-clock"></i> ${escapeHtml(dateText)}</span>
                </div>
                <div class="report-footer">
                    <button class="primary view-detail-btn" data-report-id="${item.id}" data-report-kind="${escapeHtml(item.kind || "bubble")}" type="button">
                        <i class="fas fa-file-arrow-down"></i>
                        ${item.kind === "essay" ? "View Feedback" : "View Details"}
                    </button>
                    <button class="danger-btn delete-report-btn" data-report-id="${item.id}" type="button" title="Delete Report">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `;
    }).join("");

    grid.querySelectorAll(".view-detail-btn").forEach((button) => {
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
        button.addEventListener("click", () => {
            const reportId = Number(button.getAttribute("data-report-id"));
            if (!Number.isFinite(reportId)) return;

            if (currentUserRole !== "admin") {
                alert("You do not have permission to delete reports.");
                return;
            }

            alert("Delete action will be enabled for admin in the next update.");
        });
    });
}

function renderBubbleAnswerControl(cell, studentIndex, questionId, selectedValue) {
    const inputValue = String(selectedValue || "-").trim() || "-";

    return `
        <input class="bubble-answer-input" type="text" inputmode="latin" maxlength="3" spellcheck="false" autocomplete="off" data-student-index="${studentIndex}" data-question-id="${escapeHtml(questionId)}" data-original-selected="${escapeHtml(cell.selected || "-")}" value="${escapeHtml(inputValue)}" />
    `;
}

function normalizeTypedBubbleAnswer(rawValue) {
    const value = String(rawValue || "").trim().toUpperCase();
    if (!value) return "-";
    if (value === "-") return value;
    if (/^[A-E]$/.test(value)) return value;
    if (/^[A-E]\/[A-E]$/.test(value)) return value;
    return null;
}

function isAllowedBubbleKey(key) {
    if (!key || key.length !== 1) return false;
    const upper = key.toUpperCase();
    return upper === "-" || upper === "/" || (upper >= "A" && upper <= "E");
}

function populateSelectOptions(selectElement, values, allLabel) {
    if (!selectElement) return;

    const options = [
        `<option value="all">${allLabel}</option>`,
        ...values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
    ];

    selectElement.innerHTML = options.join("");
}

function getFilteredReports() {
    const searchValue = String(document.getElementById("searchFilter")?.value || "").trim().toLowerCase();
    const typeValue = String(document.getElementById("typeFilter")?.value || "all");
    const fromDateValue = document.getElementById("fromDateFilter")?.value || "";
    const toDateValue = document.getElementById("toDateFilter")?.value || "";

    return reportsData.filter((item) => {
        const itemDate = new Date(item.created_at);
        const examMatch = !searchValue || String(item.name || "").toLowerCase().includes(searchValue);
        const typeMatch = typeValue === "all" || item.type === typeValue;

        const itemTime = Number.isNaN(itemDate.getTime()) ? null : itemDate.getTime();
        const fromTime = fromDateValue ? new Date(`${fromDateValue}T00:00:00`).getTime() : null;
        const toTime = toDateValue ? new Date(`${toDateValue}T23:59:59`).getTime() : null;

        const fromMatch = fromTime === null || (itemTime !== null && itemTime >= fromTime);
        const toMatch = toTime === null || (itemTime !== null && itemTime <= toTime);
        const dateMatch = fromMatch && toMatch;

        return examMatch && typeMatch && dateMatch;
    });
}

function applyFilters() {
    renderReportsTable(getFilteredReports());
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

async function exportCurrentResults() {
    if (!Number.isFinite(currentReportId)) {
        alert("Pehle View Details open karein, phir export karein.");
        return;
    }

    const matrix = await ensureMatrixForExport();
    const detailed = buildDetailedMatrixExport(matrix);
    if (detailed) {
        downloadExcelFile("all_students_detailed.xls", "All Students Detailed", buildExcelTableHtml(detailed.headers, detailed.rows));
        return;
    }

    alert("Detailed matrix data available nahi. Pehle 'Show All Students Together' click karein, phir export karein.");
}

function showDetailsPanel(show) {
    const panel = document.getElementById("reportDetailsPanel");
    const listPanel = document.getElementById("reportsListPanel");
    const contentArea = document.querySelector(".content-area");
    if (!panel) return;
    panel.style.display = show ? "flex" : "none";
    if (listPanel) {
        listPanel.style.display = show ? "none" : "block";
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
    const matrixWrap = document.querySelector(".matrix-wrap");
    const exportBtn = document.getElementById("exportDetailsExcelBtn");
    const previewToggleBtn = document.getElementById("previewToggleBtn");
    const fullPreviewBtn = document.getElementById("fullPreviewBtn");
    const listPanel = document.getElementById("reportsListPanel");
    if (panel) {
        panel.style.display = show ? "block" : "none";
    }
    if (listPanel && currentReportId !== null) {
        listPanel.style.display = show ? "none" : "block";
    }
    if (matrixWrap) {
        matrixWrap.style.display = show ? "none" : "block";
    }
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
    if (icon) {
        icon.className = isPreviewVisible ? "fas fa-image" : "fas fa-images";
    }
    if (fullBtn) {
        fullBtn.disabled = !isPreviewVisible || !currentPreviewObjectUrl;
    }
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
    if (modal) {
        modal.classList.remove("show");
    }
}

function openPreviewModal() {
    const modal = document.getElementById("previewModal");
    const modalImage = document.getElementById("previewModalImage");
    if (!modal || !modalImage || !currentPreviewObjectUrl) return;
    modalImage.src = currentPreviewObjectUrl;
    modal.classList.add("show");
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

function restoreActiveMatrixRow(studentIndex) {
    const numericIndex = Number(studentIndex);
    if (!Number.isFinite(numericIndex)) return;

    requestAnimationFrame(() => {
        setActiveMatrixRow(numericIndex);
        scrollActiveMatrixRowIntoView(numericIndex);
    });
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
        const displayedAnswers = questionCells.map((cell, index) => {
            const questionId = String(questions[index] || "");
            return getBubbleDisplaySelection(studentIndex, questionId, cell.selected);
        });
        const correctCount = questionCells.reduce((count, cell, index) => {
            const displayed = displayedAnswers[index];
            const correct = String(cell.correct || "").trim();
            return count + (!!displayed && displayed === correct ? 1 : 0);
        }, 0);
        const blankCount = displayedAnswers.reduce((count, selected) => {
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
                const questionId = String(question || "");
                const displayedValue = displayedAnswers[index];
                const correct = String(cell.correct || "").trim();
                const isCorrect = !!displayedValue && displayedValue === correct;
                const state = bubbleAnswerState.get(getBubbleEditKey(studentIndex, questionId));
                const stateClass = state?.status === "pending" ? "matrix-answer-pending" : state?.status === "draft" ? "matrix-answer-draft" : "";
                const className = isCorrect ? "matrix-question-correct" : "matrix-question-wrong";
                const tooltip = `Selected: ${displayedValue || "-"}, Correct: ${cell.correct || "-"}`;
                if (isBubbleEditMode()) {
                    return `<td class="matrix-cell matrix-question-col ${className} ${stateClass}" title="${escapeHtml(tooltip)}">${renderBubbleAnswerControl(cell, studentIndex, questionId, displayedValue)}</td>`;
                }
                return `<td class="matrix-cell matrix-question-col ${className}" title="${escapeHtml(tooltip)}">${escapeHtml(displayedValue)}</td>`;
            }).join("")}
            <td class="matrix-cell matrix-summary-col">${escapeHtml(correctCount)}</td>
            <td class="matrix-cell matrix-summary-col">${escapeHtml(incorrectCount)}</td>
            <td class="matrix-cell matrix-summary-col">${escapeHtml(blankCount)}</td>
            <td class="matrix-cell matrix-summary-col">${escapeHtml(totalScore)}</td>
            <td class="matrix-cell matrix-summary-col">${escapeHtml(rowData.match_source || "ocr")}</td>
        `;
        row.addEventListener("click", () => {
            if (isBubbleEditMode()) return;
            currentPreviewIndex = rowIndex;
            updateSheetPreview();
        });
        row.querySelectorAll(".bubble-answer-input").forEach((input) => {
            input.addEventListener("click", (event) => event.stopPropagation());
        });
        body.appendChild(row);
    });
}

async function loadReportDetails(reportId) {
    try {
        currentDetailKind = "bubble";
        setEssayDetailVisibility(false);
        clearBubbleAnswerState();
        const response = await fetch(`${API_BASE}/reports/${reportId}/matrix`, {
            headers: {
                ...getAuthHeaders()
            }
        });

        if (!response.ok) {
            throw new Error("Matrix request failed");
        }

        const data = await response.json();
        currentReportId = reportId;
        currentMatrix = data;

        const detailsTitle = document.getElementById("detailsTitle");
        const detailsMeta = document.getElementById("detailsMeta");
        if (detailsTitle) detailsTitle.textContent = data.report?.name || "Evaluation Details";
        if (detailsMeta) detailsMeta.textContent = "Excel-style all students matrix";

        renderMatrix(data);
        updateBubbleRequestButton();
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
        clearBubbleAnswerState();
        renderMatrix({ questions: [], rows: [] });
        setEssayDetailVisibility(false);
        showDetailsPanel(true);
        alert("View Details load nahi hua. Session/login check karein ya page refresh karein.");
        updateSheetPreview();
    }
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

async function loadEssayEvaluationDetails(evaluationId) {
    try {
        currentDetailKind = "essay";
        currentReportId = null;
        currentMatrix = null;
        currentPreviewIndex = 0;
        clearBubbleAnswerState();
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

async function loadReports() {
    const list = document.getElementById("resultsTableBody");
    if (list) {
        list.innerHTML = `
            <div class="report-item user-report-item">
                <div class="report-header">
                    <div>
                        <div class="report-title">Loading evaluations...</div>
                    </div>
                    <div class="report-tag">Please wait</div>
                </div>
            </div>
        `;
    }

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
        currentReportId = null;
        currentMatrix = null;
        currentDetailKind = "bubble";
        currentPreviewIndex = 0;
        clearBubbleAnswerState();

        const typeValues = [...new Set(reportsData.map((item) => item.type).filter(Boolean))].sort();

        populateSelectOptions(document.getElementById("typeFilter"), typeValues, "All Types");

        renderReportsTable(reportsData);
        showDetailsPanel(false);
    } catch (error) {
        console.error("Reports load error:", error);
        reportsData = [];
        currentReportId = null;
        currentMatrix = null;
        currentDetailKind = "bubble";
        clearBubbleAnswerState();
        renderReportsTable([]);
        showDetailsPanel(false);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    if (!protectPage()) return;

    const session = getSession();
    const roleBadge = document.getElementById("roleBadge");
    currentUserRole = String(session?.role || "").toLowerCase();

    if (session && roleBadge) {
        roleBadge.textContent = session.role || "Examiner";
    }

    loadReports();

    initializeTopbarMenu();
    initializeLogoutModal();

    document.getElementById("searchFilter")?.addEventListener("input", applyFilters);
    document.getElementById("typeFilter")?.addEventListener("change", applyFilters);
    document.getElementById("fromDateFilter")?.addEventListener("change", applyFilters);
    document.getElementById("toDateFilter")?.addEventListener("change", applyFilters);
    document.getElementById("detailsBackBtn")?.addEventListener("click", () => {
        currentReportId = null;
        currentMatrix = null;
        currentDetailKind = "bubble";
        currentPreviewIndex = 0;
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
        const fullBtn = document.getElementById("fullPreviewBtn");
        if (fullBtn) {
            fullBtn.disabled = !isPreviewVisible || !currentPreviewObjectUrl;
        }
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
    document.getElementById("previewModal")?.addEventListener("click", (event) => {
        if (event.target?.id === "previewModal") {
            closePreviewModal();
        }
    });

    document.getElementById("submitChangeRequestBtn")?.addEventListener("click", submitBubbleChangeRequests);

    document.getElementById("matrixBody")?.addEventListener("input", (event) => {
        const input = event.target.closest(".bubble-answer-input");
        if (!input) return;

        const raw = String(input.value || "").toUpperCase().replace(/\s+/g, "");
        input.value = raw;
        input.setCustomValidity("");
        input.classList.remove("is-invalid");
    });

    document.getElementById("matrixBody")?.addEventListener("keydown", (event) => {
        const input = event.target.closest(".bubble-answer-input");
        if (!input) return;

        const allowControl = ["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Tab", "Home", "End"];
        if (allowControl.includes(event.key)) {
            return;
        }

        if (event.key === "Enter") {
            event.preventDefault();
            input.blur();
            return;
        }

        if (event.key === "/" && String(input.value || "").includes("/")) {
            event.preventDefault();
            return;
        }

        if (!isAllowedBubbleKey(event.key)) {
            event.preventDefault();
            input.classList.add("is-invalid");
            input.setCustomValidity("Allowed: A-E, '-', or pair like A/B.");
            input.reportValidity();
        }
    });

    document.getElementById("matrixBody")?.addEventListener("paste", (event) => {
        const input = event.target.closest(".bubble-answer-input");
        if (!input) return;

        const pasted = String(event.clipboardData?.getData("text") || "").trim().toUpperCase();
        const normalized = normalizeTypedBubbleAnswer(pasted);

        if (!normalized) {
            event.preventDefault();
            input.classList.add("is-invalid");
            input.setCustomValidity("Only A-E, '-' or format A/B allowed.");
            input.reportValidity();
            return;
        }

        event.preventDefault();
        input.value = normalized;
        input.setCustomValidity("");
        input.classList.remove("is-invalid");
    });

    document.getElementById("matrixBody")?.addEventListener("change", (event) => {
        const input = event.target.closest(".bubble-answer-input");
        if (!input) return;

        const studentIndex = Number(input.dataset.studentIndex);
        const questionId = String(input.dataset.questionId || "");
        const originalSelected = String(input.dataset.originalSelected || "-");
        const normalized = normalizeTypedBubbleAnswer(input.value);

        if (!normalized) {
            input.classList.add("is-invalid");
            input.setCustomValidity("Only A-E, '-' or format A/B allowed.");
            input.reportValidity();
            input.focus();
            return;
        }

        input.setCustomValidity("");
        input.classList.remove("is-invalid");
        input.value = normalized;

        setBubbleAnswerState(studentIndex, questionId, originalSelected, normalized);
        if (currentMatrix) {
            renderMatrix(currentMatrix);
            restoreActiveMatrixRow(currentPreviewIndex);
        }
    });
});