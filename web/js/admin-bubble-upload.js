document.addEventListener("DOMContentLoaded", () => {
    if (!protectPage()) return;

    renderAdminShell({
        activePage: "bubble",
        pageContent: `
            <section class="admin-page-header">
                <div>
                    <h1 class="page-title">Bubble Sheet Upload</h1>
                    <p class="page-subtitle">Manage the upload of bubble sheet images, including validation and feedback on upload status.</p>
                </div>
            </section>

            <section class="upload-grid">
                <div>
                    <div class="upload-card">
                        <h3><i class="fas fa-folder-open"></i> Scan Bubble Sheet Folder</h3>
                        <p>Select a folder to check for folded sheets.</p>

                        <div class="folder-box">
                            <label class="form-label" for="folderPathInput">Folder Path</label>
                            <div class="folder-row">
                                <input class="form-input" id="folderPathInput" type="text" placeholder="C:\\path\\to\\bubble_sheets">
                                <button class="folder-btn" type="button" id="browseFolderBtn">Browse</button>
                            </div>

                            <div class="folder-options">
                                <label class="folder-toggle">
                                    <input type="checkbox" id="recursiveToggle">
                                    <span>Scan subfolders</span>
                                </label>
                            </div>

                            <div class="upload-actions">
                                <button type="button" id="clearFolderBtn">Clear</button>
                                <button class="primary" type="button" id="scanFolderBtn">Run Fold Check</button>
                            </div>

                            <div class="scan-progress" id="scanProgress">
                                <div class="scan-progress-bar">
                                    <div class="scan-progress-bar-fill" id="scanProgressFill"></div>
                                </div>
                                <div class="scan-progress-text" id="scanProgressText">0%</div>
                            </div>

                            <div class="upload-note" id="foldCheckStatus">Select a folder to start fold detection.</div>
                        </div>
                    </div>

                    <div class="upload-card">
                        <h3><i class="fas fa-clock-rotate-left"></i> Scan History</h3>
                        <p>Previously scanned folders.</p>
                        <div class="scan-history" id="scanHistory"></div>
                    </div>

                    <div class="upload-card">
                        <h3><i class="fas fa-circle-info"></i> Upload Guidelines</h3>
                        <div class="guidelines-list">
                            <div class="guideline">
                                <h4>Supported Formats</h4>
                                <div class="tag-list">
                                    <span class="tag">.jpeg</span>
                                    <span class="tag">.png</span>
                                    <span class="tag">.jpg</span>
                                </div>
                            </div>
                            <div class="guideline">
                                <h4>Maximum File Size</h4>
                                <p>10MB per file</p>
                            </div>
                            <div class="guideline">
                                <h4>Quality Requirements</h4>
                                <div class="check-item"><i class="fas fa-circle-check"></i> Minimum 150 DPI resolution</div>
                                <div class="check-item"><i class="fas fa-circle-check"></i> Proper orientation (not rotated)</div>
                                <div class="check-item"><i class="fas fa-circle-check"></i> Minimal noise (less than 5%)</div>
                            </div>
                            <div class="guideline">
                                <h4>Tips for Best Results</h4>
                                <p>Ensure scans are clear and well-lit. Avoid shadows, creases, or smudges on the bubble sheet.</p>
                            </div>
                        </div>
                    </div>
                </div>

                <div>
                    <div class="upload-card review-card">
                        <div class="review-header">
                            <div>
                                <h3><i class="fas fa-layer-group"></i> Review &amp; Actions</h3>
                                <p>Pending review and scan details in one place.</p>
                            </div>
                        </div>

                        <div class="fold-summary" id="foldSummary"></div>

                        <div class="review-body">
                            <div class="fold-preview">
                                <div class="fold-preview-title">Preview</div>
                                <div class="fold-preview-body" id="foldPreviewBody">Select a sheet to preview.</div>
                            </div>

                            <div class="scan-history-detail" id="scanHistoryDetail">Select a scan to view details.</div>
                        </div>
                    </div>
                </div>
            </section>

            <div class="merge-modal" id="folderMergeModal">
                <div class="merge-modal-card">
                    <div class="merge-modal-header">Merge into another folder?</div>
                    <div class="merge-modal-body" id="folderMergeBody"></div>
                    <div class="merge-modal-actions">
                        <button type="button" class="merge-cancel" id="folderMergeCancel">Cancel</button>
                        <button type="button" class="merge-confirm" id="folderMergeConfirm">Merge</button>
                    </div>
                </div>
            </div>
        `
    });

    initializeFoldCheck();
    loadFlaggedSheets();
    loadScanHistory();
});

let previewBlobUrl = null;
let previewFetchController = null;
let previewLoadingPath = "";
let previewRequestSerial = 0;
let lastPreviewPath = "";
let previewScheduleHandle = null;
let pendingRows = [];
let selectedPreviewSheetId = null;
let scanDetailState = {
    rows: [],
    run: null,
    counts: {},
    query: "",
    status: "pending",
    view: "pending"
};

