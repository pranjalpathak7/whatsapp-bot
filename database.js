const fs = require('fs');
const path = require('path');

const files = {
    schedule: path.join(__dirname, 'schedule.json'),
    memory: path.join(__dirname, 'memory.json'),
    contacts: path.join(__dirname, 'contacts.json'),
    settings: path.join(__dirname, 'settings.json')
};

function loadJSON(file, fallback) {
    try {
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
    } catch (e) {
        return fallback;
    }
}

module.exports = {
    chatHistory: new Map(),
    groupLogs: new Map(),
    busyBuffer: new Map(),
    isBusy: false,
	
    currentPresence: { status: "offline", lastSeen: null },    
    scheduleData: loadJSON(files.schedule, []),
    permanentMemory: loadJSON(files.memory, []),
    contactRoles: loadJSON(files.contacts, {}),
    schedulerSettings: loadJSON(files.settings, { enabled: true }),

    saveSchedule: function() { fs.writeFileSync(files.schedule, JSON.stringify(this.scheduleData)); },
    saveMemory: function() { fs.writeFileSync(files.memory, JSON.stringify(this.permanentMemory)); },
    saveContacts: function() { fs.writeFileSync(files.contacts, JSON.stringify(this.contactRoles)); },
    saveSettings: function() { fs.writeFileSync(files.settings, JSON.stringify(this.schedulerSettings)); },

    isSchedulerEnabled: function() {
        return this.schedulerSettings && this.schedulerSettings.enabled !== false;
    },
    setSchedulerEnabled: function(enabled) {
        if (!this.schedulerSettings) this.schedulerSettings = {};
        this.schedulerSettings.enabled = !!enabled;
        this.saveSettings();
    }
};
