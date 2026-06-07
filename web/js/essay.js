let selectedEssayFile = null;
let essayRubrics = [];
let extractedEssayText = "";
let previewReady = false;
let previewLoading = false;
let evaluationLoading = false;
let previewAbortController = null;
let essayPreviewObjectUrl = "";
let essayPreviewLoadToken = 0;

function formatEssayFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isValidEssayImage(file) {
    const allowedTypes = ["image/jpeg", "image/png"];
    return allowedTypes.includes(file.type);
}

function updateEssayFileUI(file) {
    const fileBox = document.getElementById("selectedEssayFileBox");
    const fileName = document.getElementById("selectedEssayFileName");
    const fileMeta = document.getElementById("selectedEssayFileMeta");

    if (file) {
        fileName.textContent = file.name;
        fileMeta.textContent = `${file.type || "Image file"} • ${formatEssayFileSize(file.size)}`;
        fileBox.classList.add("show");
    } else {
        fileName.textContent = "No file selected";
        fileMeta.textContent = "Please choose a valid image file";
        fileBox.classList.remove("show");
    }

    extractedEssayText = "";
    previewReady = false;
    updateEssayStartButtonState();
}

function setSelectedEssayFile(file) {
    if (!file) return;

    if (!isValidEssayImage(file)) {
        alert("Please select a JPEG or PNG image.");
        return;
    }

    selectedEssayFile = file;
    updateEssayFileUI(file);
}

function resetEssayFile() {
    if (essayPreviewObjectUrl) {
        URL.revokeObjectURL(essayPreviewObjectUrl);
        essayPreviewObjectUrl = "";
    }
    selectedEssayFile = null;
    document.getElementById("essayInput").value = "";
    updateEssayFileUI(null);
    extractedEssayText = "";
    previewReady = false;
    previewLoading = false;
    evaluationLoading = false;
    renderEssayPreviewState();
}

function showEssayModal() {
    document.getElementById("essayCompleteModal").classList.add("show");
}

function closeEssayModal() {
    if (previewLoading && previewAbortController) {
        previewAbortController.abort();
    }
    document.getElementById("essayCompleteModal").classList.remove("show");
}

function setEssayModalTitle(title) {
    const titleNode = document.getElementById("essayModalTitle");
    if (titleNode) {
        titleNode.textContent = title;
    }
}

function setEssayModalLayout(mode) {
    const modal = document.getElementById("essayCompleteModal");
    const modalCard = modal ? modal.querySelector(".modal-card") : null;
    if (!modalCard) return;
    modalCard.classList.toggle("essay-preview-mode", mode === "preview");
}

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function updateEssayStartButtonState() {
    const startBtn = document.getElementById("startEssayEvaluationBtn");
    const rubricSelect = document.getElementById("essayRubricSelect");
    if (!startBtn || !rubricSelect) return;

    const enabled = Boolean(selectedEssayFile && rubricSelect.value);
    startBtn.disabled = !enabled;
    startBtn.classList.toggle("enabled", enabled);
    startBtn.querySelector("span").textContent = previewReady ? "Re-Preview Text" : "Preview Text";
}

function updatePreviewActionButtons() {
    const previewBtn = document.getElementById("startEssayEvaluationBtn");
    const approveBtn = document.getElementById("previewApproveBtn");
    const closeBtn = document.getElementById("closeEssayModalFooterBtn");
    if (!previewBtn || !approveBtn || !closeBtn) return;

    previewBtn.disabled = !selectedEssayFile || previewLoading || evaluationLoading;
    approveBtn.disabled = !previewReady || previewLoading || evaluationLoading;
    approveBtn.style.display = previewReady ? "inline-flex" : "none";

    if (previewLoading || evaluationLoading) {
        approveBtn.style.display = "none";
        closeBtn.textContent = "Cancel";
    } else {
        closeBtn.textContent = "Close";
    }
}

function renderEssayPreviewState() {
    const modalBody = document.getElementById("essayModalBody");
    const modalTitle = document.getElementById("essayModalTitle");
    setEssayModalLayout("default");
    if (modalBody) {
        modalBody.innerHTML = `
            <div class="essay-preview-empty">
                <h4>Preview Extracted Text</h4>
                <p>Upload an image and click <strong>Preview Text</strong> to extract the essay.</p>
            </div>
        `;
    }
    if (modalTitle) {
        modalTitle.textContent = "Preview Extracted Text";
    }
    updatePreviewActionButtons();
}