function initializeFoldCheck() {
    const browseBtn = document.getElementById("browseFolderBtn");
    const folderInput = document.getElementById("folderPathInput");
    const clearBtn = document.getElementById("clearFolderBtn");
    const scanBtn = document.getElementById("scanFolderBtn");
    const recursiveToggle = document.getElementById("recursiveToggle");
    const status = document.getElementById("foldCheckStatus");
    const progress = document.getElementById("scanProgress");
    const progressFill = document.getElementById("scanProgressFill");
    const progressText = document.getElementById("scanProgressText");
    const summary = document.getElementById("foldSummary");

    const folderPicker = document.createElement("input");
    folderPicker.type = "file";
    folderPicker.webkitdirectory = true;
    folderPicker.multiple = true;

    const updateScanButtonState = () => {
        if (!scanBtn) return;
        const hasPath = Boolean(folderInput && folderInput.value.trim());
        scanBtn.disabled = !hasPath;
        scanBtn.classList.toggle("active", hasPath);
    };

    const setProgress = (active) => {
        if (!progress) return;
        progress.classList.toggle("active", Boolean(active));
    };

    const setProgressPercent = (percent, processed, total) => {
        if (progressFill) {
            progressFill.style.width = `${percent}%`;
        }
        if (progressText) {
            if (total) {
                progressText.textContent = `${percent}% (${processed}/${total})`;
            } else {
                progressText.textContent = `${percent}%`;
            }
        }
    };

    const setStatus = (text, isError) => {
        if (!status) return;
        status.textContent = text;
        status.style.color = isError ? "#dc2626" : "";
    };

    const clearResults = () => {
        if (summary) summary.innerHTML = "";
        loadFlaggedSheets();
    };

    if (browseBtn) {
        browseBtn.addEventListener("click", () => folderPicker.click());
    }

    folderPicker.addEventListener("change", () => {
        const file = folderPicker.files[0];
        if (!file) return;

        const path = file.path || "";
        if (path) {
            const folderPath = path.replace(/[\\/][^\\/]+$/, "");
            if (folderInput) folderInput.value = folderPath;
            setStatus(`Selected folder: ${folderPath}`);
            updateScanButtonState();
        } else if (folderInput && file.webkitRelativePath) {
            const root = file.webkitRelativePath.split("/")[0];
            folderInput.value = root;
            setStatus(`Selected folder: ${root}`);
            updateScanButtonState();
        }
    });

    if (folderInput) {
        folderInput.addEventListener("input", updateScanButtonState);
    }

    if (clearBtn) {
        clearBtn.addEventListener("click", () => {
            if (folderInput) folderInput.value = "";
            setStatus("Select a folder to start fold detection.");
            clearResults();
            updateScanButtonState();
        });
    }

    updateScanButtonState();

    if (scanBtn) {
        scanBtn.addEventListener("click", async () => {
            const folderPath = folderInput.value.trim();
            if (!folderPath) {
                setStatus("Please enter a folder path.", true);
                return;
            }

            scanBtn.disabled = true;
            scanBtn.textContent = "Scanning...";
            setStatus("Scanning folder for folded sheets...");
            setProgress(true);
            setProgressPercent(0, 0, 0);

            const finishScan = () => {
                setProgress(false);
                scanBtn.disabled = false;
                scanBtn.textContent = "Run Fold Check";
                updateScanButtonState();
            };

            try {
                const response = await fetch(`${API_BASE}/bubble/fold-check/start`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        ...getAuthHeaders()
                    },
                    body: JSON.stringify({
                        folderPath,
                        recursive: recursiveToggle?.checked || false,
                        threshold: 0.5
                    })
                });

                const data = await response.json();
                if (!response.ok || !data.success) {
                    setStatus(data.message || "Fold check failed.", true);
                    finishScan();
                    return;
                }

                const jobId = data.job_id;
                if (!jobId) {
                    setStatus("Fold check failed.", true);
                    finishScan();
                    return;
                }

                const pollStatus = async () => {
                    try {
                        const pollResponse = await fetch(`${API_BASE}/bubble/fold-check/status?job_id=${encodeURIComponent(jobId)}`, {
                            headers: {
                                ...getAuthHeaders()
                            }
                        });

                        const pollData = await pollResponse.json();
                        if (!pollResponse.ok || !pollData.success) {
                            setStatus(pollData.message || "Fold check failed.", true);
                            finishScan();
                            return;
                        }

                        if (pollData.status === "running") {
                            const processed = Number(pollData.processed || 0);
                            const total = Number(pollData.total || 0);
                            const percent = total ? Math.min(100, Math.round((processed / total) * 100)) : 0;
                            setProgressPercent(percent, processed, total);
                            setTimeout(pollStatus, 600);
                            return;
                        }

                        if (pollData.status === "done") {
                            const result = pollData.result;
                            if (!result) {
                                setStatus("Fold check failed.", true);
                                finishScan();
                                return;
                            }

                            setProgressPercent(100, result.processed || 0, result.total || 0);
                            renderFoldResults(result);
                            await maybeMergeFolder(result, setStatus);
                            await loadScanHistory();
                            setStatus("Fold check completed.");
                            finishScan();
                        }
                    } catch (error) {
                        console.error("Fold check status error:", error);
                        setStatus("Fold check failed.", true);
                        finishScan();
                    }
                };

                pollStatus();
            } catch (error) {
                console.error("Fold check error:", error);
                setStatus("Fold check failed.", true);
                finishScan();
            }
        });
    }
}

