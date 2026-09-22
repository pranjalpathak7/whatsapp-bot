require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const db = require('./database');
const dashboardHTML = require('./dashboard_ui');
const Groq = require('groq-sdk');
const axios = require('axios');
const cdcScraper = require('./cdc_scraper');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY }); 
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "rashi";
const PORT = process.env.PORT || 3000;

let scheduledTasks = [];

module.exports = {
    start: function(getSock) {
        const app = express();
        app.use(bodyParser.json());
        app.use(bodyParser.urlencoded({ extended: true }));

        function refreshSchedule() {
            // Safely stop all existing cron jobs before clearing the array
            scheduledTasks.forEach(task => {
                if (task && typeof task.stop === 'function') task.stop();
            });
            scheduledTasks = [];

            db.scheduleData.forEach((item, index) => {
                let cronExp = `${item.minute} ${item.hour} * * *`;
                if (item.type === 'weekly') cronExp = `${item.minute} ${item.hour} * * ${item.dayOfWeek}`;
                if (item.type === 'once') cronExp = `${item.minute} ${item.hour} ${item.dateDay} ${item.dateMonth} *`;

                try {
                    const task = cron.schedule(cronExp, async () => {
                        const isEnabled = typeof db.isSchedulerEnabled === 'function' 
                            ? db.isSchedulerEnabled() 
                            : (db.schedulerSettings?.enabled !== false);

                        if (isEnabled) {
                            const sock = getSock();
                            if (sock) {
                                let aiResponse = "";
                                if (item.aiPrompt && item.order && item.order.includes('ai')) {
                                    try {
                                        const res = await groq.chat.completions.create({
                                            messages: [{ role: "user", content: item.aiPrompt }],
                                            model: "qwen/qwen3.8-27b",
                                            temperature: 1.5 // 🛑 Added back to force true randomness!
                                        });
                                        aiResponse = res.choices[0]?.message?.content || "(AI Error)";
                                    } catch(e) { aiResponse = "(AI Error)"; }
                                }

                                const staticTxt = item.staticMsg || "";
                                let finalMessage = "";
                                
                                // 🛑 NEWLINE FIX: Pure concatenation. No forced spaces or \n.
                                if (item.order === 'text_ai') finalMessage = staticTxt + aiResponse;
                                else if (item.order === 'ai_text') finalMessage = aiResponse + staticTxt;
                                else if (item.order === 'text_only') finalMessage = staticTxt;
                                else if (item.order === 'ai_only') finalMessage = aiResponse;

                                if (finalMessage.trim()) {
                                    try {
                                        // 🟢 ONLINE FLASH: Briefly flag as 'available' to update Last Seen
                                        await sock.sendPresenceUpdate('available');
                                        
                                        // Send the scheduled message
                                        await sock.sendMessage(`${item.phone}@s.whatsapp.net`, { text: finalMessage });

                                        // 🔴 GHOST CLOAK: Set a 30-second timer to go back offline
                                        setTimeout(() => {
                                            try {
                                                sock.sendPresenceUpdate('unavailable');
                                            } catch (err) {}
                                        }, 30000);
                                        
                                    } catch (sendErr) {
                                        console.error("Error during scheduled send:", sendErr.message);
                                    }
                                }
                            }
                        } else {
                            console.log(`⏸️ [SCHEDULER PAUSED] Skipped sending message to ${item.phone} because Scheduler Toggle is OFF.`);
                        }

                        // Always auto-delete one-time message after its scheduled instance arrives,
                        // regardless of whether toggle was ON or OFF
                        if (item.type === 'once') {
                            db.scheduleData.splice(index, 1);
                            db.saveSchedule();
                            refreshSchedule();
                        }
                    }, { timezone: "Asia/Kolkata" });
                    
                    scheduledTasks.push(task);
                } catch (cronError) {
                    console.error(`Skipping broken schedule #${index}:`, cronError.message);
                }
            });
        }

        refreshSchedule();

        app.get('/', (req, res) => res.send(dashboardHTML));
        app.get('/api/list', (req, res) => res.json(db.scheduleData));
        app.get('/api/scheduler-status', (req, res) => {
            const enabled = typeof db.isSchedulerEnabled === 'function' ? db.isSchedulerEnabled() : true;
            res.json({ enabled });
        });
        
        app.post('/api/scheduler-toggle', (req, res) => {
            try {
                if (req.body.password !== DASHBOARD_PASSWORD) return res.json({ error: "Wrong Password" });
                const enabled = !!req.body.enabled;
                if (typeof db.setSchedulerEnabled === 'function') {
                    db.setSchedulerEnabled(enabled);
                }
                console.log(`🔀 [SCHEDULER TOGGLE] Status updated to: ${enabled ? 'ACTIVE (ON)' : 'PAUSED (OFF)'}`);
                res.json({ success: true, enabled });
            } catch (err) {
                res.json({ error: "Server error during toggle: " + err.message });
            }
        });

        app.post('/api/schedule', (req, res) => {
            try {
                if(req.body.password !== DASHBOARD_PASSWORD) return res.json({ error: "Wrong Password" });
                db.scheduleData.push(req.body);
                db.saveSchedule();
                refreshSchedule();
                res.json({ success: true });
            } catch (err) {
                res.json({ error: "Server error during scheduling: " + err.message });
            }
        });
        
        app.post('/api/delete', (req, res) => {
            try {
                if(req.body.password !== DASHBOARD_PASSWORD) return res.json({ error: "Wrong Password" });
                
                // Strictly force the index to be a number so splice doesn't crash the server
                const targetIndex = parseInt(req.body.index, 10);
                if (isNaN(targetIndex) || targetIndex < 0 || targetIndex >= db.scheduleData.length) {
                    return res.json({ error: "Invalid task index." });
                }

                db.scheduleData.splice(targetIndex, 1);
                db.saveSchedule();
                refreshSchedule();
                res.json({ success: true });
            } catch (err) {
                console.error("Delete Crash:", err);
                res.json({ error: "Server crashed during deletion: " + err.message });
            }
        });
	
	// 🛑 NEW: Serve the current presence state to the dashboard UI
        app.get('/api/presence', (req, res) => {
            res.json(db.currentPresence);
        });

        // 🛑 NEW: ERP Cookie update endpoint
        app.post('/api/update-cookie', (req, res) => {
            try {
                if (req.body.password !== DASHBOARD_PASSWORD) return res.json({ error: "Wrong Password" });
                db.erpCookie = req.body.cookie || "";
                res.json({ success: true });
            } catch (err) {
                res.json({ error: "Server error: " + err.message });
            }
        });

        // Anti-Timeout Keep-Alive (every 5 minutes)
        cron.schedule('*/5 * * * *', async () => {
            if (!db.erpCookie) return;
            try {
                // USER REQUEST 4: Dynamically update LAST_ACCESS_TIME so the server doesn't think we are idle
                db.erpCookie = db.erpCookie.replace(/LAST_ACCESS_TIME=\d+/, 'LAST_ACCESS_TIME=' + Date.now());
                
                // Helper to swap JSESSIONID for the correct module
                const getCookieForModule = (cookieStr, moduleName) => {
                    let newCookie = cookieStr;
                    const match = newCookie.match(new RegExp(`${moduleName}=([^;]+)`));
                    if (match) {
                        newCookie = newCookie.replace(/JSESSIONID=[^;]+(?:;\s*)?/g, '');
                        newCookie = `JSESSIONID=${match[1]}; ` + newCookie;
                    }
                    return newCookie;
                };

                const baseHeaders = {
                    'X-Requested-With': 'XMLHttpRequest',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'Connection': 'keep-alive'
                };

                const erpHeaders = { ...baseHeaders, 'Cookie': getCookieForModule(db.erpCookie, 'JSID_IIT_ERP3'), 'Referer': 'https://erp.iitkgp.ac.in/IIT_ERP3/showmenu.htm' };
                const res = await axios.get('https://erp.iitkgp.ac.in/IIT_ERP3/keepAlive.htm', { headers: erpHeaders });
                
                const cdcHeaders = { ...baseHeaders, 'Cookie': getCookieForModule(db.erpCookie, 'JSID_TrainingPlacementSSO'), 'Referer': 'https://erp.iitkgp.ac.in/TrainingPlacementSSO/ERPMonitoring.htm' };
                await axios.get('https://erp.iitkgp.ac.in/TrainingPlacementSSO/ERPMonitoring.htm', { headers: cdcHeaders });

                // If it returns a logout page, we log it so we know it died.
                if (res.data && res.data.includes('logoutmsg.htm')) {
                    console.log('???? [KEEP-ALIVE] Session died. ERP returned logout page.');
                } else {
                    console.log('???? [KEEP-ALIVE] Session Extended Successfully for both modules!');
                }
            } catch (error) {} // Log quietly
        });

        // Removed duplicate CDC Scraper cron. Fetching is now exclusively handled by bot.js so it can capture and broadcast newNotices.

        try { app.listen(PORT, () => console.log(`🌐 Dashboard: Port ${PORT}`)); } catch(e){}
    }
};
