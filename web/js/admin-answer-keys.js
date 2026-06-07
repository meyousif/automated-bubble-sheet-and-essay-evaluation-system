document.addEventListener("DOMContentLoaded", () => {
    if (!protectPage()) return;

    renderAdminShell({
        activePage: "keys",
        pageContent: `
            <section class="admin-page-header">
                <div>
                    <h1 class="page-title">Answer Key Management</h1>
                    <p class="page-subtitle">Upload and manage answer keys for examinations.</p>
                </div>
            </section>

            <section class="keys-grid">
                <div class="keys-column">
                    <div class="keys-card">
                        <h3><i class="fas fa-upload"></i> Upload Answer Key File</h3>
                        <p>Browse to upload an Excel/CSV file.</p>

                        <div class="exam-field">
                            <label class="form-label" for="examNameInput">Exam Name</label>
                            <div class="input-icon-wrap">
                                <i class="fas fa-book input-icon"></i>
                                <input class="form-input input-with-icon" id="examNameInput" type="text" placeholder="Screening Test">
                            </div>
                            <div class="exam-hint">This name will identify the answer key in future uploads.</div>
                        </div>

                        <div class="upload-box">
                            <button class="upload-browse-btn" type="button" id="answerKeyBrowse" aria-label="Click to browse for answer key file">
                                <i class="fas fa-folder-open upload-browse-icon"></i>
                                <span class="upload-browse-label">Click to browse</span>
                            </button>
                            <div class="upload-subtitle">.xlsx .csv .xls</div>

                            <div class="upload-actions">
                                <button type="button" id="clearKeySelection">Clear Selection</button>
                                <button class="primary" type="button" id="uploadAnswerKey">Upload & Preview</button>
                            </div>

                            <div class="upload-helper" id="uploadHelper">Ready to upload your answer key. Please select a file.</div>
                        </div>
                    </div>

                    <div class="keys-card">
                        <h3><i class="fas fa-circle-info"></i> Format Guidelines</h3>
                        <div class="format-list">
                            <div class="format-item">
                                <h4>File Format</h4>
                                <div class="format-tags">
                                    <span class="format-tag">.xlsx</span>
                                    <span class="format-tag">.csv</span>
                                    <span class="format-tag">.xls</span>
                                </div>
                            </div>
                            <div class="format-item">
                                <h4>Required Columns</h4>
                                <div class="format-check"><i class="fas fa-circle-check"></i> question_id</div>
                                <div class="format-check"><i class="fas fa-circle-check"></i> correct_answer</div>
                            </div>
                            <div class="format-item">
                                <h4>Data Integrity</h4>
                                <p>Each row must represent a unique question and its correct answer.</p>
                            </div>
                            <div class="format-item">
                                <h4>Maximum File Size</h4>
                                <p>5MB per file</p>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="keys-column">
                    <div class="keys-card preview-card">
                        <h3><i class="fas fa-file-lines"></i> Answer Key Preview</h3>
                        <p>Upload an Excel/CSV file to preview extracted data.</p>

                        <div class="preview-placeholder" id="previewPlaceholder">
                            <div class="preview-icon">
                                <i class="fas fa-file-arrow-up"></i>
                            </div>
                            <p>Upload an Excel/CSV file to preview extracted data.</p>
                        </div>

                        <div class="preview-list" id="recentUploads"></div>
                        <div class="preview-table" id="previewTable"></div>
                        <div class="preview-actions" id="previewActions"></div>
                    </div>
                </div>
            </section>
        `
    });

    initializeAnswerKeyUpload();
    loadRecentUploads();
});

function initializeAnswerKeyUpload() {
    const browse = document.getElementById("answerKeyBrowse");
    const uploadBtn = document.getElementById("uploadAnswerKey");
    const clearBtn = document.getElementById("clearKeySelection");
    const helper = document.getElementById("uploadHelper");
    const examInput = document.getElementById("examNameInput");

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".csv,.xlsx,.xls";

    let selectedFile = null;

    const setHelper = (text, isError) => {
        if (!helper) return;
        helper.textContent = text;
        helper.style.color = isError ? "#dc2626" : "";
    };

    const resetSelection = () => {
        selectedFile = null;
        fileInput.value = "";
        setHelper("Ready to upload your answer key. Please select a file.");
    };

    if (browse) {
        browse.addEventListener("click", () => fileInput.click());
    }

    fileInput.addEventListener("change", () => {
        selectedFile = fileInput.files[0] || null;
        if (selectedFile) {
            setHelper(`Selected: ${selectedFile.name}`);
        } else {
            resetSelection();
        }
    });

    if (clearBtn) {
        clearBtn.addEventListener("click", resetSelection);
    }

    if (uploadBtn) {
        uploadBtn.addEventListener("click", async () => {
            const examName = examInput.value.trim();
            if (!examName) {
                setHelper("Please enter an exam name.", true);
                return;
            }
            if (!selectedFile) {
                setHelper("Please select a file.", true);
                return;
            }

            uploadBtn.disabled = true;
            uploadBtn.textContent = "Uploading...";

            const form = new FormData();
            form.append("examName", examName);
            form.append("file", selectedFile);

            try {
                const response = await fetch(`${API_BASE}/answer-keys/upload`, {
                    method: "POST",
                    headers: {
                        ...getAuthHeaders()
                    },
                    body: form
                });

                const data = await response.json();
                if (!response.ok || !data.success) {
                    setHelper(data.message || "Upload failed.", true);
                    return;
                }

                setHelper(`Uploaded ${data.count} rows for ${examName}.`);
                resetSelection();
                await loadRecentUploads();
            } catch (error) {
                console.error("Upload error:", error);
                setHelper("Upload failed.", true);
            } finally {
                uploadBtn.disabled = false;
                uploadBtn.textContent = "Upload & Preview";
            }
        });
    }
}

