const BUBBLE_EVAL_STATE_PREFIX = "intellilearn_bubble_eval";
let bubbleEvaluationPollHandle = null;
let bubbleEvaluationActiveJobId = "";

function getBubbleEvaluationStateKey() {
    const token = getSessionToken();
    return `${BUBBLE_EVAL_STATE_PREFIX}:${token || "anonymous"}`;
}

function readBubbleEvaluationState() {
    try {
        const raw = localStorage.getItem(getBubbleEvaluationStateKey());
        return raw ? JSON.parse(raw) : null;
    } catch (error) {
        console.error("Failed to read bubble evaluation state:", error);
        return null;
    }
}

function writeBubbleEvaluationState(state) {
    try {
        localStorage.setItem(getBubbleEvaluationStateKey(), JSON.stringify(state));
    } catch (error) {
        console.error("Failed to save bubble evaluation state:", error);
    }
}

function clearBubbleEvaluationState() {
    try {
        localStorage.removeItem(getBubbleEvaluationStateKey());
    } catch (error) {
        console.error("Failed to clear bubble evaluation state:", error);
    }
}

function setEvaluationStatus(message, isError = false) {
    const status = document.getElementById("evaluationStatus");
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? "#dc2626" : "";
}

function setEvaluationBanner(active, message) {
    const banner = document.getElementById("evaluationBanner");
    const bannerText = document.getElementById("evaluationBannerText");
    if (!banner || !bannerText) return;

    banner.hidden = !active;
    if (message) {
        bannerText.textContent = message;
    }
}

function renderEvaluationResults(rows) {
    const resultsBody = document.getElementById("resultsBody");
    if (!resultsBody) return;

    if (!Array.isArray(rows) || !rows.length) {
        resultsBody.textContent = "No results yet.";
        return;
    }

    resultsBody.innerHTML = rows.map((row) => `
        <div class="result-row">
            <div>${row.SeatNumber || "N/A"}</div>
            <div>${row.Name || "N/A"}</div>
            <div>${row.FatherName || "N/A"}</div>
            <div>${row.Correct}/${row.Total}</div>
            <div>${row.Score}%</div>
        </div>
    `).join("");
}

function setEvaluationControlsDisabled(disabled) {
    const folderSelect = document.getElementById("folderSelect");
    const keySelect = document.getElementById("answerKeySelect");
    const startBtn = document.getElementById("startEvaluationBtn");

    if (folderSelect) folderSelect.disabled = disabled;
    if (keySelect) keySelect.disabled = disabled;
    if (startBtn) {
        startBtn.disabled = disabled || !(folderSelect && folderSelect.value && keySelect && keySelect.value);
        startBtn.classList.toggle("enabled", !startBtn.disabled);
        startBtn.querySelector("span").textContent = disabled ? "Running..." : "Start Evaluation";
    }
}

function updateStartState() {
    const folderSelect = document.getElementById("folderSelect");
    const keySelect = document.getElementById("answerKeySelect");
    const startBtn = document.getElementById("startEvaluationBtn");
    if (!startBtn || !folderSelect || !keySelect) return;

    const running = bubbleEvaluationActiveJobId !== "";
    const enabled = Boolean(folderSelect.value && keySelect.value) && !running;
    startBtn.disabled = !enabled;
    startBtn.classList.toggle("enabled", enabled);
    startBtn.querySelector("span").textContent = running ? "Running..." : "Start Evaluation";
}

function applyStoredBubbleSelections(state) {
    const folderSelect = document.getElementById("folderSelect");
    const keySelect = document.getElementById("answerKeySelect");

    if (folderSelect && state?.folderPath) {
        folderSelect.value = state.folderPath;
    }
    if (keySelect && state?.answerKeyId) {
        keySelect.value = String(state.answerKeyId);
    }
    updateStartState();
}

