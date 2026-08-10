require('dotenv').config();
const { delay } = require('@whiskeysockets/baileys');
const { google } = require('googleapis');
const exec = require('yt-dlp-exec');
const { exec: cpExec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('./database');
const systemVitals = require('./system_vitals');
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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
            console.error("❌ Drive Auth Init Error:", e.message);
        }
    }
    return drive;
}

async function uploadToDrive(filePath, fileName) {
    try {
        const driveClient = getDriveClient();
        if (!driveClient) {
            console.error("❌ Google Drive credentials not configured or file not found:", DRIVE_KEY_FILE);
            return null;
        }
        console.log("☁️ Uploading with Validated Identity...");
        const file = await driveClient.files.create({ 
            resource: { name: fileName, parents: [DRIVE_FOLDER_ID] }, 
            media: { mimeType: 'video/mp4', body: fs.createReadStream(filePath) }, 
            fields: 'id, webViewLink' 
        });
        await driveClient.permissions.create({ fileId: file.data.id, requestBody: { role: 'reader', type: 'anyone' } });
        return file.data.webViewLink;
    } catch (error) { console.error("❌ Drive Error:", error.message); return null; }
}

function runShellCommand(cmd, cwd = __dirname) {
    return new Promise((resolve) => {
        const execOptions = {
            cwd,
            env: {
                ...process.env,
                PATH: (process.env.PATH || '') + ':/usr/local/bin:/usr/bin:~/.nvm/versions/node/' + process.version + '/bin'
            },
            maxBuffer: 1024 * 1024 * 5
        };
        cpExec(cmd, execOptions, (err, stdout, stderr) => {
            resolve({
                success: !err,
                code: err ? (err.code || 1) : 0,
                error: err ? err.message : null,
                stdout: (stdout || '').toString().trim(),
                stderr: (stderr || '').toString().trim()
            });
        });
    });
}