function renderEssayResult(data) {
    const modalBody = document.getElementById("essayModalBody");
    if (!modalBody) return;
    setEssayModalLayout("default");

    const evaluation = data?.evaluation || {};
    const rows = Array.isArray(evaluation.criterion_scores) ? evaluation.criterion_scores : [];
    const strengths = Array.isArray(evaluation.strengths) ? evaluation.strengths : [];
    const weaknesses = Array.isArray(evaluation.weaknesses) ? evaluation.weaknesses : [];

    modalBody.innerHTML = `
        <div class="essay-result-head">
            <h4>${escapeHtml(data.rubric_name || "Rubric")}</h4>
            <div class="essay-score-pill">Saved #${Number(data.evaluation_id || 0)} • Score: ${Number(evaluation.total_awarded || 0)} / ${Number(evaluation.total_marks || 0)}</div>
        </div>
        <div class="essay-save-banner">Saved successfully in database as evaluation #${Number(data.evaluation_id || 0)}.</div>
        <div class="essay-result-table-wrap">
            <table class="essay-result-table">
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
        <div class="essay-feedback-grid">
            <div>
                <h5>Strengths</h5>
                <ul>${strengths.map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>-</li>"}</ul>
            </div>
            <div>
                <h5>Weaknesses</h5>
                <ul>${weaknesses.map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>-</li>"}</ul>
            </div>
        </div>
        <div class="essay-final-feedback">
            <h5>Final Feedback</h5>
            <p>${escapeHtml(evaluation.final_feedback || "No final feedback generated.")}</p>
        </div>
    `;
}

function renderEssayPreview(data) {
    const modalBody = document.getElementById("essayModalBody");
    if (!modalBody) return;
    setEssayModalLayout("preview");

    const essayText = String(data?.essay_text || "").trim();
    const previewPath = String(data?.preview_path || "").trim();

    if (essayPreviewObjectUrl) {
        URL.revokeObjectURL(essayPreviewObjectUrl);
        essayPreviewObjectUrl = "";
    }

    const showPreview = Boolean(previewPath);
    modalBody.innerHTML = `
        <div class="essay-result-head">
            <h4>Extracted Text Preview</h4>
            <div class="essay-score-pill preview">Review then approve</div>
        </div>
        <div class="essay-preview-split">
            <div class="essay-preview-image-pane">
                <div class="essay-preview-image-wrap split">
                    <div class="essay-preview-image-status" id="essayPreviewImageStatus">
                        <span class="essay-inline-spinner" aria-hidden="true"></span>
                        ${showPreview ? "Loading image preview..." : "Image preview unavailable"}
                    </div>
                    <img class="essay-preview-image split" id="essayPreviewImage" alt="Essay preview" style="display:none;" />
                </div>
            </div>
            <div class="essay-preview-text-pane">
                <div class="essay-preview-box essay-preview-text-scroll">${escapeHtml(essayText || "No text extracted.").replace(/\n/g, "<br>")}</div>
                <div class="essay-preview-note">If the extracted text looks correct, click <strong>Approve &amp; Evaluate</strong> to generate and save the score.</div>
            </div>
        </div>
    `;

    if (showPreview) {
        loadEssayPreviewImage(previewPath);
    }
}

async function loadEssayPreviewImage(previewPath) {
    const imageNode = document.getElementById("essayPreviewImage");
    const statusNode = document.getElementById("essayPreviewImageStatus");
    if (!imageNode || !statusNode) return;

    const myToken = ++essayPreviewLoadToken;

    try {
        const response = await fetch(`${API_BASE}/essay/preview?path=${encodeURIComponent(previewPath)}`, {
            headers: {
                ...getAuthHeaders()
            }
        });

        if (!response.ok) {
            throw new Error("Preview image failed to load.");
        }

        const imageBlob = await response.blob();
        if (myToken !== essayPreviewLoadToken) return;

        if (essayPreviewObjectUrl) {
            URL.revokeObjectURL(essayPreviewObjectUrl);
            essayPreviewObjectUrl = "";
        }

        essayPreviewObjectUrl = URL.createObjectURL(imageBlob);
        imageNode.src = essayPreviewObjectUrl;
        imageNode.style.display = "block";
        statusNode.style.display = "none";
    } catch (error) {
        statusNode.innerHTML = `<span class="essay-preview-error">Image preview unavailable</span>`;
    }
}