async function loadRecentUploads() {
    const list = document.getElementById("recentUploads");
    const placeholder = document.getElementById("previewPlaceholder");
    const table = document.getElementById("previewTable");

    if (!list) return;
    list.innerHTML = "";
    if (table) table.innerHTML = "";

    try {
        const response = await fetch(`${API_BASE}/answer-keys/recent`, {
            headers: {
                ...getAuthHeaders()
            }
        });

        if (!response.ok) {
            return;
        }

        const data = await response.json();
        const uploads = data.uploads || [];

        if (uploads.length === 0) {
            if (placeholder) placeholder.style.display = "block";
            return;
        }

        if (placeholder) placeholder.style.display = "none";

        list.innerHTML = uploads.map((upload) => {
            const timestamp = new Date(upload.created_at).toLocaleString();
            return `
                <div class="preview-item" role="button" tabindex="0" data-upload-id="${upload.id}">
                    <div class="preview-info">
                        <div class="preview-title">${upload.exam_name}</div>
                        <div class="preview-meta">${upload.file_name} • ${upload.row_count} rows</div>
                        <div class="preview-meta">Uploaded by ${upload.created_by} • ${timestamp}</div>
                    </div>
                    <span class="preview-actions-inline">
                        <button class="preview-delete" type="button" data-delete-id="${upload.id}" title="Delete answer key">
                            <i class="fas fa-trash"></i>
                        </button>
                    </span>
                </div>
            `;
        }).join("");

        const firstUpload = uploads[0];
        await loadPreview(firstUpload.id, "15");

        document.querySelectorAll(".preview-item").forEach((item) => {
            item.addEventListener("click", async (event) => {
                const deleteBtn = event.target.closest(".preview-delete");
                if (deleteBtn) return;
                const uploadId = item.dataset.uploadId;
                if (!uploadId) return;
                await loadPreview(uploadId, "15");
            });
        });

        document.querySelectorAll(".preview-delete").forEach((button) => {
            button.addEventListener("click", async (event) => {
                event.stopPropagation();
                const uploadId = button.dataset.deleteId;
                if (!uploadId) return;
                const confirmed = window.confirm("Delete this answer key?");
                if (!confirmed) return;

                const response = await fetch(`${API_BASE}/answer-keys/${uploadId}`, {
                    method: "DELETE",
                    headers: {
                        ...getAuthHeaders()
                    }
                });

                if (!response.ok) {
                    alert("Unable to delete answer key.");
                    return;
                }

                const preview = document.getElementById("previewTable");
                const actions = document.getElementById("previewActions");
                if (preview) preview.innerHTML = "";
                if (actions) actions.innerHTML = "";
                await loadRecentUploads();
            });
        });
    } catch (error) {
        console.error("Recent uploads error:", error);
    }
}

async function loadPreview(uploadId, limit) {
    const table = document.getElementById("previewTable");
    const actions = document.getElementById("previewActions");
    if (!table) return;
    table.innerHTML = "";
    if (actions) actions.innerHTML = "";

    try {
        const params = new URLSearchParams({ upload_id: uploadId });
        if (limit) {
            params.set("limit", limit);
        }

        const response = await fetch(`${API_BASE}/answer-keys/preview?${params.toString()}`, {
            headers: {
                ...getAuthHeaders()
            }
        });

        const data = await response.json();
        if (!response.ok || !data.success) {
            table.innerHTML = `<div class="preview-empty">Unable to load preview.</div>`;
            return;
        }

        const rows = data.rows || [];
        const total = data.total || rows.length;
        if (!rows.length) {
            table.innerHTML = `<div class="preview-empty">No rows available.</div>`;
            return;
        }

        table.innerHTML = `
            <div class="preview-table-header">Showing ${rows.length} of ${total} rows</div>
            <table>
                <thead>
                    <tr>
                        <th>Question</th>
                        <th>Correct Answer</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map((row) => `
                        <tr>
                            <td>${row.question_id}</td>
                            <td>${row.correct_answer}</td>
                        </tr>
                    `).join("")}
                </tbody>
            </table>
        `;

        if (actions) {
            if (rows.length < total) {
                actions.innerHTML = `<button type="button" class="preview-toggle" id="showAllRows">Show all</button>`;
                document.getElementById("showAllRows").addEventListener("click", () => loadPreview(uploadId, "all"));
            } else if (total > 15) {
                actions.innerHTML = `<button type="button" class="preview-toggle" id="showLessRows">Show less</button>`;
                document.getElementById("showLessRows").addEventListener("click", () => loadPreview(uploadId, "15"));
            }
        }
    } catch (error) {
        console.error("Preview error:", error);
        table.innerHTML = `<div class="preview-empty">Unable to load preview.</div>`;
    }
}
