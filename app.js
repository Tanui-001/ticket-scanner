
const STORAGE_KEY = "kalenjin-connect-2-scanned-tickets";
const LOG_KEY = "kalenjin-connect-2-scan-log";
const SCAN_COOLDOWN_MS = 3000;
const MAX_TICKETS = 1000;
const MAX_SCAN_LOG = 100;

let ticketsById = new Map();
let scanLog = [];

let scanner = null;
let scannerRunning = false;
let audioContext = null;

let lastScanValue = "";
let lastScanAt = 0;

const $ = id => document.getElementById(id);

document.addEventListener("DOMContentLoaded", initialise);


// INITIALISE APPLICATION
function initialise() {

    $("start-camera").addEventListener("click", startCamera);
    $("stop-camera").addEventListener("click", stopCamera);

    $("check-ticket").addEventListener("click", checkManualTicket);

    $("ticket-id").addEventListener("keydown", event => {
        if (event.key === "Enter") {
            checkManualTicket();
        }
    });

    $("reset-checkins").addEventListener("click", resetCheckins);
    $("clear-log").addEventListener("click", clearLog);

    try {
        loadSavedData();
        updateDashboard();
        renderLog();

        showResult(
            "neutral",
            "AWAITING SCAN",
            "Ready to verify tickets",
            "Scan a ticket QR code or paste its JSON details."
        );
    } catch (error) {
        showResult(
            "danger",
            "SAVED DATA ERROR",
            "Could not load saved scans",
            error.message
        );
        console.error(error);
        $("start-camera").disabled = true;
        $("check-ticket").disabled = true;
    }
}


// LOAD SAVED DATA
function loadSavedData() {

    const savedState = localStorage.getItem(STORAGE_KEY);
    const state = savedState ? JSON.parse(savedState) : {
        tickets: [],
        scanLog: JSON.parse(localStorage.getItem(LOG_KEY) || "[]")
    };

    if (!Array.isArray(state.tickets) || !Array.isArray(state.scanLog)) {
        throw new Error("Saved ticket data is invalid. Reset browser data to continue.");
    }

    ticketsById = new Map();
    state.tickets.slice(0, MAX_TICKETS).forEach(ticket => {
        if (
            ticket &&
            typeof ticket.id === "string" &&
            typeof ticket.name === "string"
        ) {
            ticketsById.set(ticket.id.toLowerCase(), ticket);
        }
    });

    scanLog = state.scanLog.slice(0, MAX_SCAN_LOG);
}


// SAVE DATA
function saveData(nextTickets, nextLog) {
    localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
            tickets: Array.from(nextTickets.values()),
            scanLog: nextLog
        })
    );
}


// START CAMERA
async function startCamera() {

    if (scannerRunning) return;

    unlockAudio();

    if (!window.Html5Qrcode) {

        showResult(
            "danger",
            "SCANNER ERROR",
            "QR library unavailable",
            "Check your internet connection and reload."
        );

        return;
    }

    scanner = new Html5Qrcode("reader");

    try {

        const cameras = await Html5Qrcode.getCameras();

        if (!cameras.length) {
            throw new Error("No camera found.");
        }

        const camera =
            cameras.find(c =>
                /back|rear|environment/i.test(c.label)
            ) || cameras[0];

        await scanner.start(
            camera.id,
            {
                fps: 10,
                qrbox: {
                    width: 230,
                    height: 230
                },
                aspectRatio: 1
            },
            decoded => onScanSuccess(decoded),
            () => {}
        );

        scannerRunning = true;

        document.querySelector(".camera-wrap")
            .classList.add("camera-on");

        $("start-camera").disabled = true;
        $("stop-camera").disabled = false;

    } catch (error) {

        showResult(
            "danger",
            "CAMERA ERROR",
            "Unable to start camera",
            error.message || "Allow camera access and use HTTPS or localhost."
        );

        scanner = null;
    }
}


// STOP CAMERA
async function stopCamera() {

    if (!scanner || !scannerRunning) return;

    try {

        await scanner.stop();
        await scanner.clear();

    } catch (error) {
        console.warn(error);
    }

    scanner = null;
    scannerRunning = false;

    document.querySelector(".camera-wrap")
        .classList.remove("camera-on");

    $("start-camera").disabled = false;
    $("stop-camera").disabled = true;
}


// HANDLE QR SCAN
function onScanSuccess(decodedText) {

    const now = Date.now();

    // Ignore the same ticket for three seconds.
    if (
        decodedText === lastScanValue &&
        now - lastScanAt < SCAN_COOLDOWN_MS
    ) {
        return;
    }

    lastScanValue = decodedText;
    lastScanAt = now;

    verifyTicket(decodedText.trim());
}


