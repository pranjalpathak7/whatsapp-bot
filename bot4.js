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
const TRACK_JID = '917054406788@s.whatsapp.net';

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
        logger: pino({ level: 'error' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
    });

    sock4.ev.on('creds.update', saveCreds);

    sock4.ev.on('connection.update', async (u) => {
        const { connection, qr } = u;
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === 'open') {
            console.log('\n✅ Bot4 is Online and Logging Account 4.\n');
            // Subscribe to presence updates for the tracked number
            // This tells WhatsApp server to push presence events for this contact
            try {
                await sock4.presenceSubscribe(TRACK_JID);
                console.log(`📶 Subscribed to presence for ${TRACK_JID}`);
            } catch(e) { console.error('bot4 presenceSubscribe error:', e.message); }
        }
        if (connection === 'close') {
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

    // 📡 ONLINE PRESENCE TRACKER for +917054406788
    // WhatsApp pushes 'available'/'unavailable' presence updates for subscribed contacts.
    // We record timespans: when they go available = span starts; when unavailable = span ends.
    // onlineSince is a single epoch ms number — negligible memory footprint.
    sock4.ev.on('presence.update', ({ id, presences }) => {
        try {
            if (id !== TRACK_JID) return; // Only care about our target

            const presenceData = presences[TRACK_JID];
            if (!presenceData) return;

            const status = presenceData.lastKnownPresence; // 'available' | 'unavailable' | 'composing' etc.

            if (status === 'available' || status === 'composing') {
                // Target came online — record start time (only if not already tracking)
                if (onlineSince === null) {
                    onlineSince = Date.now();
                    console.log(`\ud83d\udfe2 [PRESENCE] 917054406788 went ONLINE at ${new Date(onlineSince).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true })}`);
                }
            } else if (status === 'unavailable') {
                // Target went offline — close the span if we were tracking
                if (onlineSince !== null) {
                    const endMs = Date.now();
                    console.log(`\ud83d\udd34 [PRESENCE] 917054406788 went OFFLINE at ${new Date(endMs).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true })}`);
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
