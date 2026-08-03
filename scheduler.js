require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const db = require('./database');
const dashboardHTML = require('./dashboard_ui');
const Groq = require('groq-sdk');

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
                        const sock = getSock();
                        if (!sock) return;

                        let aiResponse = "";
                        if (item.aiPrompt && item.order.includes('ai')) {
                            try {
                                const res = await groq.chat.completions.create({
                                    messages: [{ role: "user", content: item.aiPrompt }],
                                    model: "llama-3.3-70b-versatile",
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

        try { app.listen(PORT, () => console.log(`🌐 Dashboard: Port ${PORT}`)); } catch(e){}
    }
};