function setEssayModalLoading(message, options = {}) {
    const showSpinner = Boolean(options.showSpinner);
    const modalBody = document.getElementById("essayModalBody");
    if (!modalBody) return;
    setEssayModalLayout("default");
    modalBody.innerHTML = `
        <div class="essay-modal-loading${showSpinner ? " is-busy" : ""}">
            ${showSpinner ? `<span class="essay-inline-spinner" aria-hidden="true"></span>` : ""}
            <span>${escapeHtml(message)}</span>
        </div>
    `;
}

async function loadEssayRubrics() {
    const rubricSelect = document.getElementById("essayRubricSelect");
    const rubricMeta = document.getElementById("essayRubricMeta");
    if (!rubricSelect || !rubricMeta) return;

    rubricSelect.innerHTML = `<option value="">Loading...</option>`;

    try {
        const response = await fetch(`${API_BASE}/rubrics`, {
            headers: {
                ...getAuthHeaders()
            }
        });
        const data = await response.json();
        essayRubrics = data.rubrics || [];

        if (!essayRubrics.length) {
            rubricSelect.innerHTML = `<option value="">No rubric available</option>`;
            rubricMeta.textContent = "Ask admin to generate at least one rubric.";
            updateEssayStartButtonState();
            return;
        }

        rubricSelect.innerHTML = essayRubrics.map((item) => (
            `<option value="${item.id}">${escapeHtml(item.name)}${Number(item.is_active) === 1 ? " (Active)" : ""}</option>`
        )).join("");

        const active = essayRubrics.find((item) => Number(item.is_active) === 1);
        if (active) {
            rubricSelect.value = String(active.id);
        }

        const selected = essayRubrics.find((item) => String(item.id) === String(rubricSelect.value));
        rubricMeta.textContent = selected
            ? `${selected.subject} • Grade ${selected.grade_level} • ${selected.total_marks} marks`
            : "Choose a rubric for evaluation.";

        rubricSelect.addEventListener("change", () => {
            const picked = essayRubrics.find((item) => String(item.id) === String(rubricSelect.value));
            rubricMeta.textContent = picked
                ? `${picked.subject} • Grade ${picked.grade_level} • ${picked.total_marks} marks`
                : "Choose a rubric for evaluation.";
            updateEssayStartButtonState();
        });

        updateEssayStartButtonState();
    } catch (error) {
        console.error("Unable to load rubrics:", error);
        rubricSelect.innerHTML = `<option value="">Failed to load</option>`;
        rubricMeta.textContent = "Unable to load rubric list.";
    }
}

function renderSavedEvaluations(items) {
    const list = document.getElementById("essayEvaluationsList");
    const meta = document.getElementById("essaySavedMeta");
    if (!list || !meta) return;

    if (!items.length) {
        list.innerHTML = `<div class="saved-evaluations-empty">No saved evaluations yet.</div>`;
        meta.textContent = "No saved evaluations yet.";
        return;
    }

    meta.textContent = `${items.length} saved evaluation${items.length === 1 ? "" : "s"} available.`;
    list.innerHTML = items.map((item) => `
        <div class="saved-evaluation-item">
            <div>
                <h4>${escapeHtml(item.file_name)}</h4>
                <p>${escapeHtml(item.rubric_name)} • ${escapeHtml(item.subject)} • Grade ${escapeHtml(item.grade_level)}</p>
                <p>${escapeHtml(item.topic)}</p>
            </div>
            <div class="saved-evaluation-score">${Number(item.total_awarded || 0)} / ${Number(item.total_marks || 0)}</div>
        </div>
    `).join("");
}

async function loadSavedEvaluations() {
    return;
}

async function previewEssayText() {
    if (!selectedEssayFile) return;

    const rubricSelect = document.getElementById("essayRubricSelect");
    const startBtn = document.getElementById("startEssayEvaluationBtn");
    const rubricId = rubricSelect ? rubricSelect.value : "";

    if (!rubricId) {
        alert("Please select a rubric.");
        return;
    }

    startBtn.disabled = true;
    startBtn.classList.remove("enabled");

    showEssayModal();
    updatePreviewActionButtons();

    try {
        previewLoading = true;
        previewAbortController = new AbortController();
        updatePreviewActionButtons();
        setEssayModalTitle("Preview Extracted Text");
        setEssayModalLoading("Extracting essay text for preview...", { showSpinner: true });
        const form = new FormData();
        form.append("file", selectedEssayFile);

        const response = await fetch(`${API_BASE}/essay/extract`, {
            method: "POST",
            headers: {
                ...getAuthHeaders()
            },
            signal: previewAbortController.signal,
            body: form
        });

        const data = await response.json();
        if (!response.ok || !data.success) {
            setEssayModalLoading(data.message || "Text extraction failed.");
            return;
        }

        extractedEssayText = data.essay_text || "";
        previewReady = true;
        renderEssayPreview(data);
        updatePreviewActionButtons();
        updateEssayStartButtonState();
    } catch (error) {
        if (error?.name === "AbortError") {
            setEssayModalLoading("Extraction cancelled.");
            previewReady = false;
            return;
        }
        console.error("Essay evaluation error:", error);
        setEssayModalLoading("Text extraction failed. Please try again.");
    } finally {
        previewLoading = false;
        previewAbortController = null;
        updatePreviewActionButtons();
        updateEssayStartButtonState();
    }
}

