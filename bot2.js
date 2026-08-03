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
            console.error("❌ Bot2 Drive Auth Init Error:", e.message);
        }
    }
    return drive;
}

async function uploadToDrive(filePath, fileName, mimeType) {
    try {
        const driveClient = getDriveClient();
        if (!driveClient) {
            console.error("❌ Bot2: Google Drive credentials not configured or file not found:", DRIVE_KEY_FILE);
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
        console.error("❌ Bot2 Drive Error:", error.message); 
        return null; 
    }
}

// Directories
const logsDir = path.join(__dirname, 'bot2_logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

// 🛑 Setup Outbox directory for Bot1 -> Bot2 communication
const outboxDir = path.join(__dirname, 'bot2_outbox');
if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir);

// 365-Day Retention Cleanup
function cleanOldLogs() {
    try {
        const files = fs.readdirSync(logsDir);
        const now = Date.now();
        files.forEach(file => {
            if (file.endsWith('.json')) {
                const filePath = path.join(logsDir, file);
                const stats = fs.statSync(filePath);
                if ((now - stats.mtimeMs) / (1000 * 60 * 60 * 24) > 365) {
                    fs.unlinkSync(filePath);
                }
            }
        });
    } catch (e) { console.error("Cleanup error:", e.message); }
}

cleanOldLogs();
setInterval(cleanOldLogs, 24 * 60 * 60 * 1000);

let outboxInterval; // 🛑 Tracks the active scanner to prevent zombies

async function startBot2() {
    console.log('\n🤖 Booting Bot2 (Media, Call & Outbox Logger)...');
    
    // 🛑 THE FIX: Kill any existing zombie scanner before starting a new one
    if (outboxInterval) clearInterval(outboxInterval);

    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState('auth_baileys_2'); 

    const sock2 = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'error' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
    });

    sock2.ev.on('creds.update', saveCreds);

    sock2.ev.on('connection.update', (u) => {
        const { connection, qr } = u;
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === 'open') console.log('\n✅ Bot2 is Online and Logging Account 2.\n');
        if (connection === 'close') setTimeout(startBot2, 2000); 
    });

    // 🛑 UPGRADED: Outbox Scanner handling 'send', 'clear', 'block', 'unblock', and 'status' tasks safely
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
                            await sock2.chatModify({ delete: true, lastMessages: [] }, jid);
                        } 
                        else if (task.type === 'block' || task.type === 'unblock') {
                            try {
                                await sock2.updateBlockStatus(jid, task.type);
                            } catch (blockErr) {
                                if (blockErr.message.includes('bad-request')) {
                                    console.error(`🚫 Bot2 Warning: WhatsApp rejected the ${task.type} command for ${task.number}. The server requires the hidden LID. Account 2 must send or receive at least one message with this number to establish a connection before blocking.`);
                                } else {
                                    throw blockErr; 
                                }
                            }
                        }
                        else if (task.type === 'status') {
                            // Bot2 creates a small response token file to prove it is alive
                            const statusResponseFile = path.join(outboxDir, 'status_pong.json');
                            fs.writeFileSync(statusResponseFile, JSON.stringify({ status: "online", timestamp: Date.now() }));
                        }
                        else if (task.type === 'send') {
                            await sock2.sendMessage(jid, { text: task.text });
                        }
                        
                        fs.unlinkSync(filePath); // Delete the task file instantly upon success
                    } catch (taskErr) {
                        if (taskErr.message.includes('Connection Closed') || taskErr.message.includes('timed out')) {
                            console.log("⏳ Socket temporarily closed. Retrying...");
                        } else {
                            console.error("Bot2 Outbox Task Error:", taskErr.message);
                            try { fs.unlinkSync(filePath); } catch(e){}
                        }
                    }
                }
            }
        } catch (err) { }
    }, 2000); // Scans the folder every 2 seconds

    // Call Interception Logic
    sock2.ev.on('call', async (calls) => {
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
            } catch (e) {
                console.error("Bot2 Call Log Error:", e.message);
            }
        }
    });

    // Message Interception Logic
    sock2.ev.on('messages.upsert', async m => {
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
                    const tempPath = path.join(__dirname, `bot2_${mediaType}_${Date.now()}${ext}`);
                    
                    fs.writeFileSync(tempPath, buffer);
                    
                    let mime = 'application/octet-stream';
                    if (mediaType === 'image') mime = 'image/jpeg';
                    if (mediaType === 'video') mime = 'video/mp4';
                    if (mediaType === 'audio') mime = 'audio/ogg';
                    
                    mediaLink = await uploadToDrive(tempPath, path.basename(tempPath), mime);
                    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                } catch (err) {
                    console.error("Media Processing Error:", err.message);
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
            console.error("Bot2 Log Error:", e.message); 
        }
    });
}

startBot2();