async function maybeMergeRescan(data, setStatus) {
    const candidates = data.merge_candidates || [];
    if (!candidates.length) return;

    const clearItems = candidates.filter((item) => item.status === "clear");
    if (!clearItems.length) return;

    const needsChoice = clearItems.some((item) => (item.old_matches || []).length > 1);
    let resolvedItems = [];

    if (needsChoice) {
        resolvedItems = await showMergeChoiceModal(clearItems);
        if (!resolvedItems.length) return;
    } else {
        resolvedItems = clearItems.map((item) => ({
            old_id: item.old_matches?.[0]?.id,
            new_path: item.new_path,
            confidence: item.confidence
        })).filter((item) => item.old_id);
        const allClear = Number(data.folded || 0) === 0 && Number(data.failed || 0) === 0;
        const message = allClear
            ? `You rescanned ${resolvedItems.length} file(s). Merge them into the original rejected folder?`
            : `Some rescanned files are still folded. Merge the ${resolvedItems.length} clear file(s) into the original rejected folder?`;
        if (!confirm(message)) return;
    }

    try {
        const response = await fetch(`${API_BASE}/bubble/merge-rescan`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...getAuthHeaders()
            },
            body: JSON.stringify({
                scan_id: data.scan_id,
                items: resolvedItems
            })
        });

        const result = await response.json();
        if (!response.ok || !result.success) {
            setStatus(result.message || "Merge failed.", true);
            return;
        }

        setStatus(`Merged ${result.merged} file(s).`);
        await loadFlaggedSheets();
    } catch (error) {
        console.error("Merge rescan error:", error);
        setStatus("Merge failed.", true);
    }
}

async function loadFlaggedSheets() {
    try {
        const response = await fetch(`${API_BASE}/bubble/flagged`, {
            headers: {
                ...getAuthHeaders()
            }
        });

        if (!response.ok) {
            return;
        }

        const data = await response.json();
        pendingRows = (data.rows || []).map((row) => ({
            ...row,
            verified_status: row.verified_status || "pending"
        }));

        if (!scanDetailState.run) {
            scanDetailState.view = "pending";
            renderReviewPanel();
        }
    } catch (error) {
        console.error("Load flagged error:", error);
    }
}

async function loadScanHistory() {
    const container = document.getElementById("scanHistory");
    const detail = document.getElementById("scanHistoryDetail");
    if (!container) return;

    container.innerHTML = "Loading...";
    // Keep the current review panel visible while history refreshes.
    // Previously this reset caused right-side actions to disappear after reject/approve.
    if (detail && !scanDetailState.run && scanDetailState.view !== "pending") {
        detail.innerHTML = "Select a scan to view details.";
    }

    try {
        const response = await fetch(`${API_BASE}/bubble/scan-history`, {
            headers: {
                ...getAuthHeaders()
            }
        });

        if (!response.ok) {
            container.innerHTML = "Unable to load history.";
            return;
        }

        const data = await response.json();
        const rows = data.rows || [];
        if (!rows.length) {
            container.innerHTML = "No scans yet.";
            return;
        }

        container.innerHTML = rows.map((row) => `
            <div class="scan-history-item" data-folder="${row.folder_path}" data-scan-id="${row.id}">
                <div class="scan-history-path">${row.folder_path}</div>
                <div class="scan-history-meta">${row.created_by} · ${new Date(row.created_at).toLocaleString()}</div>
                <div class="scan-history-stats">
                    <span>Total ${row.total || 0}</span>
                    <span>Pending ${row.pending || 0}</span>
                    <span>Approved ${row.approved || 0}</span>
                    <span>Rejected ${row.rejected || 0}</span>
                </div>
                <button class="scan-history-delete" type="button" title="Delete this scan history"><i class="fas fa-trash"></i></button>
            </div>
        `).join("");

        container.querySelectorAll(".scan-history-item").forEach((item) => {
            item.addEventListener("click", (e) => {
                if (e.target.closest(".scan-history-delete")) return;
                const scanId = item.dataset.scanId;
                if (scanId) loadScanHistoryDetail(scanId);
            });

            const deleteBtn = item.querySelector(".scan-history-delete");
            if (deleteBtn) {
                deleteBtn.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    const scanId = item.dataset.scanId;
                    if (!scanId) return;

                    if (!confirm("Are you sure you want to delete this scan history?")) return;

                    try {
                        const response = await fetch(`${API_BASE}/bubble/scan-history/${scanId}`, {
                            method: "DELETE",
                            headers: getAuthHeaders()
                        });

                        if (response.ok) {
                            loadScanHistory();
                        } else {
                            alert("Failed to delete scan history.");
                        }
                    } catch (error) {
                        console.error("Delete error:", error);
                        alert("Error deleting scan history.");
                    }
                });
            }
        });

        // Auto-open latest scan for a stable review workflow.
        const firstScan = rows[0];
        if (firstScan?.id && !scanDetailState.run) {
            loadScanHistoryDetail(firstScan.id);
        }
    } catch (error) {
        console.error("History load error:", error);
        container.innerHTML = "Unable to load history.";
        if (detail && !scanDetailState.run && scanDetailState.view !== "pending") {
            detail.innerHTML = "Unable to load scan details.";
        }
    }
}

