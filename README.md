# 🤖 WhatsApp Multi-Account Bot & Automation Suite

An advanced, multi-account WhatsApp automation suite built with [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys), Groq LLM intelligence (Llama 3.3 70B), an Express-powered scheduling dashboard, Google Drive media archiving, and asynchronous inter-bot command pipelines.

---

## 🌟 Key Features

### 1. 🧠 Primary Bot (`bot.js`)
- **AI-Powered Conversations**: Integrates with Groq (`llama-3.3-70b-versatile`) for context-aware, personality-driven, and memory-backed responses.
- **Dynamic Role Management**: Assign specific roles (e.g. `bestie`, `girlfriend`) to customize AI personality and reply tone per contact.
- **Persistent Long-Term Memory**: Save (`.remember`), review (`.memories`), and erase (`.forget`) permanent memories stored in JSON.
- **Smart Busy / Sleep Mode**: Automatic AI auto-replies when busy, buffering missed messages and generating an executive summary upon waking (`.wake`).
- **Media Downloader & Cloud Backup**: Download videos from supported social platforms (`yt-dlp`) and automatically upload them to Google Drive (`.save <url>`).
- **Ghost Heartbeat & Stealth Presence**: Manages WhatsApp presence state and heartbeat to prevent desktop always-on flags.
- **System Vitals**: Real-time diagnostic monitoring for RAM, disk usage, uptime, and automatic zombie process cleanup (`.vitals`).

### 2. 🌐 Web Scheduler Dashboard (`scheduler.js`)
- Express web interface on port `3000` protected by password access.
- Create and manage scheduled messages (Daily, Weekly, or One-Time).
- Combine static messages with dynamic, real-time AI generated prompts.
- Visual presence tracking and real-time schedule list management.

### 3. 👥 Multi-Account Interception & Outbox (`bot2.js` & `bot3.js`)
- **Independent Auth Sessions**: Isolated multi-file auth states (`auth_baileys_2`, `auth_baileys_3`) for secondary WhatsApp accounts.
- **Activity & Call Logging**: Intercepts voice/video calls, text messages, and media (images, video, voice notes, documents), uploading media to Google Drive and generating organized daily JSON logs.
- **Outbox Command Queue**: Control secondary accounts directly from the primary bot via text commands (`.bot2 send`, `.bot2 clear`, `.bot2 block`, `.bot2 logs`, `.bot3 ...`).
- **Auto Log Retention**: 365-day log retention with automated background cleanup.

---

## 📁 Architecture Overview

```
├── bot.js               # Primary Bot entrypoint (WhatsApp connection, scheduler bridge)
├── bot2.js              # Secondary Account logger & outbox executor
├── bot3.js              # Tertiary Account logger & outbox executor
├── message_handler.js   # Main command parsing and business logic
├── scheduler.js         # Express web server & node-cron task runner
├── dashboard_ui.js      # Responsive HTML/Tailwind dashboard UI
├── database.js          # In-memory and JSON storage layer
├── system_vitals.js     # Health diagnostics and temporary file cleanup
├── package.json         # Project dependencies and startup scripts
├── .env.example         # Template environment configuration
└── .gitignore           # Secure exclusion of auth, keys, and personal data
```

---

## 🚀 Getting Started

### Prerequisites
- **Node.js** (v18.x or later recommended)
- **yt-dlp** installed and accessible in your system PATH (for media downloads)
- **FFmpeg** (recommended for media processing)

### Installation

1. Clone the repository:
   ```bash
   git clone <your-repository-url>
   cd whatsapp-bot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure Environment Variables:
   Copy the example configuration file to `.env`:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your preferred settings:
   ```env
   GROQ_API_KEY=your_groq_api_key_here
   DRIVE_FOLDER_ID=your_google_drive_folder_id_here
   DRIVE_CREDENTIALS_FILE=drive_pass.json
   DASHBOARD_PASSWORD=your_dashboard_password_here
   PORT=3000
   TARGET_PHONE=919876543210
   ```

4. *(Optional)* Setup Google Drive Backup:
   Place your Google Service Account or OAuth credentials in `drive_pass.json` in the root directory.

---

## 🚦 Running the Bots

### Start Primary Bot (with Web Dashboard)
```bash
npm start
```
*On first launch, scan the QR code displayed in the terminal using WhatsApp (Linked Devices).*

### Start Secondary Loggers
```bash
npm run bot2   # Starts Account 2 Logger
npm run bot3   # Starts Account 3 Logger
npm run bot4   # Starts Account 4 Logger
```

### Accessing the Web Dashboard
Open your browser and navigate to:
```
http://localhost:3000
```
Enter your configured `DASHBOARD_PASSWORD` to create and manage schedules.

- **Master Scheduler Toggle**: Located at the top of the dashboard. When turned **OFF (Paused)**, all scheduled messages are suppressed and skipped at their trigger time. One-time tasks will disappear as scheduled, while recurring (daily/weekly) tasks remain for future runs when reactivated.

---

## 💬 Bot Command Reference

| Command | Description |
| :--- | :--- |
| `!ping` | Health check response (`pong 🏓`) |
| `.vitals` | Check server RAM, disk space, and uptime |
| `.pull` | Pull latest GitHub code, install npm dependencies & restart PM2 |
| `.ai <prompt>` | Query the Groq AI with long-term memory context |
| `.save <url>` | Download video via yt-dlp and upload to Google Drive |
| `.busy on` / `.sleep` | Enable busy mode (AI handles incoming chats) |
| `.wake` | Disable busy mode and send a summary of missed chats |
| `.setrole <role>` | Set contact role/personality context |
| `.remember <text>` | Save a permanent memory entry |
| `.memories` | List all saved memories |
| `.forget <index>` | Delete a specific memory item |
| `.forgetall` | Clear all saved memories |
| `.summarize` | Summarize recent group or direct chat history |
| `.bot2 <number> <msg>` | Send message via Account 2 |
| `.bot2 logs <DDMM>` | Fetch activity logs for Account 2 for a specific date |
| `.bot2 clear <number>` | Clear chat on Account 2 |
| `.bot2 block <number>` | Block a contact on Account 2 |
| `.bot3 ...` | Execute equivalent commands on Account 3 |
| `.bot4 ...` | Execute equivalent commands on Account 4 |

---

## 🔒 Security & Privacy

- All sensitive keys, passwords, and private session credentials are kept out of version control via `.gitignore`.
- Authentication states (`auth_baileys*`) and session files are generated locally and never committed.
- Ensure your `.env` and `drive_pass.json` files are kept confidential.

---

## 📄 License
This project is for personal and authorized educational use.
