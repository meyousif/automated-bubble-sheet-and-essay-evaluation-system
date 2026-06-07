const rubricState = {
    rubrics: [],
    selectedRubricId: null,
    selectedRubric: null,
    editMode: false
};

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function setRubricStatus(message, isError = false) {
    const node = document.getElementById("rubricStatus");
    if (!node) return;
    node.textContent = message;
    node.style.color = isError ? "#b91c1c" : "#475569";
}

async function loadRubrics() {
    try {
        const response = await fetch(`${API_BASE}/rubrics`, {
            headers: {
                ...getAuthHeaders()
            }
        });
        const data = await response.json();
        rubricState.rubrics = data.rubrics || [];
        if (!rubricState.selectedRubricId && rubricState.rubrics.length) {
            const active = rubricState.rubrics.find((item) => Number(item.is_active) === 1);
            rubricState.selectedRubricId = active ? active.id : rubricState.rubrics[0].id;
        }
        renderRubricList();
        await renderRubricPreview(rubricState.selectedRubricId);
    } catch (error) {
        console.error("Unable to load rubrics:", error);
        setRubricStatus("Unable to load rubrics.", true);
    }
}

function renderRubricList() {
    const list = document.getElementById("rubricList");
    if (!list) return;

    if (!rubricState.rubrics.length) {
        list.innerHTML = `<div class="rubric-list-empty">No rubrics generated yet.</div>`;
        return;
    }

    list.innerHTML = rubricState.rubrics.map((rubric) => {
        const activeClass = Number(rubric.id) === Number(rubricState.selectedRubricId) ? "selected" : "";
        const activeTag = Number(rubric.is_active) === 1 ? `<span class="rubric-active-chip">Active</span>` : "";
        return `
            <button type="button" class="rubric-list-item ${activeClass}" data-rubric-id="${rubric.id}">
                <div>
                    <div class="rubric-item-title">${escapeHtml(rubric.name)}</div>
                    <div class="rubric-item-meta">${escapeHtml(rubric.subject)} • Grade ${escapeHtml(rubric.grade_level)} • ${Number(rubric.total_marks || 0)} marks</div>
                </div>
                ${activeTag}
            </button>
        `;
    }).join("");

    list.querySelectorAll(".rubric-list-item").forEach((item) => {
        item.addEventListener("click", async () => {
            const rubricId = item.dataset.rubricId;
            if (!rubricId) return;
            rubricState.selectedRubricId = Number(rubricId);
            renderRubricList();
            await renderRubricPreview(rubricState.selectedRubricId);
        });
    });
}

