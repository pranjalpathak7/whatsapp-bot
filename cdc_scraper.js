const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const { google } = require('googleapis');

const cdcDataDir = path.join(__dirname, 'cdc_data');
const historyFile = path.join(__dirname, 'cdc_history.json');

const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || "1Ne1ENfG3xhJ0JMolEb-e4_SlhpMJJNxP";
const DRIVE_KEY_FILE = process.env.DRIVE_CREDENTIALS_FILE ? path.resolve(__dirname, process.env.DRIVE_CREDENTIALS_FILE) : path.join(__dirname, 'drive_pass.json');

if (!fs.existsSync(cdcDataDir)) fs.mkdirSync(cdcDataDir, { recursive: true });

function loadHistory() {
    try { return fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : []; } 
    catch (e) { return []; }
}

function saveHistory(history) {
    if (history.length > 3000) history = history.slice(history.length - 3000);
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
}

function getDDMM(dateStr) {
    if (!dateStr) return null;
    const match = dateStr.match(/(\d{1,2})[-/ ]?([a-zA-Z]{3}|\d{1,2})/);
    if (!match) return null;
    let dd = match[1].padStart(2, '0');
    let mm = match[2];
    if (isNaN(mm)) {
        const months = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
        mm = months[mm.toLowerCase()] || '01';
    } else {
        mm = mm.padStart(2, '0');
    }
    return dd + mm;
}

async function uploadCDCToDrive(filePath, fileName) {
    try {
        if (!fs.existsSync(DRIVE_KEY_FILE)) return null;
        const auth = new google.auth.GoogleAuth({ keyFile: DRIVE_KEY_FILE, scopes: ['https://www.googleapis.com/auth/drive.file'] });
        const drive = google.drive({ version: 'v3', auth });
        const mimeType = fileName.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
        
        const file = await drive.files.create({ 
            resource: { name: fileName, parents: [DRIVE_FOLDER_ID] }, 
            media: { mimeType, body: fs.createReadStream(filePath) }, 
            fields: 'id, webViewLink' 
        });
        await drive.permissions.create({ fileId: file.data.id, requestBody: { role: 'reader', type: 'anyone' } });
        return file.data.webViewLink;
    } catch (e) {
        console.error("CDC Drive Upload Error:", e.message);
        return null;
    }
}

async function downloadAttachment(url, cookie, noticeId) {
    if (url === 'No Attachment' || !url.startsWith('http')) return url;
    try {
        const response = await axios({
            url, method: 'GET', responseType: 'stream',
            headers: { 'Cookie': cookie, 'User-Agent': 'Mozilla/5.0' }
        });
        
        let fileName = 'CDC_Notice_' + noticeId + '.pdf';
        const disposition = response.headers['content-disposition'];
        if (disposition && disposition.includes('filename=')) {
            fileName = disposition.split('filename=')[1].replace(/["']/g, '');
        } else {
            const urlName = url.split('/').pop();
            if (urlName && urlName.includes('.')) fileName = urlName.split('?')[0];
        }

        const scratchDir = path.join(__dirname, 'scratch');
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        
        const tempPath = path.join(scratchDir, fileName);
        const writer = fs.createWriteStream(tempPath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        const driveLink = await uploadCDCToDrive(tempPath, fileName);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

        return driveLink || url; 
    } catch (e) {
        console.error("CDC Download Error:", e.message);
        return url; 
    }
}

async function scrapeCDC(fetchAll = false) {
    if (!db.erpCookie) {
        console.log("[CDC Scraper] Blocked: No active ERP cookie in database.");
        return { success: false, error: "No ERP Cookie" };
    }

    try {
        const rows = fetchAll ? 2000 : 50; 
        const url = `https://erp.iitkgp.ac.in/TrainingPlacementSSO/ERPMonitoring.htm?action=fetchData&jqqueryid=54&_search=false&rows=${rows}&page=1&sidx=&sord=asc&totalrows=${rows}&nd=${Date.now()}`;
        
        const response = await axios.get(url, {
            headers: { 'Cookie': db.erpCookie, 'X-Requested-With': 'XMLHttpRequest', 'Accept': '*/*' }
        });

        const html = response.data;
        const $ = cheerio.load(html);
        
        let history = loadHistory();
        let updatedHistory = [...history];
        let processedNotices = 0;

        const elements = $('tr').toArray();

        for (let el of elements) {
            const type = $(el).find('td[aria-describedby="grid54_type"]').text().trim();
            const subject = $(el).find('td[aria-describedby="grid54_category"]').text().trim();
            const company = $(el).find('td[aria-describedby="grid54_company"]').text().trim();
            
            const noticeLink = $(el).find('td[aria-describedby="grid54_notice"] a');
            const noticeDetails = noticeLink.attr('title') ? noticeLink.attr('title').trim() : '';
            
            const updateTime = $(el).find('td[aria-describedby="grid54_noticeat"]').text().trim();
            let downloadLink = $(el).find('td[aria-describedby="grid54_view1"] a').attr('href');
            
            if (downloadLink) {
                if (downloadLink.startsWith('/')) downloadLink = 'https://erp.iitkgp.ac.in' + downloadLink;
            } else { downloadLink = 'No Attachment'; }

            if (company && updateTime) {
                const uniqueStr = company + updateTime;
                const noticeId = Buffer.from(uniqueStr).toString('base64');
                const safeId = noticeId.substring(0, 8).replace(/[\/\+\=]/g, '0');
                const ddmm = getDDMM(updateTime);

                if (!ddmm) continue; 

                if (!history.includes(noticeId)) {
                    let finalAttachmentLink = downloadLink;
                    
                    // Only perform expensive Drive upload for new cron notices, not for bulk historical fetch 
                    // (prevents RAM/Rate limit crash for 2000 files)
                    if (!fetchAll) {
                        finalAttachmentLink = await downloadAttachment(downloadLink, db.erpCookie, safeId);
                    }

                    const noticeObj = { type, subject, company, noticeDetails, updateTime, downloadLink: finalAttachmentLink };
                    
                    const dateFile = path.join(cdcDataDir, `${ddmm}.json`);
                    let dateData = [];
                    if (fs.existsSync(dateFile)) {
                        try { dateData = JSON.parse(fs.readFileSync(dateFile, 'utf8')); } catch(e){}
                    }
                    
                    // Add to top of array for newest first
                    dateData.unshift(noticeObj);
                    fs.writeFileSync(dateFile, JSON.stringify(dateData, null, 2));

                    updatedHistory.push(noticeId);
                    processedNotices++;
                }
            }
        }

        if (processedNotices > 0) saveHistory(updatedHistory);
        console.log(`[CDC Scraper] Processed ${processedNotices} new notices.`);
        return { success: true, processed: processedNotices };

    } catch (error) {
        console.error("CDC Scraper Error:", error.message);
        return { success: false, error: error.message };
    }
}

module.exports = { scrapeCDC };
