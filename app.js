const STORAGE_KEY = "kalenjin-connect-2-scanned-tickets";
const LOG_KEY = "kalenjin-connect-2-scan-log";
const CAPACITY_KEY = "kalenjin-connect-2-capacity";
const MAX_TICKETS = 1000;
const MAX_SCAN_LOG = 100;
const ALARM_MS = 10000;

let ticketsById = new Map();
let scanLog = [];
let capacity = 0;

let scanner = null;
let scannerRunning = false;
let scanHandled = false;      // true once a code has been read; blocks repeat reads
let audioContext = null;
let alarm = null;

const $ = id => document.getElementById(id);

document.addEventListener("DOMContentLoaded", initialise);


// INITIALISE APPLICATION
function initialise() {

    $("start-camera").addEventListener("click", startCamera);
    $("stop-camera").addEventListener("click", stopCamera);
    $("scan-next").addEventListener("click", scanNext);
    $("silence-alarm").addEventListener("click", stopAlarm);
    $("check-ticket").addEventListener("click", checkManualTicket);

    $("ticket-id").addEventListener("keydown", event => {
        if (event.key === "Enter") checkManualTicket();
    });

    $("capacity").addEventListener("input", event => {
        capacity = Math.max(0, parseInt(event.target.value, 10) || 0);
        localStorage.setItem(CAPACITY_KEY, String(capacity));
        updateDashboard();
    });

    $("reset-checkins").addEventListener("click", resetCheckins);
    $("clear-log").addEventListener("click", clearLog);

    try {
        loadSavedData();
        $("capacity").value = capacity || "";
        updateDashboard();
        renderLog();
        showResult("neutral", "AWAITING SCAN", "Ready to verify tickets",
            "Scan a ticket QR code or paste its JSON details.");
    } catch (error) {
        showResult("danger", "SAVED DATA ERROR", "Could not load saved scans", error.message);
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
        if (ticket && typeof ticket.id === "string" && typeof ticket.name === "string") {
            ticketsById.set(ticket.id.toLowerCase(), ticket);
        }
    });

    scanLog = state.scanLog.slice(0, MAX_SCAN_LOG);
    capacity = parseInt(localStorage.getItem(CAPACITY_KEY) || "0", 10) || 0;
}


// SAVE DATA
function saveData(nextTickets, nextLog) {
    localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ tickets: Array.from(nextTickets.values()), scanLog: nextLog })
    );
}


// START CAMERA
async function startCamera() {

    if (scannerRunning) return;

    unlockAudio();
    stopAlarm();

    if (!window.Html5Qrcode) {
        showResult("danger", "SCANNER ERROR", "QR library unavailable",
            "Check your internet connection and reload.");
        return;
    }

    scanner = new Html5Qrcode("reader");
    scanHandled = false;

    try {

        const cameras = await Html5Qrcode.getCameras();
        if (!cameras.length) throw new Error("No camera found.");

        const camera = cameras.find(c => /back|rear|environment/i.test(c.label)) || cameras[0];

        await scanner.start(
            camera.id,
            { fps: 10, qrbox: { width: 230, height: 230 }, aspectRatio: 1 },
            decoded => onScanSuccess(decoded),
            () => {}
        );

        scannerRunning = true;
        document.querySelector(".camera-wrap").classList.add("camera-on");
        $("start-camera").disabled = true;
        $("stop-camera").disabled = false;
        $("scan-next").hidden = true;

    } catch (error) {
        showResult("danger", "CAMERA ERROR", "Unable to start camera",
            error.message || "Allow camera access and use HTTPS or localhost.");
        scanner = null;
    }
}


// STOP CAMERA
async function stopCamera() {

    if (!scanner || !scannerRunning) return;

    scannerRunning = false;
    const current = scanner;
    scanner = null;

    try {
        await current.stop();
        await current.clear();
    } catch (error) {
        console.warn(error);
    }

    document.querySelector(".camera-wrap").classList.remove("camera-on");
    $("start-camera").disabled = false;
    $("stop-camera").disabled = true;
}


// SCAN THE NEXT TICKET
function scanNext() {
    stopAlarm();
    showResult("neutral", "AWAITING SCAN", "Ready to verify tickets",
        "Scan a ticket QR code or paste its JSON details.");
    startCamera();
}


// HANDLE QR SCAN: stop the camera at once, then show the details
function onScanSuccess(decodedText) {

    if (scanHandled) return;
    scanHandled = true;

    stopCamera();
    verifyTicket(decodedText.trim());
}


// MANUAL TICKET CHECK
function checkManualTicket() {

    unlockAudio();

    const payload = $("ticket-id").value.trim();

    if (!payload) {
        showResult("warning", "MISSING DETAILS", "Enter ticket data",
            'Paste the QR JSON containing the ticket "id" and "name".');
        $("ticket-id").focus();
        return;
    }

    verifyTicket(payload);
    $("ticket-id").value = "";
}