// MANUAL TICKET CHECK
function checkManualTicket() {

    unlockAudio();

    const payload = $("ticket-id").value.trim();

    if (!payload) {
        showResult(
            "warning",
            "MISSING DETAILS",
            "Enter ticket data",
            'Paste the QR JSON containing the ticket "id" and "name".'
        );

        $("ticket-id").focus();
        return;
    }

    verifyTicket(payload);

    $("ticket-id").value = "";
}


// READ TICKET DETAILS FROM THE QR PAYLOAD
function parseTicketPayload(payload) {

    let data;

    try {
        data = JSON.parse(payload);
    } catch {
        return null;
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
        return null;
    }

    const id = String(data.id || data.ticketId || "").trim();
    const name = String(data.name || data.attendee || "").trim();
    const category = String(data.category || "General").trim();
    const status = String(data.status || "valid").trim().toLowerCase();

    if (
        !id ||
        !name ||
        id.length > 128 ||
        name.length > 200 ||
        category.length > 100 ||
        status.length > 40
    ) {
        return null;
    }

    return { id, name, category, status };
}


// SAVE ONE TICKET RECORD AND ITS SCAN LOG ENTRY
function recordScan(ticketId, status, attendee, kind, nextTickets) {

    const nextLog = [{
        ticketId,
        status,
        attendee,
        kind,
        time: new Date().toISOString()
    }, ...scanLog].slice(0, MAX_SCAN_LOG);

    try {
        saveData(nextTickets || ticketsById, nextLog);
    } catch (error) {
        showResult(
            "danger",
            "SAVE ERROR",
            "Could not save this scan",
            "Browser storage is unavailable or full. " + error.message
        );
        console.error(error);
        return false;
    }

    if (nextTickets) {
        ticketsById = nextTickets;
    }

    scanLog = nextLog;
    updateDashboard();
    renderLog();
    return true;
}


// VERIFY TICKET
function verifyTicket(payload) {

    const ticket = parseTicketPayload(payload);

    if (!ticket) {
        showResult(
            "danger",
            "UNREADABLE TICKET",
            "Ticket details not found",
            'QR must contain JSON with "id" and "name" fields.'
        );
        recordScan(
            String(payload).slice(0, 128),
            "Unreadable",
            "Unknown attendee",
            "danger"
        );
        playAlert("invalid");
        return;
    }

    const key = ticket.id.toLowerCase();
    const savedTicket = ticketsById.get(key);

    if (savedTicket) {
        if (!recordScan(
            savedTicket.id,
            "Duplicate",
            savedTicket.name,
            "warning"
        )) {
            return;
        }

        showResult(
            "warning",
            "DUPLICATE SCAN",
            savedTicket.name + " was already scanned",
            `Ticket ${savedTicket.id} was first scanned at ${new Date(savedTicket.firstScannedAt).toLocaleString()}.`
        );
        playAlert("duplicate");
        return;
    }

    if (ticketsById.size >= MAX_TICKETS) {
        showResult(
            "danger",
            "CAPACITY REACHED",
            "1,000 unique tickets already saved",
            "This new ticket was not saved. Previously scanned tickets can still be checked for duplicates."
        );
        playAlert("invalid");
        return;
    }

    const time = new Date().toISOString();
    const scannedTicket = {
        ...ticket,
        firstScannedAt: time,
        checkedInAt: ticket.status === "valid" ? time : null
    };
    const nextTickets = new Map(ticketsById);
    nextTickets.set(key, scannedTicket);

    if (ticket.status === "cancelled" || ticket.status === "refunded") {
        if (!recordScan(ticket.id, ticket.status, ticket.name, "danger", nextTickets)) {
            return;
        }

        showResult(
            "danger",
            ticket.status.toUpperCase() + " TICKET",
            ticket.name + " — not admitted",
            `Ticket ${ticket.id} is ${ticket.status}. Refer attendee to the event desk.`
        );
        playAlert("invalid");
        return;
    }

    if (ticket.status !== "valid") {
        if (!recordScan(ticket.id, ticket.status, ticket.name, "warning", nextTickets)) {
            return;
        }

        showResult(
            "warning",
            "TICKET ON HOLD",
            "Ticket cannot be checked in",
            `Ticket status: ${ticket.status}. Ask the supervisor to verify.`
        );
        playAlert("invalid");
        return;
    }

    if (!recordScan(ticket.id, "Checked in", ticket.name, "success", nextTickets)) {
        return;
    }

    showResult(
        "success",
        "TICKET RECORDED",
        `${ticket.name} · ${ticket.category}`,
        `Recorded and checked in at ${new Date(time).toLocaleTimeString()}.`
    );
    playAlert("success");
}


