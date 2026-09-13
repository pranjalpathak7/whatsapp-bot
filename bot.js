require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const systemVitals = require('./system_vitals');
const scheduler = require('./scheduler');
const messageHandler = require('./message_handler');

const TARGET_PHONE = process.env.TARGET_PHONE || '917054406788';
const TARGET_JID = `${TARGET_PHONE}@s.whatsapp.net`;

let globalSock = null;
let ghostHeartbeat = null; // 🛑 The heartbeat controller

// Boot Express Dashboard & Scheduler (Passes the active WhatsApp socket)
scheduler.start(() => globalSock);

const cdcScraper = require('./cdc_scraper');
// USER REQUEST 3: Check every 10 minutes automatically for new notices
setInterval(async () => {
    try {
        console.log('[CDC-CRON] Running 10-minute periodic fetch for CDC notices...');
        const result = await cdcScraper.scrapeCDC(true);
        
        if (result.success && result.newNotices && result.newNotices.length > 0) {
            console.log(`[CDC-CRON] Found ${result.newNotices.length} new notices! Broadcasting to WhatsApp...`);
            if (globalSock) {
                // The user explicitly requested to send to 7447618862.
                // Assuming it's an Indian number (+91)
                const targetJid = '917447618862@s.whatsapp.net';
                
                await globalSock.sendMessage(targetJid, { text: `🚨 *NEW CDC NOTICES DETECTED!* (${result.newNotices.length} new)` });
                
                for (const notice of result.newNotices) {
                    const formattedMessage = `*🏢 Company:* ${notice.company}\n` +
                        `*📋 Type:* ${notice.type}\n` +
                        `*📌 Subject:* ${notice.subject}\n` +
                        `*🕒 Updated At:* ${notice.updateTime}\n` +
                        `*📝 Details:* ${notice.noticeDetails}\n\n` +
                        `*📎 Attachment:* ${notice.downloadLink}`;
                    
                    await globalSock.sendMessage(targetJid, { text: formattedMessage });
                    await new Promise(r => setTimeout(r, 1500)); // Sleep to prevent rate-limiting
                }
            } else {
                console.log('[CDC-CRON] globalSock is disconnected! Could not broadcast new notices.');
            }
        }
    } catch (e) {
        console.error('[CDC-CRON] Periodic fetch error:', e.message);
    }
}, 10 * 60 * 1000);

async function startBot() {
    console.log('\n⏳ Booting Modular Architecture...');
    systemVitals.getHealthStats(__dirname); // Clean any zombies on startup

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📡 WhatsApp v${version.join('.')} (Latest: ${isLatest})`);

    const { state, saveCreds } = await useMultiFileAuthState('auth_baileys');

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'error' }),
        // 🛑 Changed to Ubuntu/Chrome to prevent macOS desktop "always-on" flags
        browser: ['Ubuntu', 'Chrome', '20.0.04'], 
        markOnlineOnConnect: false
    });

    globalSock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect, qr } = u;
        if (qr) qrcode.generate(qr, { small: true });

        if (connection === 'open') {
            console.log('\n✅ Rashi Bot v5 (Microservices Edition) Online\n');
            // Subscribe to live presence updates for the default recipient
            try { 
                sock.presenceSubscribe(TARGET_JID); 
            } catch(e) {}
 
            // 🛑 EXPLICITLY FORCE OFFLINE ON BOOT
            sock.sendPresenceUpdate('unavailable'); 
            
            // 🛑 THE GHOST HEARTBEAT: Forces offline status every 30 seconds
            if (ghostHeartbeat) clearInterval(ghostHeartbeat);
            ghostHeartbeat = setInterval(() => {
                try { 
                    if (globalSock) globalSock.sendPresenceUpdate('unavailable'); 
                } catch(e) {}
            }, 30000);
        }

        if (connection === 'close') {
            // 🛑 Kill heartbeat on disconnect to prevent memory leaks
            if (ghostHeartbeat) clearInterval(ghostHeartbeat); 
            
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('❌ Connection Closed. Reconnecting...');
                setTimeout(startBot, 2000);
            } else {
                console.log('⚠️ Session Invalid (401/loggedOut). Wiping old session data to generate a new QR Code...');
                const fs = require('fs');
                const path = require('path');
                try { fs.rmSync(path.join(__dirname, 'auth_baileys'), { recursive: true, force: true }); } catch(e){}
                console.log("🔄 Exiting process to allow a clean restart...");
                process.exit(1);
            }
        }
    });
    
    // 🛑 NEW: Catch presence updates and overwrite the temporary memory state
    sock.ev.on('presence.update', m => {
        if (m.id === TARGET_JID) {
            const db = require('./database');
            const presenceNode = Object.values(m.presences)[0];
            if (presenceNode) {
                db.currentPresence.status = presenceNode.lastKnownPresence || "offline";
                if (presenceNode.lastSeen) db.currentPresence.lastSeen = presenceNode.lastSeen;
            }
        }
    });

    // Send all messages to the muscle file
    sock.ev.on('messages.upsert', async m => {
        try { 
            await messageHandler.handle(sock, m); 
            // 🛑 RE-ASSERT OFFLINE: Immediately after any message is processed
            sock.sendPresenceUpdate('unavailable');
        }
        catch (e) { console.error("❌ Message Error:", e.message); }
    });
}

startBot();
