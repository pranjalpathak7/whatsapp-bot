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
    erpCookie: "JSESSIONID=DED5F6677BA9928BB88DECCA22E71E43.node3; ssoToken=1606FA7C07054A10BDC52D2A18F57887.node8B0AFE4F42EC366CFC9E0F345C819745B.node7CT4OJQHQMDF52ZKOQAC3HHS9MQ4F9P2L3D16BWL6VUUKQVX6JRGV4K9N6GPI8SFY; JSID_IIT_ERP3=B0AFE4F42EC366CFC9E0F345C819745B.node7; JSID_Academic=AA8B62FB856C075E5458F2B1B455235A.node2; JSID_TrainingPlacementSSO=DED5F6677BA9928BB88DECCA22E71E43.node3; LAST_ACCESS_TIME=1790587080877",
	
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
