const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

module.exports = {
    getHealthStats: function(botDir) {
        // Measure RAM
        const totalRam = Math.round(os.totalmem() / 1024 / 1024);
        const freeRam = Math.round(os.freemem() / 1024 / 1024);
        const usedRam = totalRam - freeRam;

        // Measure Disk Space
        let diskInfo = "Unknown";
        try {
            const disk = execSync('df -h /').toString().trim().split('\n')[1].replace(/\s+/g, ' ').split(' ');
            diskInfo = `Total: ${disk[1]} | Used: ${disk[2]} (${disk[4]}) | Free: ${disk[3]}`;
        } catch (e) { diskInfo = "Error reading disk"; }

        // Zombie Video Cleanup (Deletes stranded .mp4s older than 1 hour)
        let zombiesKilled = 0;
        try {
            const files = fs.readdirSync(botDir);
            files.forEach(file => {
                if (file.startsWith('vid_') && file.endsWith('.mp4')) {
                    const filePath = path.join(botDir, file);
                    const stats = fs.statSync(filePath);
                    const ageInMs = Date.now() - stats.mtimeMs;
                    if (ageInMs > 3600000) { // 1 hour
                        fs.unlinkSync(filePath);
                        zombiesKilled++;
                    }
                }
            });
        } catch (e) { console.error("Zombie cleanup failed:", e); }

        return `📊 *System Vitals*\n\n` +
               `🧠 *RAM*: ${usedRam} MB / ${totalRam} MB (Free: ${freeRam} MB)\n` +
               `💾 *Disk*: ${diskInfo}\n` +
               `⏱️ *Uptime*: ${(os.uptime() / 3600).toFixed(1)} Hours\n` +
               `🧹 *Zombies Cleared*: ${zombiesKilled} orphaned files`;
    }
};