// READ ALL TICKET DETAILS FROM THE QR PAYLOAD
function parseTicketPayload(payload) {

    let data;

    try {
        data = JSON.parse(payload);
    } catch {
        return null;
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) return null;

    const id = String(data.id || data.ticketId || "").trim();
    const name = String(data.name || data.attendee || "").trim();
    const category = String(data.category || "General").trim();
    const status = String(data.status || "valid").trim().toLowerCase();

    if (!id || !name || id.length > 128 || name.length > 200 ||
        category.length > 100 || status.length > 40) {
        return null;
    }

    // keep every field in the QR (email, phone, seat, ...) so it can be displayed
    const fields = {};
    Object.keys(data).slice(0, 30).forEach(key => {
        const value = data[key];
        if (["string", "number", "boolean"].includes(typeof value)) {
            fields[key.slice(0, 50)] = String(value).slice(0, 300);
        }
    });

    return { id, name, category, status, fields };
}


// SAVE ONE TICKET RECORD AND ITS SCAN LOG ENTRY
function recordScan(ticketId, status, attendee, kind, nextTickets) {

    const nextLog = [{
        ticketId, status, attendee, kind, time: new Date().toISOString()
    }, ...scanLog].slice(0, MAX_SCAN_LOG);

    try {
        saveData(nextTickets || ticketsById, nextLog);
    } catch (error) {
        showResult("danger", "SAVE ERROR", "Could not save this scan",
            "Browser storage is unavailable or full. " + error.message);
        console.error(error);
        return false;
    }

    if (nextTickets) ticketsById = nextTickets;

    scanLog = nextLog;
    updateDashboard();
    renderLog();
    return true;
}


// VERIFY TICKET
function verifyTicket(payload) {

    const ticket = parseTicketPayload(payload);

    if (!ticket) {
        recordScan("—", "Unreadable", "Unknown attendee", "danger");
        showResult("danger", "UNREADABLE TICKET", "Ticket details not found",
            'QR must contain JSON with "id" and "name" fields.');
        playAlert("invalid");
        return;
    }

    const key = ticket.id.toLowerCase();
    const saved = ticketsById.get(key);

    // ---- ALREADY SCANNED ----
    if (saved) {

        const blocked = saved.status === "cancelled" || saved.status === "refunded";

        if (!recordScan(saved.id, blocked ? saved.status : "Duplicate",
            saved.name, "danger")) return;

        if (blocked) {
            showResult("danger", saved.status.toUpperCase() + " TICKET",
                saved.name + " — not admitted",
                `Ticket ${saved.id} is ${saved.status}. Refer attendee to the event desk.`,
                saved.fields);
            playAlert("invalid");
            return;
        }

        showResult("danger alarm", "⚠ DUPLICATE TICKET — DO NOT ADMIT",
            saved.name + " was already scanned",
            `Ticket ${saved.id} was first scanned at ${new Date(saved.firstScannedAt).toLocaleString()}.`,
            saved.fields);
        startAlarm();
        return;
    }

    if (ticketsById.size >= MAX_TICKETS) {
        showResult("danger", "CAPACITY REACHED", "1,000 unique tickets already saved",
            "This new ticket was not saved. Previously scanned tickets can still be checked for duplicates.",
            ticket.fields);
        playAlert("invalid");
        return;
    }

    const time = new Date().toISOString();
    const record = {
        id: ticket.id,
        name: ticket.name,
        category: ticket.category,
        status: ticket.status,
        fields: ticket.fields,
        firstScannedAt: time,
        checkedInAt: ticket.status === "valid" ? time : null
    };
    const nextTickets = new Map(ticketsById);
    nextTickets.set(key, record);

    // ---- CANCELLED / REFUNDED ----
    if (ticket.status === "cancelled" || ticket.status === "refunded") {
        if (!recordScan(ticket.id, ticket.status, ticket.name, "danger", nextTickets)) return;
        showResult("danger", ticket.status.toUpperCase() + " TICKET",
            ticket.name + " — not admitted",
            `Ticket ${ticket.id} is ${ticket.status}. Refer attendee to the event desk.`,
            ticket.fields);
        playAlert("invalid");
        return;
    }

    // ---- ANY OTHER STATUS ----
    if (ticket.status !== "valid") {
        if (!recordScan(ticket.id, ticket.status, ticket.name, "warning", nextTickets)) return;
        showResult("warning", "TICKET ON HOLD", "Ticket cannot be checked in",
            `Ticket status: ${ticket.status}. Ask the supervisor to verify.`, ticket.fields);
        playAlert("invalid");
        return;
    }

    // ---- VALID ----
    if (!recordScan(ticket.id, "Checked in", ticket.name, "success", nextTickets)) return;

    showResult("success", "TICKET VALID — CHECKED IN",
        `${ticket.name} · ${ticket.category}`,
        `Checked in at ${new Date(time).toLocaleTimeString()}.`,
        ticket.fields);
    playAlert("success");
}