async function loadScanHistoryDetail(scanId) {
    const detail = document.getElementById("scanHistoryDetail");
    if (!detail) return;

    detail.innerHTML = "Loading details...";

    try {
        const response = await fetch(`${API_BASE}/bubble/scan-history/${scanId}`, {
            headers: {
                ...getAuthHeaders()
            }
        });

        if (!response.ok) {
            detail.innerHTML = "Unable to load details.";
            return;
        }

        const data = await response.json();
        if (!data.success) {
            detail.innerHTML = data.message || "Unable to load details.";
            return;
        }

        scanDetailState = {
            rows: data.folded_rows || [],
            run: data.run,
            counts: data.counts || {},
            query: "",
            status: "pending",
            view: "scan"
        };

        renderReviewPanel();
    } catch (error) {
        console.error("History detail error:", error);
        detail.innerHTML = "Unable to load details.";
    }
}

function renderReviewPanel() {
    const detail = document.getElementById("scanHistoryDetail");
    if (!detail) return;

    const query = scanDetailState.query.trim().toLowerCase();
    const status = scanDetailState.status === "rejected" ? "rejected" : "pending";
    const mode = scanDetailState.view;
    const rows = mode === "scan" ? (scanDetailState.rows || []) : pendingRows;
    const counts = mode === "scan" ? (scanDetailState.counts || {}) : {
        total: rows.length,
        pending: rows.filter((row) => row.verified_status === "pending").length,
        approved: rows.filter((row) => row.verified_status === "approved").length,
        rejected: rows.filter((row) => row.verified_status === "rejected").length,
    };

    const summary = document.getElementById("foldSummary");
    if (summary) {
        summary.innerHTML = `
            <div class="fold-summary-card">
                <div><strong>Total:</strong> ${counts.total || 0}</div>
                <div><strong>Pending:</strong> ${counts.pending || 0}</div>
                <div><strong>Approved:</strong> ${counts.approved || 0}</div>
                <div><strong>Rejected:</strong> ${counts.rejected || 0}</div>
            </div>
        `;
    }

    const filtered = rows.filter((row) => {
        const matchesStatus = status === "all" || row.verified_status === status;
        if (!matchesStatus) return false;
        if (!query) return true;
        const hay = `${row.filename || ""} ${row.path || ""}`.toLowerCase();
        return hay.includes(query);
    });

    const pendingInView = filtered.filter((row) => row.verified_status === "pending");
    let currentIndex = filtered.findIndex((row) => Number(row.id) === Number(selectedPreviewSheetId));
    if (currentIndex < 0 && filtered.length) {
        currentIndex = 0;
        selectedPreviewSheetId = Number(filtered[0].id);
    }
    const currentRow = currentIndex >= 0 ? filtered[currentIndex] : null;
    const currentCounter = currentRow ? `${currentIndex + 1} out of ${filtered.length}` : `0 out of ${filtered.length}`;

    detail.innerHTML = `
        <div class="scan-detail-header">
            <div class="scan-detail-path">${mode === "scan" ? scanDetailState.run.folder_path : "Pending Review"}</div>
            <div class="scan-detail-meta">${mode === "scan" ? `${scanDetailState.run.created_by} · ${new Date(scanDetailState.run.created_at).toLocaleString()}` : "Latest pending folded sheets"}</div>
            <div class="scan-detail-stats">
                <span>Total ${counts.total || 0}</span>
                <span>Pending ${counts.pending || 0}</span>
                <span>Approved ${counts.approved || 0}</span>
                <span>Rejected ${counts.rejected || 0}</span>
            </div>
        </div>
        <div class="scan-detail-filters">
            <input class="scan-detail-search" id="scanDetailSearch" type="text" placeholder="Search filename or path" value="${scanDetailState.query}">
            <div class="scan-detail-tabs" id="scanDetailTabs">
                <button type="button" data-status="pending" class="${status === "pending" ? "active" : ""}">Pending</button>
                <button type="button" data-status="rejected" class="${status === "rejected" ? "active" : ""}">Rejected</button>
            </div>
            <div class="scan-detail-actions">
                <button type="button" class="scan-detail-reject" id="rejectAllBtn" ${pendingInView.length ? "" : "disabled"}>Reject All Pending</button>
            </div>
        </div>
        <div class="scan-detail-current-wrap">
            <div class="scan-detail-current-header">
                <div class="scan-detail-counter">${currentCounter}</div>
                <div class="scan-detail-nav">
                    <button type="button" class="scan-detail-nav-btn" id="currentPrevBtn" ${filtered.length > 1 ? "" : "disabled"}>Prev</button>
                    <button type="button" class="scan-detail-nav-btn" id="currentNextBtn" ${filtered.length > 1 ? "" : "disabled"}>Next</button>
                </div>
            </div>
            ${currentRow ? `
                <div class="scan-detail-row active" data-sheet-id="${currentRow.id}" data-sheet-path="${currentRow.path}" data-sheet-file="${currentRow.filename}" data-sheet-confidence="${currentRow.confidence}">
                    <div class="scan-detail-file">${currentRow.filename}</div>
                    <div class="scan-detail-path">${currentRow.path}</div>
                    <div class="scan-detail-folder">Folder: ${currentRow.path ? currentRow.path.replace(/[\\/][^\\/]+$/, "") : ""}</div>
                    ${currentRow.merged_from_path ? `<div class="scan-detail-merge">Merged from: ${currentRow.merged_from_path}</div>` : ""}
                    <div class="scan-detail-status ${currentRow.verified_status}">${currentRow.verified_status}</div>
                    <div class="scan-detail-actions">
                        <button type="button" class="scan-detail-preview">Preview</button>
                        ${currentRow.verified_status === "pending" ? `
                            <button type="button" class="scan-detail-approve">Mark OK</button>
                            <button type="button" class="scan-detail-reject">Reject</button>
                        ` : ""}
                    </div>
                </div>
            ` : `<div class="scan-detail-empty">No folded sheets match the filter.</div>`}
        </div>
    `;

    const searchInput = document.getElementById("scanDetailSearch");
    if (searchInput) {
        searchInput.addEventListener("input", (event) => {
            scanDetailState.query = event.target.value || "";
            renderReviewPanel();
        });
    }

    const tabs = document.getElementById("scanDetailTabs");
    if (tabs) {
        tabs.querySelectorAll("button").forEach((button) => {
            button.addEventListener("click", () => {
                scanDetailState.status = button.dataset.status === "rejected" ? "rejected" : "pending";
                renderReviewPanel();
            });
        });
    }

    const currentRowEl = detail.querySelector(".scan-detail-row");
    if (currentRowEl) {
        currentRowEl.addEventListener("click", () => {
            selectedPreviewSheetId = Number(currentRowEl.dataset.sheetId);
            updateFoldPreview({
                path: currentRowEl.dataset.sheetPath,
                filename: currentRowEl.dataset.sheetFile,
                confidence: currentRowEl.dataset.sheetConfidence
            });
        });
    }

    const previewBtn = detail.querySelector(".scan-detail-preview");
    if (previewBtn) {
        previewBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            const row = previewBtn.closest(".scan-detail-row");
            if (!row) return;
            selectedPreviewSheetId = Number(row.dataset.sheetId);
            updateFoldPreview({
                path: row.dataset.sheetPath,
                filename: row.dataset.sheetFile,
                confidence: row.dataset.sheetConfidence
            }, true);
        });
    }

    const prevBtn = document.getElementById("currentPrevBtn");
    if (prevBtn) {
        prevBtn.addEventListener("click", () => {
            if (!filtered.length) return;
            const nextIndex = (currentIndex - 1 + filtered.length) % filtered.length;
            selectedPreviewSheetId = Number(filtered[nextIndex].id);
            renderReviewPanel();
            updateFoldPreview({
                path: filtered[nextIndex].path,
                filename: filtered[nextIndex].filename,
                confidence: filtered[nextIndex].confidence
            });
        });
    }

    const nextBtn = document.getElementById("currentNextBtn");
    if (nextBtn) {
        nextBtn.addEventListener("click", () => {
            if (!filtered.length) return;
            const nextIndex = (currentIndex + 1) % filtered.length;
            selectedPreviewSheetId = Number(filtered[nextIndex].id);
            renderReviewPanel();
            updateFoldPreview({
                path: filtered[nextIndex].path,
                filename: filtered[nextIndex].filename,
                confidence: filtered[nextIndex].confidence
            });
        });
    }

    detail.querySelectorAll(".scan-detail-approve, .scan-detail-reject").forEach((button) => {
        button.addEventListener("click", async (event) => {
            event.stopPropagation();
            const row = button.closest(".scan-detail-row");
            if (!row) return;
            const sheetId = row.dataset.sheetId;
            if (!sheetId) return;
            const action = button.classList.contains("scan-detail-reject") ? "reject" : "approve";
            const contentArea = document.querySelector(".content-area");
            const keepPageTop = contentArea ? contentArea.scrollTop : 0;

            const ok = await updateSheetStatus(Number(sheetId), action);
            if (!ok) {
                alert("Unable to update this sheet.");
                return;
            }

            applyLocalSheetStatus(Number(sheetId), action === "approve" ? "approved" : "rejected");

            const sourceRows = (mode === "scan" ? scanDetailState.rows : pendingRows) || [];
            const next = pickNextPendingRow(sourceRows, Number(sheetId));
            const fallback = sourceRows.find((r) => Number(r.id) === Number(sheetId)) || null;
            const target = next || fallback;
            selectedPreviewSheetId = target ? Number(target.id) : null;

            renderReviewPanel();

            if (target) {
                updateFoldPreview({
                    path: target.path,
                    filename: target.filename,
                    confidence: target.confidence,
                });
            } else {
                updateFoldPreview(null);
            }

            if (contentArea) contentArea.scrollTop = keepPageTop;

            loadScanHistory();
        });
    });

    const rejectAllBtn = document.getElementById("rejectAllBtn");
    if (rejectAllBtn) {
        rejectAllBtn.addEventListener("click", async () => {
            const currentRows = (mode === "scan" ? scanDetailState.rows : pendingRows) || [];
            const targets = currentRows.filter((row) => row.verified_status === "pending");
            if (!targets.length) return;

            const yes = confirm(`Reject all pending sheets (${targets.length})?`);
            if (!yes) return;

            const contentArea = document.querySelector(".content-area");
            const keepPageTop = contentArea ? contentArea.scrollTop : 0;

            for (const row of targets) {
                const ok = await updateSheetStatus(Number(row.id), "reject");
                if (ok) {
                    applyLocalSheetStatus(Number(row.id), "rejected");
                }
            }

            const refreshedRows = (mode === "scan" ? scanDetailState.rows : pendingRows) || [];
            const next = refreshedRows.find((row) => row.verified_status === "pending") || null;
            const fallback = refreshedRows[0] || null;
            const target = next || fallback;
            selectedPreviewSheetId = target ? Number(target.id) : null;

            renderReviewPanel();
            if (target) {
                updateFoldPreview({
                    path: target.path,
                    filename: target.filename,
                    confidence: target.confidence,
                });
            } else {
                updateFoldPreview(null);
            }

            if (contentArea) contentArea.scrollTop = keepPageTop;

            loadScanHistory();
        });
    }

    if (currentRow) {
        scheduleFoldPreview({
            path: currentRow.path,
            filename: currentRow.filename,
            confidence: currentRow.confidence,
        });
    } else {
        scheduleFoldPreview(null, true);
    }
}

