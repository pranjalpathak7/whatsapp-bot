module.exports = `
<!DOCTYPE html>
<html>
<head>
    <title>Bot Controller v3.2</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { font-family: 'Segoe UI', sans-serif; background: #eef2f6; }
        .tab-btn.active { border-bottom: 2px solid #6366f1; color: #6366f1; font-weight: bold; }
    </style>
</head>
<body class="pb-10">
    <div class="max-w-2xl mx-auto bg-white min-h-screen shadow-2xl sm:my-8 sm:rounded-xl sm:min-h-0 overflow-hidden">
        
        <div class="bg-indigo-600 p-6 text-white">
            <h1 class="text-2xl font-bold">🤖 Bot Controller v3.2</h1>
            <p class="text-indigo-200 text-sm">Advanced Scheduler & AI Manager</p>
<!--	    <div id="presence-badge" class="mt-3 text-sm font-bold bg-indigo-800 inline-flex items-center px-3 py-1 rounded-full text-indigo-100 transition-colors duration-300">
               👤 Rashi's Status: <span id="presence-status" class="ml-1">Fetching...</span>
           </div>   -->
        </div>

        <div class="p-6 space-y-6">
            <div>
                <label class="block text-xs font-bold text-gray-500 uppercase">Access Key</label>
                <input type="password" id="password" class="w-full p-2 border-b-2 border-indigo-100 focus:border-indigo-600 outline-none transition" placeholder="Enter Password">
            </div>

            <div>
                <label class="block text-xs font-bold text-gray-500 uppercase mb-2">Recipient (10-Digit Number)</label>
                <div class="flex">
                    <span class="inline-flex items-center px-3 rounded-l-md border border-r-0 border-gray-300 bg-gray-50 text-gray-500 text-sm">+91</span>
                    <input type="text" id="phone" class="flex-1 p-2 border border-gray-300 rounded-r-md outline-none focus:ring-1 focus:ring-indigo-500" placeholder="Defaults to Rashi if left blank">
                </div>
            </div>

            <div class="bg-gray-50 p-4 rounded-lg border border-gray-200">
                <label class="block text-xs font-bold text-gray-500 uppercase mb-3">Frequency</label>
                <div class="flex gap-4 border-b border-gray-300 mb-4">
                    <button onclick="setTab('daily')" id="tab-daily" class="tab-btn active pb-2 px-2 text-sm text-gray-600">Daily</button>
                    <button onclick="setTab('weekly')" id="tab-weekly" class="tab-btn pb-2 px-2 text-sm text-gray-600">Weekly</button>
                    <button onclick="setTab('once')" id="tab-once" class="tab-btn pb-2 px-2 text-sm text-gray-600">One-Time (Date)</button>
                </div>

                <div class="flex gap-4 items-center mb-4">
                    <div class="w-1/2">
                        <label class="text-xs text-gray-500">Hour (0-23)</label>
                        <input type="number" id="hour" min="0" max="23" class="w-full p-2 border rounded" placeholder="HH">
                    </div>
                    <div class="w-1/2">
                        <label class="text-xs text-gray-500">Minute (0-59)</label>
                        <input type="number" id="minute" min="0" max="59" class="w-full p-2 border rounded" placeholder="MM">
                    </div>
                </div>

                <div id="extra-inputs"></div>
            </div>

            <div class="space-y-4">
                <label class="block text-xs font-bold text-gray-500 uppercase">Message Content</label>
                
                <div>
                    <label class="text-xs text-gray-400">Fixed Message (Optional)</label>
                    <textarea id="staticMsg" class="w-full p-2 border rounded h-24" placeholder="Type here. No automatic spaces/newlines will be added."></textarea>
                </div>

                <div class="bg-purple-50 p-3 rounded border border-purple-100">
                    <label class="text-xs font-bold text-purple-600 flex items-center gap-1">
                        ✨ AI Generator (Runs at scheduled time)
                    </label>
                    <textarea id="aiPrompt" class="w-full mt-2 p-2 border rounded text-sm h-20" placeholder="Prompt for AI: e.g. 'Write a romantic quote about rain'"></textarea>
                </div>

                <div>
                    <label class="text-xs text-gray-400">Combine Format</label>
                    <select id="msgOrder" class="w-full p-2 border rounded bg-white">
                        <option value="text_ai">Fixed Message FIRST, then AI Response</option>
                        <option value="ai_text">AI Response FIRST, then Fixed Message</option>
                        <option value="text_only">Fixed Message Only (Ignore AI)</option>
                        <option value="ai_only">AI Response Only (Ignore Fixed)</option>
                    </select>
                </div>
            </div>

            <button id="submitBtn" onclick="scheduleTask()" class="w-full bg-indigo-600 text-white font-bold py-3 rounded-lg shadow hover:bg-indigo-700 transition">
                Create Schedule
            </button>
            <div id="status" class="text-center text-sm font-bold"></div>
        </div>

        <div class="bg-gray-50 border-t border-gray-200 p-6">
            <h2 class="text-sm font-bold text-gray-500 uppercase mb-4">Active Schedules</h2>
            <ul id="scheduleList" class="space-y-3"></ul>
        </div>
    </div>

    <script>
        let currentTab = 'daily';
        document.getElementById('password').value = localStorage.getItem('bot_pass') || '';

        function setTab(tab) {
            currentTab = tab;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.getElementById('tab-' + tab).classList.add('active');
            
            const extra = document.getElementById('extra-inputs');
            extra.innerHTML = '';

            if (tab === 'weekly') {
                extra.innerHTML = \`
                    <label class="text-xs text-gray-500">Day of Week</label>
                    <select id="dayOfWeek" class="w-full p-2 border rounded bg-white">
                        <option value="0">Sunday</option><option value="1">Monday</option>
                        <option value="2">Tuesday</option><option value="3">Wednesday</option>
                        <option value="4">Thursday</option><option value="5">Friday</option>
                        <option value="6">Saturday</option>
                    </select>\`;
            } else if (tab === 'once') {
                extra.innerHTML = \`
                    <div class="flex gap-2">
                        <div class="w-1/2"><label class="text-xs text-gray-500">Date (1-31)</label><input type="number" id="dateDay" class="w-full p-2 border rounded"></div>
                        <div class="w-1/2"><label class="text-xs text-gray-500">Month (1-12)</label><input type="number" id="dateMonth" class="w-full p-2 border rounded"></div>
                    </div>
                    <p class="text-xs text-orange-500 mt-1">⚠️ Will run once and then auto-delete.</p>\`;
            }
        }

        async function scheduleTask() {
            const btn = document.getElementById('submitBtn');
            const pwd = document.getElementById('password').value;
            localStorage.setItem('bot_pass', pwd);
            
            let rawPhone = document.getElementById('phone').value.replace(/[^0-9]/g, '');
            let finalPhone = rawPhone ? "91" + rawPhone.slice(-10) : "917054406788";
            
            const hour = parseInt(document.getElementById('hour').value, 10);
            const minute = parseInt(document.getElementById('minute').value, 10);
            
            if(!pwd || isNaN(hour) || isNaN(minute)) return alert("Missing Fields!");
            if(hour < 0 || hour > 23 || minute < 0 || minute > 59) return alert("Invalid Time! Hours must be 0-23, Minutes 0-59.");

            btn.disabled = true;
            btn.innerText = "Scheduling...";
            btn.classList.add('opacity-50', 'cursor-not-allowed');

            const payload = {
                password: pwd,
                phone: finalPhone,
                hour: hour,
                minute: minute,
                type: currentTab,
                staticMsg: document.getElementById('staticMsg').value,
                aiPrompt: document.getElementById('aiPrompt').value,
                order: document.getElementById('msgOrder').value
            };

            if (currentTab === 'weekly') payload.dayOfWeek = document.getElementById('dayOfWeek').value;
            if (currentTab === 'once') {
                payload.dateDay = document.getElementById('dateDay').value;
                payload.dateMonth = document.getElementById('dateMonth').value;
            }

            try {
                const res = await fetch('/api/schedule', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(payload)
                });
                
                const data = await res.json();
                if(data.success) {
                    document.getElementById('status').innerText = "✅ Scheduled!";
                    document.getElementById('status').className = "text-center text-sm font-bold text-green-600 mt-2";
                    fetchSchedule();
                } else {
                    alert("❌ " + data.error);
                }
            } catch (err) {
                alert("❌ Critical Network Error");
            }

            btn.disabled = false;
            btn.innerText = "Create Schedule";
            btn.classList.remove('opacity-50', 'cursor-not-allowed');
        }

        async function fetchSchedule() {
            // 🛑 CACHE BUSTER ADDED: Forces the browser to get fresh data every single time
            const res = await fetch('/api/list?_t=' + Date.now(), { cache: 'no-store' });
            const data = await res.json();
            const list = document.getElementById('scheduleList');
            list.innerHTML = "";
            
            data.forEach((item, index) => {
                let badge = item.type === 'daily' ? 'bg-blue-100 text-blue-800' : (item.type === 'weekly' ? 'bg-purple-100 text-purple-800' : 'bg-orange-100 text-orange-800');
                let time = \`\${String(item.hour).padStart(2,'0')}:\${String(item.minute).padStart(2,'0')}\`;
                
                // 🛑 NEW CODE: Calculate exact day or date string to show in the UI
                let extraInfo = "";
                if (item.type === 'weekly') {
                    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                    extraInfo = \`<span class="text-xs font-bold text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded border border-purple-100">\${days[item.dayOfWeek]}</span>\`;
                } else if (item.type === 'once') {
                    extraInfo = \`<span class="text-xs font-bold text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded border border-orange-100">\${item.dateDay}/\${item.dateMonth}</span>\`;
                }

                const li = document.createElement('li');
                li.className = "bg-white p-3 rounded shadow-sm border border-gray-100 flex justify-between items-center";
                li.innerHTML = \`
                    <div>
                        <div class="flex items-center gap-2 mb-1">
                            <span class="text-xs font-bold px-2 py-0.5 rounded uppercase \${badge}">\${item.type}</span>
                            \${extraInfo}
                            <span class="font-bold text-gray-700">\${time}</span>
                            <span class="text-xs text-gray-400 ml-1">To: \${item.phone}</span>
                        </div>
                        <div class="text-xs text-gray-500 truncate w-64">
                            \${item.aiPrompt ? '🤖 AI: ' + item.aiPrompt : '📝 ' + item.staticMsg}
                        </div>
                    </div>
                    <button onclick="deleteTask(\${index}, event)" class="text-red-500 hover:text-red-700 font-bold px-4 py-2 text-lg">×</button>
                \`;
                list.appendChild(li);
            });
        }

        async function deleteTask(index, event) {
            const btn = event.currentTarget;
            const pwd = document.getElementById('password').value;
            
            if (!pwd) {
                alert("🔒 Please enter the Access Key at the top to delete schedules!");
                return;
            }
            
            // Visual loading state so you know it actually clicked
            const originalText = btn.innerHTML;
            btn.innerHTML = "⏳";
            btn.disabled = true;
            
            try {
                const res = await fetch('/api/delete', { 
                    method: 'POST', 
                    headers: {'Content-Type': 'application/json'}, 
                    body: JSON.stringify({ password: pwd, index: index }) 
                });
                
                const data = await res.json();
                if(data.success) {
                    fetchSchedule(); // Reload list
                } else {
                    alert("❌ " + data.error);
                    btn.innerHTML = originalText;
                    btn.disabled = false;
                }
            } catch (err) {
                alert("❌ Critical Error: The server crashed during deletion. Please check pm2 logs.");
                btn.innerHTML = originalText;
                btn.disabled = false;
            }
        }
	
	// 🛑 NEW: Polling engine to update the presence badge
       async function fetchPresence() {
           try {
               const res = await fetch('/api/presence?_t=' + Date.now(), { cache: 'no-store' });
               const data = await res.json();
               
               const badge = document.getElementById('presence-badge');
               const statusText = document.getElementById('presence-status');
               
               let displayTxt = data.status === 'composing' ? 'Typing...' : (data.status === 'available' ? 'Online' : 'Offline');
               
               // Fixed: Using standard quotes and concatenation to prevent breaking module.exports
               if (data.status !== 'available' && data.status !== 'composing' && data.lastSeen) {
                   const date = new Date(data.lastSeen * 1000);
                   const timeStr = date.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute:'2-digit' });
                   displayTxt = 'Last seen at ' + timeStr;
               }
               
               statusText.innerText = displayTxt;
               
               if(data.status === 'available' || data.status === 'composing') {
                   badge.className = "mt-3 text-sm font-bold bg-green-500 inline-flex items-center px-3 py-1 rounded-full text-white transition-colors duration-300 shadow-md";
               } else {
                   badge.className = "mt-3 text-sm font-bold bg-indigo-800 inline-flex items-center px-3 py-1 rounded-full text-indigo-100 transition-colors duration-300";
               }
           } catch(e) {}
       }
       
       fetchPresence();
       setInterval(fetchPresence, 60000); // Polls exactly once per minute

        fetchSchedule();
    </script>
</body>
</html>
`