// DISPLAY RESULT
function showResult(type, label, title, details) {

    $("result-card").className = "result-card " + type;

    $("result-label").textContent = label;
    $("result-title").textContent = title;
    $("result-details").textContent = details;

    $("result-symbol").textContent =
        type === "success" ? "✓" :
        type === "warning" ? "!" :
        type === "danger" ? "×" : "✓";

    $("result-time").textContent =
        new Date().toLocaleTimeString();
}


// UPDATE DASHBOARD
function updateDashboard() {

    const savedTickets = Array.from(ticketsById.values());
    const checked = savedTickets.filter(ticket => ticket.checkedInAt).length;

    $("total-count").textContent = savedTickets.length;
    $("checked-count").textContent = checked;
    $("remaining-count").textContent =
        Math.max(0, MAX_TICKETS - savedTickets.length);
}


// DISPLAY RECENT SCANS
function renderLog() {

    const body = $("scan-log");

    if (!scanLog.length) {

        body.innerHTML = `
            <tr>
                <td colspan="4" class="empty-row">
                    No scans recorded yet.
                </td>
            </tr>
        `;

        return;
    }

    body.innerHTML = scanLog.map(entry => {

        const time = new Date(entry.time).toLocaleTimeString(
            [],
            {
                hour: "2-digit",
                minute: "2-digit"
            }
        );

        const kind = ["success", "warning", "danger"]
            .includes(entry.kind) ? entry.kind : "warning";

        return `
            <tr>

                <td>
                    <span class="status-tag ${kind}">
                        <i class="status-dot"></i>
                        ${escapeHtml(entry.status)}
                    </span>
                </td>

                <td>
                    <strong>${escapeHtml(entry.ticketId)}</strong>
                </td>

                <td>${escapeHtml(entry.attendee)}</td>

                <td>${escapeHtml(time)}</td>

            </tr>
        `;

    }).join("");
}


// CLEAR RECENT SCAN HISTORY
function clearLog() {

    if (!confirm("Clear recent scan history? Saved tickets will remain.")) {
        return;
    }

    try {
        saveData(ticketsById, []);
        scanLog = [];
    } catch (error) {
        showResult("danger", "SAVE ERROR", "Could not clear scan history", error.message);
        console.error(error);
        return;
    }
    renderLog();
}


// RESET SAVED TICKET RECORDS
function resetCheckins() {

    if (!confirm("Delete all saved ticket records from this browser?")) {
        return;
    }

    const emptyTickets = new Map();
    try {
        saveData(emptyTickets, []);
    } catch (error) {
        showResult("danger", "SAVE ERROR", "Could not reset saved tickets", error.message);
        console.error(error);
        return;
    }

    ticketsById = emptyTickets;
    scanLog = [];
    updateDashboard();
    renderLog();

    showResult(
        "neutral",
        "RECORDS RESET",
        "Scanner is ready",
        "All ticket records saved in this browser have been deleted."
    );
}


// SOUND AND VIBRATION ALERT
function unlockAudio() {

    try {
        const AudioContextClass =
            window.AudioContext || window.webkitAudioContext;

        if (!AudioContextClass) return;

        if (!audioContext) {
            audioContext = new AudioContextClass();
        }

        if (audioContext.state === "suspended") {
            audioContext.resume().catch(error => {
                console.warn("Audio unavailable", error);
            });
        }
    } catch (error) {
        console.warn("Audio unavailable", error);
    }
}

function playAlert(type) {

    if ("vibrate" in navigator) {
        if (type === "success") navigator.vibrate([120, 60, 120]);
        if (type === "duplicate") navigator.vibrate([260, 100, 260, 100, 260]);
    }

    const tones = type === "duplicate"
        ? [[330, 0, 0.13], [220, 0.2, 0.18], [330, 0.46, 0.13]]
        : type === "success"
            ? [[880, 0, 0.18]]
            : [[260, 0, 0.35]];

    try {
        if (!audioContext) return;

        const playTones = () => {
            tones.forEach(([frequency, offset, duration]) => {
                const start = audioContext.currentTime + offset;
                const oscillator = audioContext.createOscillator();
                const gain = audioContext.createGain();

                oscillator.connect(gain);
                gain.connect(audioContext.destination);
                oscillator.frequency.setValueAtTime(frequency, start);
                gain.gain.setValueAtTime(0.001, start);
                gain.gain.exponentialRampToValueAtTime(0.08, start + 0.01);
                gain.gain.exponentialRampToValueAtTime(0.001, start + duration);

                oscillator.start(start);
                oscillator.stop(start + duration);
            });
        };

        if (audioContext.state === "suspended") {
            audioContext.resume().then(playTones).catch(error => {
                console.warn("Audio unavailable", error);
            });
        } else {
            playTones();
        }

    } catch (error) {
        console.warn("Audio unavailable", error);
    }
}


// PREVENT HTML INJECTION IN SCAN LOG
function escapeHtml(value) {

    return String(value).replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    }[char]));
}