function scheduleFoldPreview(item, force = false) {
    if (previewScheduleHandle) {
        clearTimeout(previewScheduleHandle);
        previewScheduleHandle = null;
    }

    previewScheduleHandle = setTimeout(() => {
        previewScheduleHandle = null;
        updateFoldPreview(item, force);
    }, 40);
}

function scrollSelectedDetailRowIntoView() {
    const container = document.querySelector("#scanHistoryDetail .scan-detail-list");
    const selected = container?.querySelector(".scan-detail-row.active");
    if (!container || !selected) return;

    const containerRect = container.getBoundingClientRect();
    const rowRect = selected.getBoundingClientRect();
    const padTop = 8;
    const padBottom = 8;

    if (rowRect.top < containerRect.top + padTop) {
        const deltaUp = (containerRect.top + padTop) - rowRect.top;
        container.scrollTop = Math.max(0, container.scrollTop - deltaUp);
    } else if (rowRect.bottom > containerRect.bottom - padBottom) {
        const deltaDown = rowRect.bottom - (containerRect.bottom - padBottom);
        container.scrollTop = container.scrollTop + deltaDown;
    }
}

function pickNextPendingRow(rows, currentId) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return null;
    const start = Math.max(0, list.findIndex((row) => Number(row.id) === Number(currentId)));

    for (let i = start + 1; i < list.length; i += 1) {
        if (list[i].verified_status === "pending") return list[i];
    }
    for (let i = 0; i < start; i += 1) {
        if (list[i].verified_status === "pending") return list[i];
    }
    return null;
}