async function renderRubricPreview(rubricId) {
    const box = document.getElementById("rubricPreview");
    const activateBtn = document.getElementById("activateRubricBtn");
    const editBtn = document.getElementById("editRubricBtn");
    const saveBtn = document.getElementById("saveRubricBtn");
    if (!box || !rubricId) {
        if (box) {
            box.innerHTML = `<p class="rubric-preview-empty">No rubric selected yet.</p>`;
        }
        if (activateBtn) activateBtn.disabled = true;
        if (editBtn) editBtn.disabled = true;
        if (saveBtn) saveBtn.disabled = true;
        return;
    }

    box.innerHTML = `<p class="rubric-preview-empty">Loading rubric...</p>`;
    if (activateBtn) activateBtn.disabled = true;
    if (editBtn) editBtn.disabled = true;
    if (saveBtn) saveBtn.disabled = true;

    try {
        const response = await fetch(`${API_BASE}/rubrics/${rubricId}`, {
            headers: {
                ...getAuthHeaders()
            }
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
            box.innerHTML = `<p class="rubric-preview-empty">Unable to load rubric preview.</p>`;
            return;
        }

        const item = data.rubric || {};
        rubricState.selectedRubric = item;
        const rubric = item.rubric || {};
        const criteria = Array.isArray(rubric.criteria) ? rubric.criteria : [];
        const studentTips = Array.isArray(rubric.instructions_for_students) ? rubric.instructions_for_students : [];

        if (rubricState.editMode) {
            box.innerHTML = `
                <div class="rubric-edit-grid">
                    <label>Name<input class="rubric-text-input" id="editRubricName" value="${escapeHtml(item.name)}"></label>
                    <label>Subject<input class="rubric-text-input" id="editRubricSubject" value="${escapeHtml(item.subject)}"></label>
                    <label>Grade Level<input class="rubric-text-input" id="editRubricGrade" value="${escapeHtml(item.grade_level)}"></label>
                    <label>Total Marks<input class="rubric-text-input" id="editRubricMarks" type="number" min="1" value="${Number(item.total_marks || 10)}"></label>
                </div>
                <div class="rubric-edit-topic">
                    <label>Topic</label>
                    <textarea class="rubric-input" id="editRubricTopic">${escapeHtml(item.topic)}</textarea>
                </div>
                <div class="rubric-criteria-toolbar">
                    <h5>Criteria</h5>
                    <button type="button" class="primary ghost" id="addCriteriaRowBtn">+ Add Criterion</button>
                </div>
                <table class="rubric-criteria-table rubric-criteria-edit-table">
                    <thead>
                        <tr>
                            <th>Criterion</th>
                            <th>Marks</th>
                            <th>Description</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody id="editCriteriaBody">
                        ${criteria.map((row, index) => `
                            <tr data-row-index="${index}">
                                <td><input class="rubric-inline-input" data-field="name" value="${escapeHtml(row.name)}"></td>
                                <td><input class="rubric-inline-input" data-field="marks" type="number" min="1" value="${Number(row.marks || 0)}"></td>
                                <td><textarea class="rubric-inline-textarea" data-field="description">${escapeHtml(row.description)}</textarea></td>
                                <td><button type="button" class="rubric-delete-row-btn">Delete</button></td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
                <div class="rubric-student-instructions">
                    <h5>Instructions for Students (one line per instruction)</h5>
                    <textarea class="rubric-input" id="editRubricInstructions" rows="6">${escapeHtml(studentTips.join("\n"))}</textarea>
                </div>
            `;
        } else {
            box.innerHTML = `
                <div class="rubric-preview-head">
                    <h4>${escapeHtml(item.name)}</h4>
                    <span>${escapeHtml(item.subject)} • Grade ${escapeHtml(item.grade_level)} • ${Number(item.total_marks || 0)} marks</span>
                    <p><strong>Topic:</strong> ${escapeHtml(item.topic)}</p>
                </div>
                <table class="rubric-criteria-table">
                    <thead>
                        <tr>
                            <th>Criterion</th>
                            <th>Marks</th>
                            <th>Description</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${criteria.map((row) => `
                            <tr>
                                <td>${escapeHtml(row.name)}</td>
                                <td>${Number(row.marks || 0)}</td>
                                <td>${escapeHtml(row.description)}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
                <div class="rubric-student-instructions">
                    <h5>Instructions for Students</h5>
                    ${studentTips.length ? `<ul>${studentTips.map((tip) => `<li>${escapeHtml(tip)}</li>`).join("")}</ul>` : "<p>No student instructions available.</p>"}
                </div>
            `;
        }

        const selected = rubricState.rubrics.find((entry) => Number(entry.id) === Number(rubricId));
        if (activateBtn) {
            activateBtn.disabled = Number(selected?.is_active) === 1;
        }
        if (editBtn) {
            editBtn.disabled = false;
            editBtn.textContent = rubricState.editMode ? "Cancel Edit" : "Edit Rubric";
        }
        if (saveBtn) {
            saveBtn.disabled = !rubricState.editMode;
        }

        if (rubricState.editMode) {
            bindCriteriaRowControls();
        }
    } catch (error) {
        console.error("Unable to load rubric preview:", error);
        box.innerHTML = `<p class="rubric-preview-empty">Unable to load rubric preview.</p>`;
    }
}

function buildCriteriaRowHtml(index, row = {}) {
    return `
        <tr data-row-index="${index}">
            <td><input class="rubric-inline-input" data-field="name" value="${escapeHtml(row.name || "")}"></td>
            <td><input class="rubric-inline-input" data-field="marks" type="number" min="1" value="${Number(row.marks || 1)}"></td>
            <td><textarea class="rubric-inline-textarea" data-field="description">${escapeHtml(row.description || "")}</textarea></td>
            <td><button type="button" class="rubric-delete-row-btn">Delete</button></td>
        </tr>
    `;
}

function bindCriteriaRowControls() {
    const addBtn = document.getElementById("addCriteriaRowBtn");
    const body = document.getElementById("editCriteriaBody");
    if (!addBtn || !body) return;

    addBtn.onclick = () => {
        const index = body.querySelectorAll("tr").length;
        body.insertAdjacentHTML("beforeend", buildCriteriaRowHtml(index, {
            name: "New Criterion",
            marks: 1,
            description: "Describe what this criterion evaluates.",
        }));
    };

    body.onclick = (event) => {
        const deleteBtn = event.target.closest(".rubric-delete-row-btn");
        if (!deleteBtn) return;

        const rows = body.querySelectorAll("tr");
        if (rows.length <= 1) {
            setRubricStatus("At least one criterion is required.", true);
            return;
        }

        const row = deleteBtn.closest("tr");
        if (row) row.remove();
    };
}

function toggleRubricEditMode() {
    rubricState.editMode = !rubricState.editMode;
    renderRubricPreview(rubricState.selectedRubricId);
}

async function saveEditedRubric() {
    if (!rubricState.selectedRubricId || !rubricState.editMode) return;

    const name = document.getElementById("editRubricName")?.value.trim() || "";
    const subject = document.getElementById("editRubricSubject")?.value.trim() || "";
    const gradeLevel = document.getElementById("editRubricGrade")?.value.trim() || "";
    const topic = document.getElementById("editRubricTopic")?.value.trim() || "";
    const totalMarks = Number(document.getElementById("editRubricMarks")?.value || 0);
    const instructions = (document.getElementById("editRubricInstructions")?.value || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

    const criteria = Array.from(document.querySelectorAll("#editCriteriaBody tr")).map((tr) => ({
        name: tr.querySelector('[data-field="name"]')?.value.trim() || "",
        marks: Number(tr.querySelector('[data-field="marks"]')?.value || 0),
        description: tr.querySelector('[data-field="description"]')?.value.trim() || "",
    }));

    if (!name || !subject || !gradeLevel || !topic || totalMarks <= 0) {
        setRubricStatus("Please fill all rubric fields before saving.", true);
        return;
    }
    if (!criteria.length || criteria.some((row) => !row.name || !row.description || Number(row.marks) <= 0)) {
        setRubricStatus("Each criterion needs name, positive marks, and description.", true);
        return;
    }

    const saveBtn = document.getElementById("saveRubricBtn");
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving...";
    }

    try {
        const response = await fetch(`${API_BASE}/rubrics/${rubricState.selectedRubricId}`, {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                ...getAuthHeaders()
            },
            body: JSON.stringify({
                name,
                subject,
                grade_level: gradeLevel,
                topic,
                total_marks: totalMarks,
                criteria,
                instructions_for_students: instructions,
            })
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
            setRubricStatus(data.message || "Unable to save rubric edits.", true);
            return;
        }

        rubricState.editMode = false;
        setRubricStatus("Rubric updated successfully.");
        await loadRubrics();
    } catch (error) {
        console.error("Save rubric error:", error);
        setRubricStatus("Unable to save rubric edits.", true);
    } finally {
        if (saveBtn) {
            saveBtn.textContent = "Save Changes";
        }
    }
}

async function generateRubric() {
    const name = document.getElementById("rubricName").value.trim();
    const subject = document.getElementById("rubricSubject").value.trim();
    const gradeLevel = document.getElementById("rubricGradeLevel").value.trim();
    const topic = document.getElementById("rubricTopic").value.trim();
    const totalMarks = document.getElementById("rubricTotalMarks").value.trim();
    const button = document.getElementById("generateRubricBtn");

    if (!subject || !gradeLevel || !topic || !totalMarks) {
        setRubricStatus("Please fill all required fields before generating.", true);
        return;
    }

    button.disabled = true;
    button.textContent = "Generating...";
    setRubricStatus("Generating rubric using AI...");

    try {
        const response = await fetch(`${API_BASE}/rubrics/generate`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...getAuthHeaders()
            },
            body: JSON.stringify({
                name,
                subject,
                grade_level: gradeLevel,
                topic,
                total_marks: Number(totalMarks),
                set_active: true
            })
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
            setRubricStatus(data.message || "Rubric generation failed.", true);
            return;
        }

        setRubricStatus("Rubric generated and activated successfully.");
        await loadRubrics();
    } catch (error) {
        console.error("Generate rubric error:", error);
        setRubricStatus("Rubric generation failed.", true);
    } finally {
        button.disabled = false;
        button.innerHTML = `<i class="fas fa-wand-magic-sparkles"></i> Generate Rubric`;
    }
}

async function activateSelectedRubric() {
    if (!rubricState.selectedRubricId) return;
    const button = document.getElementById("activateRubricBtn");
    button.disabled = true;
    button.textContent = "Activating...";

    try {
        const response = await fetch(`${API_BASE}/rubrics/${rubricState.selectedRubricId}/activate`, {
            method: "POST",
            headers: {
                ...getAuthHeaders()
            }
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
            setRubricStatus(data.message || "Unable to activate rubric.", true);
            return;
        }

        setRubricStatus("Selected rubric is now active.");
        await loadRubrics();
    } catch (error) {
        console.error("Activate rubric error:", error);
        setRubricStatus("Unable to activate rubric.", true);
    } finally {
        button.textContent = "Set As Active";
    }
}

function bindRubricEvents() {
    const generateBtn = document.getElementById("generateRubricBtn");
    const activateBtn = document.getElementById("activateRubricBtn");
    const editBtn = document.getElementById("editRubricBtn");
    const saveBtn = document.getElementById("saveRubricBtn");

    if (generateBtn) {
        generateBtn.addEventListener("click", generateRubric);
    }

    if (activateBtn) {
        activateBtn.addEventListener("click", activateSelectedRubric);
    }

    if (editBtn) {
        editBtn.addEventListener("click", toggleRubricEditMode);
    }

    if (saveBtn) {
        saveBtn.addEventListener("click", saveEditedRubric);
    }
}

document.addEventListener("DOMContentLoaded", async () => {
    if (!protectPage()) return;

    renderAdminShell({
        activePage: "rubrics",
        pageContent: `
            <section class="admin-page-header">
                <div>
                    <h1 class="page-title">Essay Rubric Management</h1>
                    <p class="page-subtitle">Generate rubric in admin panel, then users evaluate essays against active rubric.</p>
                </div>
            </section>

            <section class="rubric-card">
                <h3><i class="fas fa-wand-magic-sparkles"></i> Generate New Rubric</h3>
                <div class="rubric-form-grid">
                    <div>
                        <label class="form-label" for="rubricName">Rubric Name (optional)</label>
                        <input class="rubric-text-input" id="rubricName" type="text" placeholder="Essay Midterm Rubric">
                        <div class="rubric-field-hint">A short display name for this rubric.</div>
                    </div>
                    <div>
                        <label class="form-label" for="rubricSubject">Subject</label>
                        <input class="rubric-text-input" id="rubricSubject" type="text" placeholder="English">
                        <div class="rubric-field-hint">Example: English, Urdu, Islamiat, etc.</div>
                    </div>
                    <div>
                        <label class="form-label" for="rubricGradeLevel">Grade Level</label>
                        <input class="rubric-text-input" id="rubricGradeLevel" type="text" placeholder="10">
                        <div class="rubric-field-hint">Enter class/grade, not marks. Example: 10, 12, BS-5.</div>
                    </div>
                    <div>
                        <label class="form-label" for="rubricTotalMarks">Total Marks</label>
                        <input class="rubric-text-input" id="rubricTotalMarks" type="number" min="1" value="10">
                        <div class="rubric-field-hint">Total score allowed for the whole essay.</div>
                    </div>
                </div>
                <div class="modal-field">
                    <label class="form-label" for="rubricTopic">Essay Topic</label>
                    <textarea class="rubric-input" id="rubricTopic" placeholder="Importance of critical thinking in modern education"></textarea>
                    <div class="rubric-field-hint">Write the exact essay topic or prompt students will answer.</div>
                </div>
                <div class="rubric-actions">
                    <span class="form-hint" id="rubricStatus">Ready to generate.</span>
                    <button class="primary" id="generateRubricBtn" type="button">
                        <i class="fas fa-wand-magic-sparkles"></i>
                        Generate Rubric
                    </button>
                </div>
            </section>

            <section class="rubric-card rubric-layout-grid">
                <div class="rubric-list-panel">
                    <div class="rubric-panel-head">
                        <h3><i class="fas fa-layer-group"></i> Saved Rubrics</h3>
                        <button type="button" class="primary ghost" id="activateRubricBtn">Set As Active</button>
                    </div>
                    <div id="rubricList" class="rubric-list-wrap"></div>
                </div>
                <div class="rubric-preview-panel">
                    <div class="rubric-preview-head-actions">
                        <h3><i class="fas fa-file-lines"></i> Rubric Preview</h3>
                        <div class="rubric-preview-actions">
                            <button type="button" class="primary ghost" id="editRubricBtn">Edit Rubric</button>
                            <button type="button" class="primary" id="saveRubricBtn" disabled>Save Changes</button>
                        </div>
                    </div>
                    <div id="rubricPreview" class="rubric-preview"></div>
                </div>
            </section>
        `
    });

    bindRubricEvents();
    await loadRubrics();
});
