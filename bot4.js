require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// Google Drive Architecture
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || "1Ne1ENfG3xhJ0JMolEb-e4_SlhpMJJNxP";
const DRIVE_KEY_FILE = process.env.DRIVE_CREDENTIALS_FILE 
    ? path.resolve(__dirname, process.env.DRIVE_CREDENTIALS_FILE) 
    : path.join(__dirname, 'drive_pass.json');

let drive = null;
function getDriveClient() {
    if (!drive && fs.existsSync(DRIVE_KEY_FILE)) {
        try {
            const auth = new google.auth.GoogleAuth({
                keyFile: DRIVE_KEY_FILE,
                scopes: ['https://www.googleapis.com/auth/drive.file']
            });
            drive = google.drive({ version: 'v3', auth });
        } catch (e) {
            console.error("❌ bot4 Drive Auth Init Error:", e.message);
        }
    }
    return drive;
}

async function uploadToDrive(filePath, fileName, mimeType) {
    try {
        const driveClient = getDriveClient();
        if (!driveClient) {
            console.error("❌ bot4: Google Drive credentials not configured or file not found:", DRIVE_KEY_FILE);
            return null;
        }
        const file = await driveClient.files.create({ 
            resource: { name: fileName, parents: [DRIVE_FOLDER_ID] }, 
            media: { mimeType: mimeType, body: fs.createReadStream(filePath) }, 
            fields: 'id, webViewLink' 
        });
        await driveClient.permissions.create({ fileId: file.data.id, requestBody: { role: 'reader', type: 'anyone' } });
        return file.data.webViewLink;
    } catch (error) { 
        console.error("❌ bot4 Drive Error:", error.message); 
        return null; 
    }
}

// Directories isolated for Bot 4
const logsDir = path.join(__dirname, 'bot4_logs');
const outboxDir = path.join(__dirname, 'bot4_outbox');
const ologsDir = path.join(__dirname, 'bot4_ologs'); // Online presence logs
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);
if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir);
if (!fs.existsSync(ologsDir)) fs.mkdirSync(ologsDir);

// Target account to track online presence
// The phone number portion — used for matching against any JID format (PN or LID)
const TRACK_PHONE = '919140770471';
const TRACK_JID   = TRACK_PHONE + '@s.whatsapp.net'; // standard PN-based JID for subscribe call
let presenceSubscribeTimer = null; // for periodic re-subscription

// In-memory: store the timestamp when target went online
// This is a single primitive — no memory bloat
let onlineSince = null;

// 365-Day Retention Cleanup
function cleanOldLogs() {
    try {
        const now = Date.now();
        // Clean both chat logs and online logs directories
        for (const dir of [logsDir, ologsDir]) {
            const files = fs.readdirSync(dir);
            files.forEach(file => {
                if (file.endsWith('.json')) {
                    const filePath = path.join(dir, file);
                    const stats = fs.statSync(filePath);
                    if ((now - stats.mtimeMs) / (1000 * 60 * 60 * 24) > 365) {
                        fs.unlinkSync(filePath);
                    }
                }
            });
        }
    } catch (e) { console.error("bot4 Cleanup error:", e.message); }
}

cleanOldLogs();
setInterval(cleanOldLogs, 24 * 60 * 60 * 1000);

let outboxInterval; 

// Helper: write a completed online timespan to the correct day log file
// This is a pure sync function — no promises, no memory retained after call
function writeOnlineSpan(startMs, endMs) {
    try {
        const startDate = new Date(startMs);
        const endDate = new Date(endMs);
        const formatter = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });
        const parts = formatter.formatToParts(startDate);
        const fileName = `${parts.find(p => p.type === 'day').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'year').value}.json`;
        const filePath = path.join(ologsDir, fileName);

        const durationMs = endMs - startMs;
        const durationSec = Math.round(durationMs / 1000);
        const minutes = Math.floor(durationSec / 60);
        const seconds = durationSec % 60;
        const durationStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

        const toIST = (ms) => new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });

        const span = {
            from: toIST(startMs),
            to: toIST(endMs),
            duration: durationStr,
            fromMs: startMs,
            toMs: endMs
        };

        let daySpans = [];
        if (fs.existsSync(filePath)) {
            try { daySpans = JSON.parse(fs.readFileSync(filePath)); } catch(e) { daySpans = []; }
        }
        daySpans.push(span);
        fs.writeFileSync(filePath, JSON.stringify(daySpans, null, 2));
    } catch(e) { console.error('bot4 writeOnlineSpan error:', e.message); }
}