function applyLocalSheetStatus(sheetId, verifiedStatus) {
    pendingRows = pendingRows.map((row) =>
        Number(row.id) === Number(sheetId) ? { ...row, verified_status: verifiedStatus } : row
    );
    scanDetailState.rows = (scanDetailState.rows || []).map((row) =>
        Number(row.id) === Number(sheetId) ? { ...row, verified_status: verifiedStatus } : row
    );

    const rows = scanDetailState.rows || [];
    const total = rows.length;
    const pending = rows.filter((row) => row.verified_status === "pending").length;
    const approved = rows.filter((row) => row.verified_status === "approved").length;
    const rejected = rows.filter((row) => row.verified_status === "rejected").length;
    if (scanDetailState.run) {
        scanDetailState.counts = { total, pending, approved, rejected };
    }
}

async function updateSheetStatus(sheetId, action) {
    try {
        const response = await fetch(`${API_BASE}/bubble/flagged/${sheetId}`, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
                ...getAuthHeaders()
            },
            body: JSON.stringify({ action })
        });
        return response.ok;
    } catch (error) {
        console.error("Sheet status update error:", error);
        return false;
    }
}

function renderFoldResults(data) {
    const summary = document.getElementById("foldSummary");
    if (summary) {
        summary.innerHTML = `
            <div class="fold-summary-card">
                <div><strong>Total:</strong> ${data.total}</div>
                <div><strong>Folded:</strong> ${data.folded}</div>
                <div><strong>Clear:</strong> ${data.clear}</div>
                <div><strong>Failed:</strong> ${data.failed}</div>
            </div>
        `;
    }

    pendingRows = data.folded_rows || [];
    if (!scanDetailState.run) {
        scanDetailState.view = "pending";
        renderReviewPanel();
    }
}

