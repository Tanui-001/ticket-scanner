
# Kalenjin Connect 2.0 — Ticket Scanner

A browser-based event ticket scanner built using HTML, CSS, JavaScript and QR code scanning technology.

## Project files

- index.html — Scanner dashboard
- style.css — User interface styling
- app.js — QR scanning and ticket validation
- tickets.json — Old sample data; the scanner no longer uses this file
- qr-generator.html — QR code generator
- README.md — Project documentation

## How to run

1. Open the project folder in VS Code.
2. Open the terminal.
3. Run:

   python -m http.server 8000

4. Open your browser.
5. Visit:

   http://localhost:8000

## QR code generator

Visit:

http://localhost:8000/qr-generator.html

## Ticket IDs

Each QR code must contain a JSON object with the ticket details:

- Unique ticket ID
- Attendee name
- Optional ticket category (defaults to `General`)
- Optional ticket status (defaults to `valid`)

Example:

```json
{"id":"KC-1011","name":"New Attendee","category":"General","status":"valid"}
```

The QR generator accepts a JSON array and creates up to 1,000 QR codes at a time. The scanner reads the details directly from each QR; no ticket list needs to be loaded in advance.

## Features

- QR code camera scanning
- Manual ticket lookup
- Duplicate ticket detection with a distinct sound alert
- Cancelled ticket detection
- Refunded ticket detection
- Invalid ticket detection
- Automatic check-in timestamp
- Success sound and vibration
- Dashboard statistics
- Recent scan history
- Reset check-ins

## Important limitations

This is a client-side demonstration. The browser stores up to 1,000 unique scanned ticket records and the recent scan log in localStorage. Duplicate detection works on that same browser and site only.

Because the ticket details come from the QR itself, this scanner does not verify that a ticket is authentic. A QR code can be forged. For real admissions, use a backend or signed QR payloads and shared storage.

Camera access requires HTTPS or localhost.