async function loadApprovedFolders() {
    const select = document.getElementById("folderSelect");
    if (!select) return;

    select.innerHTML = "<option value=\"\">Loading...</option>";
    const response = await fetch(`${API_BASE}/bubble/approved-folders`, {
        headers: {
            ...getAuthHeaders()
        }
    });
    const data = await response.json();
    const folders = data.folders || [];

    if (!folders.length) {
        select.innerHTML = "<option value=\"\">No approved folders</option>";
        updateStartState();
        return;
    }

    select.innerHTML = folders.map((folder) => `<option value=\"${folder}\">${folder}</option>`).join("");
    select.selectedIndex = 0;
    updateStartState();
}

async function loadAnswerKeys() {
    const select = document.getElementById("answerKeySelect");
    if (!select) return;

    select.innerHTML = "<option value=\"\">Loading...</option>";
    const response = await fetch(`${API_BASE}/answer-keys`, {
        headers: {
            ...getAuthHeaders()
        }
    });
    const data = await response.json();
    const keys = data.keys || [];

    if (!keys.length) {
        select.innerHTML = "<option value=\"\">No answer keys</option>";
        updateStartState();
        return;
    }

    select.innerHTML = keys.map((key) => `<option value=\"${key.id}\">${key.exam_name}</option>`).join("");
    select.selectedIndex = 0;
    updateStartState();
}

function stopBubbleEvaluationPolling() {
    if (bubbleEvaluationPollHandle) {
        clearTimeout(bubbleEvaluationPollHandle);
        bubbleEvaluationPollHandle = null;
    }
}

async function pollBubbleEvaluationStatus(jobId) {
    if (!jobId) return;

    bubbleEvaluationActiveJobId = jobId;
    stopBubbleEvaluationPolling();

    try {
        const response = await fetch(`${API_BASE}/bubble/evaluate/status?job_id=${encodeURIComponent(jobId)}`, {
            headers: {
                ...getAuthHeaders()
            }
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.success) {
            const message = data.message || "Evaluation status could not be loaded.";
            setEvaluationBanner(false, message);
            setEvaluationStatus(message, true);
            bubbleEvaluationActiveJobId = "";
            clearBubbleEvaluationState();
            setEvaluationControlsDisabled(false);
            return;
        }

        if (data.status === "running") {
            const processed = Number(data.processed || 0);
            const total = Number(data.total || 0);
            const progressText = total > 0 ? ` (${processed}/${total})` : "";
            const message = `${data.message || "Evaluation running in background."}${progressText}`;

            setEvaluationBanner(true, message);
            setEvaluationStatus(message);
            writeBubbleEvaluationState({
                jobId,
                folderPath: (readBubbleEvaluationState() || {}).folderPath || "",
                answerKeyId: (readBubbleEvaluationState() || {}).answerKeyId || "",
                status: "running",
                message,
                processed,
                total,
            });

            setEvaluationControlsDisabled(true);
            bubbleEvaluationPollHandle = setTimeout(() => pollBubbleEvaluationStatus(jobId), 1500);
            return;
        }

        if (data.status === "done") {
            const result = data.result || {};
            setEvaluationBanner(false, "Evaluation completed.");
            setEvaluationStatus(data.message || "Evaluation completed.");
            renderEvaluationResults(result.results || []);
            bubbleEvaluationActiveJobId = "";
            clearBubbleEvaluationState();
            setEvaluationControlsDisabled(false);
            return;
        }

        const message = data.message || "Evaluation finished.";
        setEvaluationBanner(false, message);
        setEvaluationStatus(message);
        bubbleEvaluationActiveJobId = "";
        clearBubbleEvaluationState();
        setEvaluationControlsDisabled(false);
    } catch (error) {
        console.error("Evaluation polling error:", error);
        setEvaluationBanner(true, "Evaluation is still running. Reconnecting...");
        setEvaluationStatus("Evaluation is still running. Reconnecting...");
        bubbleEvaluationPollHandle = setTimeout(() => pollBubbleEvaluationStatus(jobId), 2000);
    }
}

async function startEvaluation() {
    const folderSelect = document.getElementById("folderSelect");
    const keySelect = document.getElementById("answerKeySelect");
    if (!folderSelect || !keySelect) return;

    const folderPath = folderSelect.value;
    const answerKeyId = keySelect.value;

    if (!folderPath || !answerKeyId) return;

    const folderLabel = folderSelect.options[folderSelect.selectedIndex]?.textContent || folderPath;
    const keyLabel = keySelect.options[keySelect.selectedIndex]?.textContent || answerKeyId;

    setEvaluationControlsDisabled(true);
    setEvaluationBanner(true, "Submitting evaluation job...");
    setEvaluationStatus("Submitting evaluation job...");

    writeBubbleEvaluationState({
        jobId: "",
        folderPath,
        answerKeyId,
        folderLabel,
        keyLabel,
        status: "starting",
        message: "Submitting evaluation job..."
    });

    try {
        const response = await fetch(`${API_BASE}/bubble/evaluate/start`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...getAuthHeaders()
            },
            body: JSON.stringify({
                folder_path: folderPath,
                answer_key_id: answerKeyId
            })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
            const message = data.message || "Evaluation failed.";
            setEvaluationBanner(false, message);
            setEvaluationStatus(message, true);
            clearBubbleEvaluationState();
            setEvaluationControlsDisabled(false);
            return;
        }

        const jobId = data.job_id || "";
        writeBubbleEvaluationState({
            jobId,
            folderPath,
            answerKeyId,
            folderLabel,
            keyLabel,
            status: "running",
            message: "Evaluation running in background.",
        });

        bubbleEvaluationActiveJobId = jobId;
        await pollBubbleEvaluationStatus(jobId);
    } catch (error) {
        console.error("Evaluation error:", error);
        setEvaluationBanner(false, "Evaluation failed.");
        setEvaluationStatus("Evaluation failed.", true);
        clearBubbleEvaluationState();
        setEvaluationControlsDisabled(false);
    }
}