async function startbot4() {
    console.log('\n🤖 Booting bot4 (Media, Call & Outbox Logger)...');
    
    if (outboxInterval) clearInterval(outboxInterval);

    const { version } = await fetchLatestBaileysVersion();
    // 🛑 Crucial: Using auth_baileys_4 to prevent cross-contamination
    const { state, saveCreds } = await useMultiFileAuthState('auth_baileys_4'); 

    const sock4 = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        // CRITICAL: Must be true so WhatsApp treats this as a full active session.
        // Without this, WA server will NOT push presence events (available/unavailable)
        // to this socket, because it treats the session as background/inactive.
        markOnlineOnConnect: true,
        // CRITICAL: Must be warn (not error) so we see the 'no name present' warning
        // if creds.me.name is missing, which silently blocks presenceSubscribe.
        logger: pino({ level: 'warn' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
    });

    sock4.ev.on('creds.update', saveCreds);

    sock4.ev.on('connection.update', async (u) => {
        const { connection, qr } = u;
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === 'open') {
            console.log('\n✅ Bot4 is Online and Logging Account 4.\n');

            // ------------------------------------------------------------------
            // DEFINITIVE PRESENCE SUBSCRIPTION SEQUENCE (confirmed working pattern)
            //
            // WhatsApp requires THREE things in this exact order:
            // 1. The socket must have announced itself as 'available' FIRST.
            //    Without this, WA server ignores presenceSubscribe silently.
            // 2. Wait a short delay to let the 'available' state propagate.
            // 3. THEN call presenceSubscribe for the target JID.
            //
            // markOnlineOnConnect:true above makes WA treat this as an active
            // session, which is what allows it to receive presence push events.
            // ------------------------------------------------------------------
            const doSubscribe = async () => {
                try {
                    // Step 1: Announce ourselves as available (required handshake)
                    await sock4.sendPresenceUpdate('available');
                    console.log('🟢 [PRESENCE] Announced self as available');

                    // Step 2: Brief delay for the available state to register
                    await new Promise(r => setTimeout(r, 2000));

                    // Step 3: Now subscribe to target's presence
                    await sock4.presenceSubscribe(TRACK_JID);
                    console.log(`📶 [PRESENCE] Subscribed to ${TRACK_JID}`);
                    console.log(`🔍 [PRESENCE] Watching +${TRACK_PHONE} for online/offline events...`);
                } catch(e) { 
                    console.error('❌ bot4 presence setup error:', e.message); 
                }
            };

            // Run immediately after connect, and then every 4 minutes to keep alive
            // (WhatsApp presence subscriptions can silently expire)
            await doSubscribe();
            if (presenceSubscribeTimer) clearInterval(presenceSubscribeTimer);
            presenceSubscribeTimer = setInterval(doSubscribe, 4 * 60 * 1000);
        }
        if (connection === 'close') {
            // Stop renewal timer on disconnect
            if (presenceSubscribeTimer) { clearInterval(presenceSubscribeTimer); presenceSubscribeTimer = null; }
            // If we had an open session when connection dropped, close the span
            if (onlineSince !== null) {
                try { writeOnlineSpan(onlineSince, Date.now()); } catch(e){}
                onlineSince = null;
            }
            const reason = u.lastDisconnect?.error?.output?.statusCode || u.lastDisconnect?.error?.message;
            if (reason === 401) {
                console.log("⚠️ Session Invalid (401). Wiping old session data to generate a new QR Code...");
                try { fs.rmSync(path.join(__dirname, 'auth_baileys_4'), { recursive: true, force: true }); } catch(e){}
                console.log("🔄 Exiting process to allow a clean restart...");
                process.exit(1);
            } else {
                console.log(`\n❌ Connection Closed. Reason: ${reason}. Reconnecting in 2s...`);
                setTimeout(startbot4, 2000); 
            }
        }
    });

    // Outbox Scanner for Bot 4
    outboxInterval = setInterval(async () => {
        try {
            const files = fs.readdirSync(outboxDir);
            for (const file of files) {
                if (file.endsWith('.json') && !file.startsWith('status_pong')) {
                    const filePath = path.join(outboxDir, file);
                    const task = JSON.parse(fs.readFileSync(filePath));

                    try {
                        const jid = task.number ? `${task.number}@s.whatsapp.net` : null;

                        if (task.type === 'clear') {
                            await sock4.chatModify({ delete: true, lastMessages: [] }, jid);
                        } 
                        else if (task.type === 'block' || task.type === 'unblock') {
                            try {
                                await sock4.updateBlockStatus(jid, task.type);
                            } catch (blockErr) {
                                if (blockErr.message.includes('bad-request')) {
                                    console.error(`🚫 bot4 Warning: WhatsApp rejected the ${task.type} command for ${task.number}.`);
                                } else { throw blockErr; }
                            }
                        }
                        else if (task.type === 'status') {
                            const statusResponseFile = path.join(outboxDir, 'status_pong.json');
                            fs.writeFileSync(statusResponseFile, JSON.stringify({ status: "online", timestamp: Date.now() }));
                        }
                        else if (task.type === 'send') {
                            await sock4.sendMessage(jid, { text: task.text });
                        }
                        
                        fs.unlinkSync(filePath); 
                    } catch (taskErr) {
                        if (taskErr.message.includes('Connection Closed') || taskErr.message.includes('timed out')) {
                            console.log("⏳ bot4 Socket temporarily closed. Retrying...");
                        } else {
                            console.error("bot4 Outbox Task Error:", taskErr.message);
                            try { fs.unlinkSync(filePath); } catch(e){}
                        }
                    }
                }
            }
        } catch (err) { }
    }, 2000); 

    // 📡 ONLINE PRESENCE TRACKER for +919140770471
    // ROOT CAUSE FIX: WhatsApp now uses LID-format JIDs (e.g. 18713615428427780@lid)
    // instead of phone-number JIDs (919140770471@s.whatsapp.net).
    // The LID is a random opaque number — it does NOT contain the phone number.
    // So `id.includes(TRACK_PHONE)` is ALWAYS false for LID events.
    //
    // SOLUTION: Auto-discover and persist the LID on the FIRST presence event
    // that arrives after we call presenceSubscribe. Since we only subscribe to
    // one user, the first @lid event MUST be for our target. Store it as TRACKED_LID
    // and use it for all future filtering.
    let TRACKED_LID = null; // Will be set from first @lid presence event

    sock4.ev.on('presence.update', ({ id, presences }) => {
        try {
            // Always log raw for diagnostics
            const presenceSummary = Object.entries(presences)
                .map(([jid, p]) => `${jid}=${p.lastKnownPresence}`)
                .join(', ');
            console.log(`[PRESENCE RAW] id=${id} | ${presenceSummary}`);

            // --- Match our target: phone number (PN format) OR discovered LID ---
            const idMatchesPhone    = id.includes(TRACK_PHONE);
            const keyMatchesPhone   = Object.keys(presences).some(j => j.includes(TRACK_PHONE));

            // LID auto-discovery: if we subscribed and see a @lid event we haven't
            // catalogued yet, it MUST be our target — save it.
            if (!TRACKED_LID && !idMatchesPhone && !keyMatchesPhone && id.endsWith('@lid')) {
                TRACKED_LID = id;
                console.log(`[PRESENCE] Auto-identified target LID: ${TRACKED_LID} → +${TRACK_PHONE}`);
            }

            const isOurTarget = idMatchesPhone || keyMatchesPhone || (TRACKED_LID && id === TRACKED_LID);
            if (!isOurTarget) return; // Truly not our target

            // Get status from first presence entry (only one in a 1-on-1 chat)
            let status = null;
            for (const [, p] of Object.entries(presences)) {
                status = p.lastKnownPresence;
                break;
            }
            if (!status) return;

            console.log(`[PRESENCE] Target +${TRACK_PHONE} → ${status}`);

            if (status === 'available' || status === 'composing' || status === 'recording') {
                if (onlineSince === null) {
                    onlineSince = Date.now();
                    console.log(`🟢 [ONLINE] +${TRACK_PHONE} went ONLINE at ${new Date(onlineSince).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true })}`);
                }
            } else if (status === 'unavailable' || status === 'paused') {
                if (onlineSince !== null) {
                    const endMs = Date.now();
                    console.log(`🔴 [OFFLINE] +${TRACK_PHONE} went OFFLINE at ${new Date(endMs).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true })}`);
                    writeOnlineSpan(onlineSince, endMs);
                    onlineSince = null;
                }
            }
        } catch(e) { console.error('bot4 presence.update error:', e.message); }
    });

    // Call Interception Logic
    sock4.ev.on('call', async (calls) => {
        for (const call of calls) {
            try {
                const contactNumber = call.from.split('@')[0].split(':')[0];
                const dateObj = new Date();
                const timeString = dateObj.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
                
                const formatter = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });
                const parts = formatter.formatToParts(dateObj);
                const fileName = `${parts.find(p => p.type === 'day').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'year').value}.json`;
                
                const filePath = path.join(logsDir, fileName);
                let dailyLogs = [];
                if (fs.existsSync(filePath)) dailyLogs = JSON.parse(fs.readFileSync(filePath));

                const callType = call.isVideo ? "Video Call" : "Voice Call";
                
                dailyLogs.push({
                    timestamp: dateObj.getTime(),
                    time: timeString,
                    contact: contactNumber,
                    contactName: "Unknown Contact", 
                    direction: "Received", 
                    message: `📞 [${callType}] Status: ${call.status}`
                });

                fs.writeFileSync(filePath, JSON.stringify(dailyLogs, null, 2));
            } catch (e) { console.error("bot4 Call Log Error:", e.message); }
        }
    });

    // Message Interception Logic
    sock4.ev.on('messages.upsert', async m => {
        try {
            const msg = m.messages[0];
            if (!msg.message) return; 

            const remoteJid = msg.key.remoteJid;
            if (remoteJid === 'status@broadcast') return;

            let rawId = remoteJid.split('@')[0];
            if (msg.key.participant) {
                rawId = msg.key.participant.split('@')[0];
            }
            const contactNumber = rawId.split(':')[0];
            
            const isFromMe = msg.key.fromMe;
            const pushName = msg.pushName || "Unknown Contact";

            let text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            let mediaLink = null;
            let mediaType = null;
            
            const actualMessage = msg.message.extendedTextMessage?.contextInfo?.quotedMessage || msg.message;
            const msgKeys = Object.keys(actualMessage);
            
            if (msgKeys.includes('imageMessage') || msgKeys.includes('videoMessage') || msgKeys.includes('audioMessage') || msgKeys.includes('documentMessage')) {
                try {
                    mediaType = msgKeys.includes('imageMessage') ? 'image' : msgKeys.includes('videoMessage') ? 'video' : msgKeys.includes('audioMessage') ? 'audio' : 'document';
                    
                    const buffer = await downloadMediaMessage(msg, 'buffer', { }, { logger: pino({ level: 'silent' }) });
                    
                    const ext = mediaType === 'image' ? '.jpg' : mediaType === 'video' ? '.mp4' : mediaType === 'audio' ? '.ogg' : '.pdf';
                    // 🛑 Differentiating temp files for Bot 4
                    const tempPath = path.join(__dirname, `bot4_${mediaType}_${Date.now()}${ext}`);
                    
                    fs.writeFileSync(tempPath, buffer);
                    
                    let mime = 'application/octet-stream';
                    if (mediaType === 'image') mime = 'image/jpeg';
                    if (mediaType === 'video') mime = 'video/mp4';
                    if (mediaType === 'audio') mime = 'audio/ogg';
                    
                    mediaLink = await uploadToDrive(tempPath, path.basename(tempPath), mime);
                    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                } catch (err) {
                    console.error("bot4 Media Processing Error:", err.message);
                    mediaLink = "[Media Upload Failed]";
                }
            }

            if (!text && !mediaLink) return;

            let finalMessage = "";
            if (mediaLink) finalMessage += `[${mediaType}] ${mediaLink}\n`;
            if (text) finalMessage += text;

            const dateObj = new Date();
            const timeString = dateObj.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
            
            const formatter = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });
            const parts = formatter.formatToParts(dateObj);
            const fileName = `${parts.find(p => p.type === 'day').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'year').value}.json`;
            
            const filePath = path.join(logsDir, fileName);
            let dailyLogs = [];
            if (fs.existsSync(filePath)) dailyLogs = JSON.parse(fs.readFileSync(filePath));

            dailyLogs.push({
                timestamp: dateObj.getTime(),
                time: timeString,
                contact: contactNumber,
                contactName: isFromMe ? null : pushName, 
                direction: isFromMe ? "Sent" : "Received",
                message: finalMessage.trim()
            });

            fs.writeFileSync(filePath, JSON.stringify(dailyLogs, null, 2));
            
        } catch (e) { 
            console.error("bot4 Log Error:", e.message); 
        }
    });
}

startbot4();