function updateFoldPreview(item, force = false) {
    const preview = document.getElementById("foldPreviewBody");
    if (!preview) return;

    const nextPath = item ? String(item.path || "") : "";
    if (!force && nextPath && nextPath === previewLoadingPath) {
        return;
    }
    const hasRenderedImage = Boolean(preview.querySelector(".fold-preview-image img"));
    if (!force && nextPath && nextPath === lastPreviewPath && hasRenderedImage) {
        return;
    }

    if (previewFetchController && (force || !nextPath || nextPath !== previewLoadingPath)) {
        previewFetchController.abort();
        previewFetchController = null;
        previewLoadingPath = "";
    }

    if (previewBlobUrl) {
        URL.revokeObjectURL(previewBlobUrl);
        previewBlobUrl = null;
    }

    if (!item) {
        lastPreviewPath = "";
        previewLoadingPath = "";
        preview.innerHTML = "Select a sheet to preview.";
        return;
    }

    lastPreviewPath = nextPath;

    previewRequestSerial += 1;
    const requestSerial = previewRequestSerial;
    previewFetchController = new AbortController();
    previewLoadingPath = nextPath;

    preview.innerHTML = `
        <div class="fold-preview-image">
            <div class="fold-preview-placeholder">Loading preview...</div>
        </div>
        <div class="fold-preview-meta">
            <div><strong>${item.filename}</strong></div>
            <div>Confidence: ${(parseFloat(item.confidence) * 100).toFixed(1)}%</div>
            <div class="fold-preview-path">${item.path}</div>
        </div>
    `;

    const previewUrl = `${API_BASE}/bubble/preview?path=${encodeURIComponent(item.path)}`;
    fetch(previewUrl, {
        signal: previewFetchController.signal,
        headers: {
            ...getAuthHeaders()
        }
    })
        .then((response) => {
            if (!response.ok) throw new Error("Preview failed");
            return response.blob();
        })
        .then((blob) => {
            if (requestSerial !== previewRequestSerial) {
                return;
            }
            previewBlobUrl = URL.createObjectURL(blob);
            const img = new Image();
            img.alt = item.filename;
            img.decoding = "async";
            img.onload = () => {
                if (requestSerial !== previewRequestSerial) {
                    return;
                }
                const container = preview.querySelector(".fold-preview-image");
                if (!container) return;
                container.innerHTML = "";
                container.appendChild(img);
                if (requestSerial === previewRequestSerial) {
                    previewLoadingPath = "";
                }
            };
            img.onerror = () => {
                if (requestSerial !== previewRequestSerial) {
                    return;
                }
                const container = preview.querySelector(".fold-preview-image");
                if (!container) return;
                container.innerHTML = "<div class=\"fold-preview-placeholder\">Preview failed</div>";
                previewLoadingPath = "";
            };
            img.src = previewBlobUrl;
        })
        .catch((error) => {
            if (error && error.name === "AbortError") {
                if (requestSerial === previewRequestSerial) {
                    previewLoadingPath = "";
                }
                return;
            }
            if (requestSerial !== previewRequestSerial) {
                return;
            }
            const container = preview.querySelector(".fold-preview-image");
            if (!container) return;
            container.innerHTML = "<div class=\"fold-preview-placeholder\">Preview failed</div>";
            previewLoadingPath = "";
        });
}