async function restoreBubbleEvaluationState() {
    const state = readBubbleEvaluationState();
    if (!state || !state.jobId) {
        setEvaluationBanner(false, "");
        setEvaluationStatus("Select a folder and key to start evaluation.");
        updateStartState();
        return;
    }

    applyStoredBubbleSelections(state);
    setEvaluationBanner(true, state.message || "Evaluation running in background.");
    setEvaluationStatus(state.message || "Evaluation running in background.");
    bubbleEvaluationActiveJobId = state.jobId;
    setEvaluationControlsDisabled(true);
    await pollBubbleEvaluationStatus(state.jobId);
}

document.addEventListener("DOMContentLoaded", async () => {
    if (!protectPage()) return;

    const session = getSession();
    const roleBadge = document.getElementById("roleBadge");

    if (session && roleBadge) {
        roleBadge.textContent = session.role || "Examiner";
    }

    const loadFolderPromise = loadApprovedFolders();
    const loadKeyPromise = loadAnswerKeys();

    await Promise.all([loadFolderPromise, loadKeyPromise]);

    const folderSelect = document.getElementById("folderSelect");
    const keySelect = document.getElementById("answerKeySelect");
    const startBtn = document.getElementById("startEvaluationBtn");

    if (folderSelect) folderSelect.addEventListener("change", updateStartState);
    if (keySelect) keySelect.addEventListener("change", updateStartState);
    if (startBtn) startBtn.addEventListener("click", startEvaluation);

    const savedState = readBubbleEvaluationState();
    if (savedState?.jobId) {
        await restoreBubbleEvaluationState();
    } else {
        updateStartState();
        setEvaluationBanner(false, "");
        setEvaluationStatus("Select a folder and key to start evaluation.");
    }

    initializeTopbarMenu();
    initializeLogoutModal();
});