module.exports = {
    handle: async function(sock, m) {
        const msg = m.messages[0];
        if (!msg || !msg.message) return;

        // Extract message text across all Baileys types (standard, ephemeral/disappearing, view-once, captioned media)
        const rawMsg = msg.message;
        const innerMsg = rawMsg.ephemeralMessage?.message || 
                         rawMsg.viewOnceMessage?.message || 
                         rawMsg.viewOnceMessageV2?.message || 
                         rawMsg.documentWithCaptionMessage?.message || 
                         rawMsg;

        const text = innerMsg.conversation || 
                     innerMsg.extendedTextMessage?.text || 
                     innerMsg.imageMessage?.caption || 
                     innerMsg.videoMessage?.caption || 
                     "";

        const sender = msg.key.remoteJid;
        const fromMe = msg.key.fromMe;
        if (!text) return;

        const pushName = msg.pushName || "User";
        const senderLabel = `[User: ${pushName}]`;

        let logs = db.groupLogs.get(sender) || [];
        logs.push(`${senderLabel}: ${text}`);
        if(logs.length > 50) logs.shift();
        db.groupLogs.set(sender, logs);

        if (text === '.vitals') {
            await sock.sendMessage(sender, { text: "🩺 Running diagnostics..." });
            await sock.sendMessage(sender, { text: systemVitals.getHealthStats(__dirname) });
            return;
        }

        const trimmedText = text.trim();
        if (trimmedText.toLowerCase() === '.pull' || trimmedText.toLowerCase().startsWith('.pull ')) {
            console.log(`📡 [PULL COMMAND] Triggered by ${sender}`);

            // Find project repository directory (.git location)
            const homeDir = os.homedir ? os.homedir() : '';
            const candidateDirs = [
                __dirname,
                process.cwd(),
                path.join(homeDir, 'my-bot'),
                path.join(homeDir, 'whatsapp-bot'),
                '/root/my-bot',
                '/home/ubuntu/my-bot'
            ];

            let repoDir = __dirname;
            for (const cDir of candidateDirs) {
                if (cDir && fs.existsSync(path.join(cDir, '.git'))) {
                    repoDir = cDir;
                    break;
                }
            }

            await sock.sendMessage(sender, { 
                text: `🔄 *[Step 1/3] Git Pull Initiated*\n📁 *Directory:* \`${repoDir}\`\n⏳ Fetching updates from GitHub...` 
            });

            // 1. Run git pull (explicitly syncing with origin/main)
            const gitRes = await runShellCommand('git fetch origin main && git checkout -B main origin/main && git pull origin main', repoDir);
            const gitOutput = gitRes.stdout || gitRes.stderr || (gitRes.success ? "Already up to date." : "No output returned.");

            if (!gitRes.success) {
                console.error("❌ Git Pull Failed:", gitRes.error);
                await sock.sendMessage(sender, { 
                    text: `❌ *[Step 1/3] Git Pull Failed!*\n\n*Terminal Output:*\n\`\`\`\n${gitOutput}\n\`\`\`\n\n*Error details:* ${gitRes.error}` 
                });
                return;
            }

            await sock.sendMessage(sender, { 
                text: `📥 *[Step 1/3] Git Pull Output:*\n\`\`\`\n${gitOutput}\n\`\`\`\n\n🔄 *[Step 2/3] Running \`npm install\`...*` 
            });

            // 2. Run npm install
            const npmRes = await runShellCommand('npm install --no-audit --no-fund', repoDir);
            const npmOutput = (npmRes.stdout || npmRes.stderr || "Dependencies up to date.").slice(-400);

            if (!npmRes.success) {
                await sock.sendMessage(sender, { 
                    text: `⚠️ *[Step 2/3] npm install warning:*\n\`\`\`\n${npmOutput}\n\`\`\`\nProceeding to restart PM2...` 
                });
            } else {
                await sock.sendMessage(sender, { 
                    text: `📦 *[Step 2/3] Dependencies Output:*\n\`\`\`\n${npmOutput}\n\`\`\`\n\n🔄 *[Step 3/3] Restarting PM2 Services (\`pm2 restart all\`)...*` 
                });
            }

            // 3. Restart PM2 services
            setTimeout(async () => {
                const pm2Res = await runShellCommand('pm2 restart all', repoDir);
                if (!pm2Res.success) {
                    runShellCommand('npx pm2 restart all', repoDir);
                }
            }, 1500);
            return;
        }
	
	// new block for bot 2 starts here

	if (text.startsWith('.bot2 ')) {
            const parts = text.split(' ');
            const subCommand = parts[1];

            const fs = require('fs');
            const path = require('path');
            const outboxDir = path.join(__dirname, 'bot2_outbox');
            if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir);

	    // 🛑 FIXED: Clear Chat Command (e.g., .bot2 clear 9891534527)
            if (subCommand === 'clear') {
                const clearTarget = parts[2];
                if (!/^\d{10}$/.test(clearTarget)) {
                    return sock.sendMessage(sender, { text: "❌ Invalid format. Use: .bot2 clear 9891534527" });
                }
                
                const targetNumber = "91" + clearTarget;
                const taskFile = path.join(outboxDir, `task_${Date.now()}_${Math.floor(Math.random() * 1000)}.json`);
                
                // Set task type to 'clear'
                fs.writeFileSync(taskFile, JSON.stringify({ type: 'clear', number: targetNumber }));

                await sock.sendMessage(sender, { text: `🧹 Queued! Account 2 is clearing the chat for ${targetNumber} from the WhatsApp App ("Delete for me"). Your server logs remain untouched.` });
                return;
            }

	    // 🛑 NEW: Block / Unblock Commands (e.g., .bot2 block 9891534527)
            if (subCommand === 'block' || subCommand === 'unblock') {
                const targetAction = parts[2];
                if (!/^\d{10}$/.test(targetAction)) {
                    return sock.sendMessage(sender, { text: `❌ Invalid format. Use: .bot2 ${subCommand} 9891534527` });
                }
                
                const targetNumber = "91" + targetAction;
                const taskFile = path.join(outboxDir, `task_${Date.now()}_${Math.floor(Math.random() * 1000)}.json`);
                
                // Set task type to 'block' or 'unblock'
                fs.writeFileSync(taskFile, JSON.stringify({ type: subCommand, number: targetNumber }));

                const statusIcon = subCommand === 'block' ? "🚫" : "✅";
                await sock.sendMessage(sender, { text: `${statusIcon} Queued! Account 2 is executing a network request to ${subCommand} ${targetNumber}.` });
                return;
            }

            // 🛑 EXISTING: Send Message Command (e.g., .bot2 9891532527 Hello)
            if (/^\d{10}$/.test(subCommand)) {
                const targetNumber = "91" + subCommand;
                const messageToSend = parts.slice(2).join(' ');

                if (!messageToSend) {
                    return sock.sendMessage(sender, { text: "❌ Please provide a message to send." });
                }

                const taskFile = path.join(outboxDir, `task_${Date.now()}_${Math.floor(Math.random() * 1000)}.json`);
                
                // Set task type to 'send'
                fs.writeFileSync(taskFile, JSON.stringify({ type: 'send', number: targetNumber, text: messageToSend }));

                await sock.sendMessage(sender, { text: `✅ Queued! Account 2 is securely transmitting your message to ${targetNumber}.` });
                return;
            }

            // 🛑 EXISTING: Logs Command (e.g., .bot2 logs 3006)
            if (subCommand === 'logs') {
                let inputDate = parts[2]; 
                let targetDate = "";

                const formatter = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });
                const nowIST = new Date();
                const dParts = formatter.formatToParts(nowIST);
                
                const currentDay = dParts.find(p => p.type === 'day').value;
                const currentMonth = dParts.find(p => p.type === 'month').value;
                const currentYear = parseInt(dParts.find(p => p.type === 'year').value, 10);

                if (inputDate && inputDate.length === 4) {
                    const day = inputDate.slice(0, 2);
                    const month = inputDate.slice(2, 4);
                    
                    let targetYear = currentYear;
                    if (parseInt(month, 10) > parseInt(currentMonth, 10) || (month === currentMonth && parseInt(day, 10) > parseInt(currentDay, 10))) {
                        targetYear = currentYear - 1; 
                    }
                    targetDate = `${day}-${month}-${targetYear}`;
                } else {
                    targetDate = `${currentDay}-${currentMonth}-${currentYear}`;
                }

                const logFile = path.join(__dirname, 'bot2_logs', `${targetDate}.json`);

                if (!fs.existsSync(logFile)) {
                    return sock.sendMessage(sender, { text: `📭 No activity recorded for Account 2 on ${targetDate}.` });
                }

                try {
                    const logs = JSON.parse(fs.readFileSync(logFile));
                    if (logs.length === 0) return sock.sendMessage(sender, { text: `📭 Logs for ${targetDate} are empty.` });

                    const groupedLogs = {};
                    const nameDirectory = {}; 

                    logs.forEach(log => {
                        const number = log.contact;
                        if (!groupedLogs[number]) groupedLogs[number] = [];
                        groupedLogs[number].push(log);
                        
                        if (log.contactName && log.contactName !== "Unknown Contact") {
                            nameDirectory[number] = log.contactName;
                        }
                    });

                    await sock.sendMessage(sender, { text: `📅 *Account 2 Logs | ${targetDate}*\n_Sending individual chat logs..._` });

                    for (const [number, msgs] of Object.entries(groupedLogs)) {
                        const displayName = nameDirectory[number] || "Unknown Contact";
                        let replyText = `*👤 ${displayName} (${number})*\n\n`;
                        
                        msgs.sort((a, b) => a.timestamp - b.timestamp);
                        
                        msgs.forEach(m => {
                            const directionTag = m.direction === "Sent" ? "📤 [Sent]" : "📥 [Received]";
                            replyText += `${directionTag} [${m.time}] : ${m.message}\n`;
                        });

                        await sock.sendMessage(sender, { text: replyText.trim() });
                        await delay(1000); 
                    }
                } catch (e) {
                    await sock.sendMessage(sender, { text: "❌ Error reading Bot2 logs." });
                }
                return;
            }
        }

	// new block for bot 2 ends here	

	// 🟢 NEW BLOCK FOR BOT 3 STARTS HERE 🟢
       if (text.startsWith('.bot3 ')) {
           const parts = text.split(' ');
           const subCommand = parts[1];

           const fs = require('fs');
           const path = require('path');
           const outboxDir = path.join(__dirname, 'bot3_outbox');
           if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir);

           // 🛑 Clear Chat Command (e.g., .bot3 clear 9891534527)
           if (subCommand === 'clear') {
               const clearTarget = parts[2];
               if (!/^\d{10}$/.test(clearTarget)) {
                   return sock.sendMessage(sender, { text: "❌ Invalid format. Use: .bot3 clear 9891534527" });
               }
               const targetNumber = "91" + clearTarget;
               const taskFile = path.join(outboxDir, `task_${Date.now()}_${Math.floor(Math.random() * 1000)}.json`);
               fs.writeFileSync(taskFile, JSON.stringify({ type: 'clear', number: targetNumber }));
               await sock.sendMessage(sender, { text: `🧹 Queued! Account 3 is clearing the chat for ${targetNumber}.` });
               return;
           }

           // 🛑 Block / Unblock Commands (e.g., .bot3 block 9891534527)
           if (subCommand === 'block' || subCommand === 'unblock') {
               const targetAction = parts[2];
               if (!/^\d{10}$/.test(targetAction)) {
                   return sock.sendMessage(sender, { text: `❌ Invalid format. Use: .bot3 ${subCommand} 9891534527` });
               }
               const targetNumber = "91" + targetAction;
               const taskFile = path.join(outboxDir, `task_${Date.now()}_${Math.floor(Math.random() * 1000)}.json`);
               fs.writeFileSync(taskFile, JSON.stringify({ type: subCommand, number: targetNumber }));
               const statusIcon = subCommand === 'block' ? "🚫" : "✅";
               await sock.sendMessage(sender, { text: `${statusIcon} Queued! Account 3 is executing a network request to ${subCommand} ${targetNumber}.` });
               return;
           }

           // 🛑 Send Message Command (e.g., .bot3 9891532527 Hello)
           if (/^\d{10}$/.test(subCommand)) {
               const targetNumber = "91" + subCommand;
               const messageToSend = parts.slice(2).join(' ');
               if (!messageToSend) {
                   return sock.sendMessage(sender, { text: "❌ Please provide a message to send." });
               }
               const taskFile = path.join(outboxDir, `task_${Date.now()}_${Math.floor(Math.random() * 1000)}.json`);
               fs.writeFileSync(taskFile, JSON.stringify({ type: 'send', number: targetNumber, text: messageToSend }));
               await sock.sendMessage(sender, { text: `✅ Queued! Account 3 is securely transmitting your message to ${targetNumber}.` });
               return;
           }

           // 🛑 Logs Command (e.g., .bot3 logs 3006)
           if (subCommand === 'logs') {
               let inputDate = parts[2]; 
               let targetDate = "";

               const formatter = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });
               const nowIST = new Date();
               const dParts = formatter.formatToParts(nowIST);
               
               const currentDay = dParts.find(p => p.type === 'day').value;
               const currentMonth = dParts.find(p => p.type === 'month').value;
               const currentYear = parseInt(dParts.find(p => p.type === 'year').value, 10);

               if (inputDate && inputDate.length === 4) {
                   const day = inputDate.slice(0, 2);
                   const month = inputDate.slice(2, 4);
                   let targetYear = currentYear;
                   if (parseInt(month, 10) > parseInt(currentMonth, 10) || (month === currentMonth && parseInt(day, 10) > parseInt(currentDay, 10))) {
                       targetYear = currentYear - 1; 
                   }
                   targetDate = `${day}-${month}-${targetYear}`;
               } else {
                   targetDate = `${currentDay}-${currentMonth}-${currentYear}`;
               }

               const logFile = path.join(__dirname, 'bot3_logs', `${targetDate}.json`);

               if (!fs.existsSync(logFile)) {
                   return sock.sendMessage(sender, { text: `📭 No activity recorded for Account 3 on ${targetDate}.` });
               }

               try {
                   const logs = JSON.parse(fs.readFileSync(logFile));
                   if (logs.length === 0) return sock.sendMessage(sender, { text: `📭 Logs for Account 3 on ${targetDate} are empty.` });

                   const groupedLogs = {};
                   const nameDirectory = {}; 

                   logs.forEach(log => {
                       const number = log.contact;
                       if (!groupedLogs[number]) groupedLogs[number] = [];
                       groupedLogs[number].push(log);
                       if (log.contactName && log.contactName !== "Unknown Contact") {
                           nameDirectory[number] = log.contactName;
                       }
                   });

                   await sock.sendMessage(sender, { text: `📅 *Account 3 Logs | ${targetDate}*\n_Sending individual chat logs..._` });

                   for (const [number, msgs] of Object.entries(groupedLogs)) {
                       const displayName = nameDirectory[number] || "Unknown Contact";
                       let replyText = `*👤 ${displayName} (${number})*\n\n`;
                       msgs.sort((a, b) => a.timestamp - b.timestamp);
                       msgs.forEach(m => {
                           const directionTag = m.direction === "Sent" ? "📤 [Sent]" : "📥 [Received]";
                           replyText += `${directionTag} [${m.time}] : ${m.message}\n`;
                       });
                       await sock.sendMessage(sender, { text: replyText.trim() });
                       await delay(1000); 
                   }
               } catch (e) {
                   await sock.sendMessage(sender, { text: "❌ Error reading Bot 3 logs." });
               }
               return;
           }
       }
       // 🟢 NEW BLOCK FOR BOT 3 ENDS HERE 🟢

       if (text.startsWith('.bot4 ')) {
           const parts = text.split(' ');
           const subCommand = parts[1];

           const fs = require('fs');
           const path = require('path');
           const outboxDir = path.join(__dirname, 'bot4_outbox');
           if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir);

           // 🛑 Clear Chat Command (e.g., .bot4 clear 9891534527)
           if (subCommand === 'clear') {
               const clearTarget = parts[2];
               if (!/^\d{10}$/.test(clearTarget)) {
                   return sock.sendMessage(sender, { text: "❌ Invalid format. Use: .bot4 clear 9891534527" });
               }
               const targetNumber = "91" + clearTarget;
               const taskFile = path.join(outboxDir, `task_${Date.now()}_${Math.floor(Math.random() * 1000)}.json`);
               fs.writeFileSync(taskFile, JSON.stringify({ type: 'clear', number: targetNumber }));
               await sock.sendMessage(sender, { text: `🧹 Queued! Account 4 is clearing the chat for ${targetNumber}.` });
               return;
           }

           // 🛑 Block / Unblock Commands (e.g., .bot4 block 9891534527)
           if (subCommand === 'block' || subCommand === 'unblock') {
               const targetAction = parts[2];
               if (!/^\d{10}$/.test(targetAction)) {
                   return sock.sendMessage(sender, { text: `❌ Invalid format. Use: .bot4 ${subCommand} 9891534527` });
               }
               const targetNumber = "91" + targetAction;
               const taskFile = path.join(outboxDir, `task_${Date.now()}_${Math.floor(Math.random() * 1000)}.json`);
               fs.writeFileSync(taskFile, JSON.stringify({ type: subCommand, number: targetNumber }));
               const statusIcon = subCommand === 'block' ? "🚫" : "✅";
               await sock.sendMessage(sender, { text: `${statusIcon} Queued! Account 4 is executing a network request to ${subCommand} ${targetNumber}.` });
               return;
           }

           // 🛑 Send Message Command (e.g., .bot4 9891532527 Hello)
           if (/^\d{10}$/.test(subCommand)) {
               const targetNumber = "91" + subCommand;
               const messageToSend = parts.slice(2).join(' ');
               if (!messageToSend) {
                   return sock.sendMessage(sender, { text: "❌ Please provide a message to send." });
               }
               const taskFile = path.join(outboxDir, `task_${Date.now()}_${Math.floor(Math.random() * 1000)}.json`);
               fs.writeFileSync(taskFile, JSON.stringify({ type: 'send', number: targetNumber, text: messageToSend }));
               await sock.sendMessage(sender, { text: `✅ Queued! Account 4 is securely transmitting your message to ${targetNumber}.` });
               return;
           }

           // 🛑 Logs Command (e.g., .bot4 logs 3006)
           if (subCommand === 'logs') {
               let inputDate = parts[2]; 
               let targetDate = "";

               const formatter = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });
               const nowIST = new Date();
               const dParts = formatter.formatToParts(nowIST);
               
               const currentDay = dParts.find(p => p.type === 'day').value;
               const currentMonth = dParts.find(p => p.type === 'month').value;
               const currentYear = parseInt(dParts.find(p => p.type === 'year').value, 10);

               if (inputDate && inputDate.length === 4) {
                   const day = inputDate.slice(0, 2);
                   const month = inputDate.slice(2, 4);
                   let targetYear = currentYear;
                   if (parseInt(month, 10) > parseInt(currentMonth, 10) || (month === currentMonth && parseInt(day, 10) > parseInt(currentDay, 10))) {
                       targetYear = currentYear - 1; 
                   }
                   targetDate = `${day}-${month}-${targetYear}`;
               } else {
                   targetDate = `${currentDay}-${currentMonth}-${currentYear}`;
               }

               const logFile = path.join(__dirname, 'bot4_logs', `${targetDate}.json`);

               if (!fs.existsSync(logFile)) {
                   return sock.sendMessage(sender, { text: `📭 No activity recorded for Account 4 on ${targetDate}.` });
               }

               try {
                   const logs = JSON.parse(fs.readFileSync(logFile));
                   if (logs.length === 0) return sock.sendMessage(sender, { text: `📭 Logs for Account 4 on ${targetDate} are empty.` });

                   const groupedLogs = {};
                   const nameDirectory = {}; 

                   logs.forEach(log => {
                       const number = log.contact;
                       if (!groupedLogs[number]) groupedLogs[number] = [];
                       groupedLogs[number].push(log);
                       if (log.contactName && log.contactName !== "Unknown Contact") {
                           nameDirectory[number] = log.contactName;
                       }
                   });

                   await sock.sendMessage(sender, { text: `📅 *Account 4 Logs | ${targetDate}*\n_Sending individual chat logs..._` });

                   for (const [number, msgs] of Object.entries(groupedLogs)) {
                       const displayName = nameDirectory[number] || "Unknown Contact";
                       let replyText = `*👤 ${displayName} (${number})*\n\n`;
                       msgs.sort((a, b) => a.timestamp - b.timestamp);
                       msgs.forEach(m => {
                           const directionTag = m.direction === "Sent" ? "📤 [Sent]" : "📥 [Received]";
                           replyText += `${directionTag} [${m.time}] : ${m.message}\n`;
                       });
                       await sock.sendMessage(sender, { text: replyText.trim() });
                       await delay(1000); 
                   }
               } catch (e) {
                   await sock.sendMessage(sender, { text: "❌ Error reading Bot 4 logs." });
               }
               return;
           }

           // 📶 Online Presence Logs (.bot4 ologs OR .bot4 ologs 1008)
           if (subCommand === 'ologs') {
               let inputDate4 = parts[2];
               let targetDate4 = '';
               const fmtO = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });
               const nowO = new Date();
               const dpO = fmtO.formatToParts(nowO);
               const cdO = dpO.find(p => p.type === 'day').value;
               const cmO = dpO.find(p => p.type === 'month').value;
               const cyO = parseInt(dpO.find(p => p.type === 'year').value, 10);
               if (inputDate4 && inputDate4.length === 4) {
                   const dd = inputDate4.slice(0, 2);
                   const mm = inputDate4.slice(2, 4);
                   let yr = cyO;
                   if (parseInt(mm, 10) > parseInt(cmO, 10) || (mm === cmO && parseInt(dd, 10) > parseInt(cdO, 10))) yr = cyO - 1;
                   targetDate4 = dd + '-' + mm + '-' + yr;
               } else {
                   targetDate4 = cdO + '-' + cmO + '-' + cyO;
               }
               const ologFile = path.join(__dirname, 'bot4_ologs', targetDate4 + '.json');
               if (!fs.existsSync(ologFile)) {
                   return sock.sendMessage(sender, { text: '⚠️ No online activity recorded for +917054406788 on ' + targetDate4 + '.' });
               }
               try {
                   const spans = JSON.parse(fs.readFileSync(ologFile));
                   if (!spans || spans.length === 0) return sock.sendMessage(sender, { text: '⚠️ Online logs for +917054406788 on ' + targetDate4 + ' are empty.' });
                   const totalMs = spans.reduce((sum, s) => sum + (s.toMs - s.fromMs), 0);
                   const totalMin = Math.floor(totalMs / 60000);
                   const totalSec = Math.round((totalMs % 60000) / 1000);
                   const totalStr = totalMin > 0 ? (totalMin + 'm ' + totalSec + 's') : (totalSec + 's');
                   let replyText = '📊 *Online Log — +917054406788*\n📅 *Date: ' + targetDate4 + '*\n🕐 *Total Online: ' + totalStr + '*\n' + '─'.repeat(28) + '\n\n';
                   spans.forEach((s, i) => { replyText += (i+1) + '. 🟢 ' + s.from + '  →  🔴 ' + s.to + '\n    ⏱ Duration: ' + s.duration + '\n'; });
                   await sock.sendMessage(sender, { text: replyText.trim() });
               } catch (e) {
                   await sock.sendMessage(sender, { text: '❌ Error reading online logs.' });
               }
               return;
           }

       }
       // 🟢 NEW BLOCK FOR BOT 3 ENDS HERE 🟢

        if (text === '.busy on' || text === '.sleep') {
            db.isBusy = true;
            await sock.sendMessage(sender, { text: "💤 Busy Mode ON." });
            return;
        }

        if (text === '.wake') {
            db.isBusy = false;
            await sock.sendMessage(sender, { text: "☀️ Busy Mode OFF." });
            if (db.busyBuffer.size > 0) {
                let allChats = "";
                db.busyBuffer.forEach((msgs, person) => { allChats += `\n--- ${person} ---\n${msgs.join("\n")}\n`; });
                await sock.sendMessage(sender, { text: "📝 Generating Summary..." });
                try {
                    const res = await groq.chat.completions.create({
                        messages: [{ role: "user", content: `Summarize who messaged Pranjal and why:\n${allChats}` }],
                        model: "llama-3.3-70b-versatile"
                    });
                    await sock.sendMessage(sender, { text: "📋 *Summary:*\n" + res.choices[0]?.message?.content });
                } catch(e) {}
                db.busyBuffer.clear();
            } else { await sock.sendMessage(sender, { text: "📭 No messages missed." }); }
            return;
        }

        if (text.startsWith('.setrole ')) {
            const parts = text.split(' ');
            const isReply = !!msg.message.extendedTextMessage?.contextInfo?.participant;
            const mentionedJid = isReply ? msg.message.extendedTextMessage.contextInfo.participant : (parts[1] ? parts[1].replace('@', '') + '@s.whatsapp.net' : null);
            const role = isReply ? parts.slice(1).join(' ').toLowerCase() : parts.slice(2).join(' ').toLowerCase();

            if (!mentionedJid || !role) return sock.sendMessage(sender, { text: "❌ Usage error." });
            db.contactRoles[mentionedJid] = role;
            db.saveContacts();
            await sock.sendMessage(sender, { text: `✅ Role Set: ${role}` });
            return;
        }

        if (db.isBusy && !fromMe && !text.startsWith('.')) {
            if (sender.endsWith('@g.us')) {
                const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                const myJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : '';
                if (!mentions.includes(myJid)) return;
            }
            const role = db.contactRoles[sender] || 'default';
            let systemPrompt = `You are Pranjal's AI. Context: ${role}. Be polite.`;
            if (role.includes('girlfriend') || role.includes('rashi')) systemPrompt = `You are Pranjal's loving boyfriend (AI). Reply to Rashi affectionately.`;
            else if (role.includes('bestie')) systemPrompt = `You are Pranjal (AI). Roast your best friend.`;

            await sock.sendPresenceUpdate('composing', sender);
            try {
                const recentContext = logs.slice(-5).join("\n");
                const res = await groq.chat.completions.create({
                    messages: [
                        { role: "system", content: systemPrompt + `\nContext:\n${recentContext}` },
                        { role: "user", content: text }
                    ],
                    model: "llama-3.3-70b-versatile"
                });
                const reply = res.choices[0]?.message?.content || "Busy right now.";

                await delay(2000);
                await sock.sendMessage(sender, { text: reply });

                let bLog = db.busyBuffer.get(pushName) || [];
                bLog.push(`User: ${text}`); bLog.push(`Bot: ${reply}`);
                db.busyBuffer.set(pushName, bLog);
            } catch(e) {}
            await sock.sendPresenceUpdate('paused', sender);
            return;
        }

        if (text.startsWith('.remember ')) {
            db.permanentMemory.push(text.slice(10));
            db.saveMemory();
            await sock.sendMessage(sender, { text: "🧠 Memory Saved!" });
            return;
        }

        if (text === '.memories') {
            if (db.permanentMemory.length === 0) return sock.sendMessage(sender, { text: "🧠 No memories." });
            await sock.sendMessage(sender, { text: "🧠 *Memories:*\n\n" + db.permanentMemory.map((m, i) => `*${i + 1}.* ${m}`).join("\n") });
            return;
        }

        if (text.startsWith('.forget ')) {
            const num = parseInt(text.split(' ')[1]);
            if (!isNaN(num) && num > 0 && num <= db.permanentMemory.length) {
                const removed = db.permanentMemory.splice(num - 1, 1);
                db.saveMemory();
                await sock.sendMessage(sender, { text: `🗑️ Deleted: "${removed}"` });
            }
            return;
        }

        if (text === '.forgetall') {
            db.permanentMemory = [];
            db.saveMemory();
            await sock.sendMessage(sender, { text: "💥 All erased." });
            return;
        }

        if (text.startsWith('.summarize')) {
            const chatLog = db.groupLogs.get(sender) || [];
            if(chatLog.length === 0) return sock.sendMessage(sender, { text: "❌ No logs." });
            await sock.sendMessage(sender, { text: "📝 Summarizing..." });
            try {
                const res = await groq.chat.completions.create({
                    messages: [{ role: "user", content: "Summarize:\n" + chatLog.join("\n") }],
                    model: "llama-3.3-70b-versatile"
                });
                await sock.sendMessage(sender, { text: res.choices[0]?.message?.content });
            } catch(e) {}
            return;
        }

        if (text === '!ping') return sock.sendMessage(sender, { text: "pong 🏓" });

        if (text.startsWith('.save')) {
            const url = text.split(/\s+/)[1];
            if (!url) return sock.sendMessage(sender, { text: "❌ Invalid URL" });
            await sock.sendMessage(sender, { text: "⬇️ Downloading..." });
            const outPath = path.join(__dirname, `vid_${Date.now()}.mp4`);
            try {
                const cookiesPath = path.join(__dirname, 'cookies.txt');
                const execOpts = { output: outPath, format: 'best[ext=mp4]', noPlaylist: true };
                if (fs.existsSync(cookiesPath)) {
                    execOpts.cookies = cookiesPath;
                }
                await exec(url, execOpts);
                if (!fs.existsSync(outPath)) throw new Error("File missing");
                await sock.sendMessage(sender, { text: "☁️ Uploading..." });
                const link = await uploadToDrive(outPath, outPath.split('/').pop());
                await sock.sendMessage(sender, { text: link ? `✅ Done!\n${link}` : "❌ Upload Fail" });
            } catch (e) { await sock.sendMessage(sender, { text: "❌ " + e.message });
            } finally { if (fs.existsSync(outPath)) try { fs.unlinkSync(outPath); } catch (err) {} }
            return;
        }

        if (text.startsWith('.ai ')) {
            await sock.sendPresenceUpdate('composing', sender);
            try {
                let history = db.chatHistory.get(sender) || [];
                const mem = db.permanentMemory.length > 0 ? "MEMORIES:\n" + db.permanentMemory.join("\n") : "";
                const ctx = logs.length > 0 ? "RECENT CHAT:\n" + logs.join("\n") : "";
                const systemPrompt = `You are Pranjal's assistant. Rashi is his girlfriend.\n${mem}\n\n${ctx}`;

                const messages = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: `${senderLabel} says: ${text.slice(4)}` }];

                const res = await groq.chat.completions.create({
                    messages: messages,
                    model: "llama-3.3-70b-versatile"
                });
                const response = res.choices[0]?.message?.content || "Error generating response.";

                history.push({ role: "user", content: `${senderLabel} says: ${text.slice(4)}` });
                history.push({ role: "assistant", content: response });
                db.chatHistory.set(sender, history);

                await sock.sendMessage(sender, { text: response });
            } catch(e) { await sock.sendMessage(sender, { text: "❌ " + e.message }); }
            await sock.sendPresenceUpdate('paused', sender);
        }

        if (text.startsWith('.solve ') || text.startsWith('.solve3 ')) {
             await sock.sendMessage(sender, { text: "⏳ This service is not currently available. Please try again later." });
             return;
        }

        if (text === '.clear') { db.chatHistory.delete(sender); db.groupLogs.delete(sender); await sock.sendMessage(sender, { text: "🧹 Cleared" }); }
    }
};