function showMergeChoiceModal(items) {
    const modal = document.getElementById("mergeModal");
    const body = document.getElementById("mergeModalBody");
    const cancelBtn = document.getElementById("mergeCancelBtn");
    const confirmBtn = document.getElementById("mergeConfirmBtn");
    if (!modal || !body || !cancelBtn || !confirmBtn) return Promise.resolve([]);

    body.innerHTML = items.map((item, index) => {
        const options = (item.old_matches || []).map((match) => {
            return `<option value="${match.id}">${match.path}</option>`;
        }).join("");
        return `
            <div class="merge-item">
                <div class="merge-item-title">${item.filename}</div>
                <div class="merge-item-path">New: ${item.new_path}</div>
                <label class="merge-item-label">Merge into:</label>
                <select class="merge-item-select" data-index="${index}">
                    ${options}
                </select>
            </div>
        `;
    }).join("");

    modal.classList.add("active");

    return new Promise((resolve) => {
        const cleanup = () => {
            modal.classList.remove("active");
            cancelBtn.onclick = null;
            confirmBtn.onclick = null;
        };

        cancelBtn.onclick = () => {
            cleanup();
            resolve([]);
        };

        confirmBtn.onclick = () => {
            const selects = body.querySelectorAll(".merge-item-select");
            const resolved = [];
            selects.forEach((select) => {
                const idx = Number(select.dataset.index);
                const item = items[idx];
                const oldId = Number(select.value);
                if (!item || !oldId) return;
                resolved.push({
                    old_id: oldId,
                    new_path: item.new_path,
                    confidence: item.confidence
                });
            });
            cleanup();
            resolve(resolved);
        };
    });
}

async function maybeMergeFolder(result, setStatus) {
    const items = (result.results || []).filter((row) => row.status && row.status !== "failed");
    if (!items.length) return;

    const targetFolder = await showFolderMergeModal(result.folder_path || "", result.scan_id);
    if (!targetFolder) return;

    try {
        const response = await fetch(`${API_BASE}/bubble/merge-folder`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...getAuthHeaders()
            },
            body: JSON.stringify({
                target_scan_id: targetFolder,
                source_scan_id: result.scan_id,
                items
            })
        });

        const data = await response.json();
        if (!response.ok || !data.success) {
            setStatus(data.message || "Merge failed.", true);
            return;
        }

        setStatus(`Merged ${data.merged} file(s) into ${targetFolder}.`);
        await loadFlaggedSheets();
    } catch (error) {
        console.error("Folder merge error:", error);
        setStatus("Merge failed.", true);
    }
}

async function showFolderMergeModal(currentFolder, currentScanId) {
    const modal = document.getElementById("folderMergeModal");
    const body = document.getElementById("folderMergeBody");
    const cancelBtn = document.getElementById("folderMergeCancel");
    const confirmBtn = document.getElementById("folderMergeConfirm");
    if (!modal || !body || !cancelBtn || !confirmBtn) return null;

    let runs = [];
    try {
        const response = await fetch(`${API_BASE}/bubble/scan-history`, {
            headers: {
                ...getAuthHeaders()
            }
        });
        const data = await response.json();
        runs = data.rows || [];
    } catch (error) {
        console.error("Folder list error:", error);
    }

    const targets = runs.filter((run) => run && run.id && run.folder_path && run.id !== currentScanId);
    if (!targets.length) {
        return null;
    }

    const answer = confirm("Do you want to merge this scanned folder into another folder?");
    if (!answer) return null;

    body.innerHTML = `
        <div class="merge-item">
            <div class="merge-item-title">Current scan: ${currentFolder || "(unknown)"}</div>
            <label class="merge-item-label">Select target folder:</label>
            <select class="merge-item-select" id="folderMergeSelect">
                ${targets.map((run) => {
                    const created = run.created_at ? new Date(run.created_at).toLocaleString() : "";
                    const label = created ? `${run.folder_path} (${created})` : run.folder_path;
                    return `<option value="${run.id}">${label}</option>`;
                }).join("")}
            </select>
        </div>
    `;

    modal.classList.add("active");

    return new Promise((resolve) => {
        const cleanup = () => {
            modal.classList.remove("active");
            cancelBtn.onclick = null;
            confirmBtn.onclick = null;
        };

        cancelBtn.onclick = () => {
            cleanup();
            resolve(null);
        };

        confirmBtn.onclick = () => {
            const select = document.getElementById("folderMergeSelect");
            const value = select ? Number(select.value) : null;
            cleanup();
            resolve(value);
        };
    });
}