// DISPLAY RESULT (with every field read from the QR)
function showResult(type, label, title, details, fields) {

    $("result-card").className = "result-card " + type;

    $("result-label").textContent = label;
    $("result-title").textContent = title;
    $("result-details").textContent = details;

    const list = $("result-fields");
    list.replaceChildren();

    if (fields) {
        Object.entries(fields).forEach(([key, value]) => {
            const dt = document.createElement("dt");
            dt.textContent = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
            const dd = document.createElement("dd");
            dd.textContent = value;
            list.append(dt, dd);
        });
    }

    $("result-symbol").textContent =
        type === "success" ? "✓" :
        type.startsWith("danger") ? "×" :
        type === "warning" ? "!" : "✓";

    $("result-time").textContent = new Date().toLocaleTimeString();

    // after a scan the camera is stopped: offer the next scan
    $("scan-next").hidden = type === "neutral" || scannerRunning;
}


// UPDATE DASHBOARD
function updateDashboard() {

    const saved = Array.from(ticketsById.values());
    const checked = saved.filter(ticket => ticket.checkedInAt).length;

    $("total-count").textContent = saved.length;
    $("checked-count").textContent = checked;
    $("remaining-count").textContent =
        capacity > 0 ? Math.max(0, capacity - checked) : "—";
}


// DISPLAY RECENT SCANS
function renderLog() {

    const body = $("scan-log");

    if (!scanLog.length) {
        body.innerHTML = `
            <tr><td colspan="4" class="empty-row">No scans recorded yet.</td></tr>`;
        return;
    }

    body.innerHTML = scanLog.map(entry => {

        const time = new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const kind = ["success", "warning", "danger"].includes(entry.kind) ? entry.kind : "warning";

        return `
            <tr>
                <td><span class="status-tag ${kind}"><i class="status-dot"></i>${escapeHtml(entry.status)}</span></td>
                <td><strong>${escapeHtml(entry.ticketId)}</strong></td>
                <td>${escapeHtml(entry.attendee)}</td>
                <td>${escapeHtml(time)}</td>
            </tr>`;
    }).join("");
}


// CLEAR RECENT SCAN HISTORY
function clearLog() {

    if (!confirm("Clear recent scan history? Saved tickets will remain.")) return;

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

    if (!confirm("Delete all saved ticket records from this browser?")) return;

    const emptyTickets = new Map();
    try {
        saveData(emptyTickets, []);
    } catch (error) {
        showResult("danger", "SAVE ERROR", "Could not reset saved tickets", error.message);
        console.error(error);
        return;
    }

    stopAlarm();
    ticketsById = emptyTickets;
    scanLog = [];
    updateDashboard();
    renderLog();

    showResult("neutral", "RECORDS RESET", "Scanner is ready",
        "All ticket records saved in this browser have been deleted.");
}


// AUDIO
function unlockAudio() {

    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;

        if (!audioContext) audioContext = new AudioContextClass();

        if (audioContext.state === "suspended") {
            audioContext.resume().catch(error => console.warn("Audio unavailable", error));
        }
    } catch (error) {
        console.warn("Audio unavailable", error);
    }
}

// LOUD REPEATING SIREN FOR DUPLICATE TICKETS (stops after 10 s or on "Silence alarm")
function startAlarm() {

    unlockAudio();
    stopAlarm();

    if ("vibrate" in navigator) navigator.vibrate([400, 150, 400, 150, 400, 150, 400]);

    if (!audioContext) return;

    try {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();

        oscillator.type = "square";
        oscillator.frequency.value = 1000;
        gain.gain.value = 0.6;

        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start();

        let high = true;
        alarm = {
            oscillator,
            gain,
            interval: setInterval(() => {
                high = !high;
                oscillator.frequency.setValueAtTime(high ? 1000 : 650, audioContext.currentTime);
            }, 280),
            timeout: setTimeout(stopAlarm, ALARM_MS)
        };

        $("silence-alarm").hidden = false;

    } catch (error) {
        console.warn("Audio unavailable", error);
    }
}

function stopAlarm() {

    if (alarm) {
        clearInterval(alarm.interval);
        clearTimeout(alarm.timeout);
        try {
            alarm.oscillator.stop();
            alarm.gain.disconnect();
        } catch (error) {
            console.warn(error);
        }
        alarm = null;
    }

    if ("vibrate" in navigator) navigator.vibrate(0);

    $("silence-alarm").hidden = true;
    $("result-card").classList.remove("alarm");
}

// SHORT BEEPS FOR OTHER RESULTS
function playAlert(type) {

    if ("vibrate" in navigator) {
        if (type === "success") navigator.vibrate([120, 60, 120]);
        if (type === "invalid") navigator.vibrate([300, 100, 300]);
    }

    const tones = type === "success"
        ? [[880, 0, 0.18]]
        : [[260, 0, 0.35], [200, 0.4, 0.35]];

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
                gain.gain.exponentialRampToValueAtTime(0.3, start + 0.01);
                gain.gain.exponentialRampToValueAtTime(0.001, start + duration);

                oscillator.start(start);
                oscillator.stop(start + duration);
            });
        };

        if (audioContext.state === "suspended") {
            audioContext.resume().then(playTones).catch(error => console.warn("Audio unavailable", error));
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
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[char]));
}