async function approveAndEvaluateEssay() {
    if (!previewReady) return;
    const rubricSelect = document.getElementById("essayRubricSelect");
    const startBtn = document.getElementById("startEssayEvaluationBtn");
    const rubricId = rubricSelect ? rubricSelect.value : "";

    if (!rubricId) {
        alert("Please select a rubric.");
        return;
    }

    evaluationLoading = true;
    updatePreviewActionButtons();
    setEssayModalTitle("Evaluation Completed");
    setEssayModalLoading("Evaluating essay against rubric...", { showSpinner: true });
    startBtn.disabled = true;

    try {
        const form = new FormData();
        form.append("rubric_id", rubricId);
        form.append("essay_text", extractedEssayText);
        form.append("file", selectedEssayFile);

        const response = await fetch(`${API_BASE}/essay/evaluate`, {
            method: "POST",
            headers: {
                ...getAuthHeaders()
            },
            body: form
        });

        const data = await response.json();
        if (!response.ok || !data.success) {
            setEssayModalLoading(data.message || "Evaluation failed.");
            return;
        }

        renderEssayResult(data);
    } catch (error) {
        console.error("Essay evaluation error:", error);
        setEssayModalLoading("Evaluation failed. Please try again.");
    } finally {
        evaluationLoading = false;
        updatePreviewActionButtons();
        updateEssayStartButtonState();
    }
}

function setupEssayUploadEvents() {
    const input = document.getElementById("essayInput");
    const dropzone = document.getElementById("essayDropzone");
    const browseTrigger = document.getElementById("essayBrowseTrigger");
    const removeBtn = document.getElementById("removeEssayFileBtn");
    const startBtn = document.getElementById("startEssayEvaluationBtn");
    const approveBtn = document.getElementById("previewApproveBtn");
    const closeTopBtn = document.getElementById("closeEssayModalBtn");
    const closeFooterBtn = document.getElementById("closeEssayModalFooterBtn");

    browseTrigger.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        input.value = "";
        input.click();
    });

    dropzone.addEventListener("click", (event) => {
        if (event.target.closest(".browse-link")) return;
        input.value = "";
        input.click();
    });

    input.addEventListener("change", (event) => {
        const file = event.target.files[0];
        if (file) setSelectedEssayFile(file);
    });

    dropzone.addEventListener("dragover", (event) => {
        event.preventDefault();
        dropzone.classList.add("dragover");
    });

    dropzone.addEventListener("dragleave", () => {
        dropzone.classList.remove("dragover");
    });

    dropzone.addEventListener("drop", (event) => {
        event.preventDefault();
        dropzone.classList.remove("dragover");

        const file = event.dataTransfer.files[0];
        if (file) setSelectedEssayFile(file);
    });

    removeBtn.addEventListener("click", () => {
        resetEssayFile();
        previewReady = false;
        extractedEssayText = "";
    });

    startBtn.addEventListener("click", previewEssayText);
    if (approveBtn) {
        approveBtn.addEventListener("click", approveAndEvaluateEssay);
    }

    closeTopBtn.addEventListener("click", closeEssayModal);
    closeFooterBtn.addEventListener("click", closeEssayModal);
}

document.addEventListener("DOMContentLoaded", () => {
    if (!protectPage()) return;

    const session = getSession();
    const roleBadge = document.getElementById("roleBadge");

    if (session && roleBadge) {
        roleBadge.textContent = session.role || "Examiner";
    }

    setupEssayUploadEvents();
    loadEssayRubrics();
    updateEssayStartButtonState();
    renderEssayPreviewState();

    initializeTopbarMenu();
    initializeLogoutModal();
});