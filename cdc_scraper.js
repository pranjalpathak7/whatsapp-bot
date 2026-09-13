const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const db = require('./database');
const { google } = require('googleapis');

const cdcDataDir = path.join(__dirname, 'cdc_data');
if (!fs.existsSync(cdcDataDir)) fs.mkdirSync(cdcDataDir);

const HISTORY_FILE = path.join(__dirname, 'cdc_history.json');
const DRIVE_KEY_FILE = path.join(__dirname, 'drive_key.json');
const DRIVE_FOLDER_ID = '1h6fC0hZtB8zZ2p1_yP5YI4jP7t8P6q7E'; // Example ID

function loadHistory() {
    try {
        return fs.existsSync(HISTORY_FILE) ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) : [];
    } catch (e) {
        return [];
    }
}

function saveHistory(history) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function getDDMM(dateStr) {
    const match = dateStr.match(/(\d{1,2})[-/](\d{1,2})/);
    if (!match) return null;
    let dd = match[1];
    let mm = match[2];
    
    // Some formats have month first, let's assume DD-MM based on user XML: 13-09-2026
    dd = dd.padStart(2, '0');
    mm = mm.padStart(2, '0');
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
            headers: { 
                'Cookie': cookie, 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' 
            }
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
        
        console.log("[CDC] Fetching notices with perfect headers via CURL...");
        
        const util = require('util');
        const exec = util.promisify(require('child_process').exec);
        
        const curlCmd = `curl -s --compressed -H "Cookie: ${db.erpCookie}" -H "Accept: application/xml, text/xml, */*; q=0.01" -H "Accept-Language: en-US,en;q=0.9" -H "Connection: keep-alive" -H "Host: erp.iitkgp.ac.in" -H "Referer: https://erp.iitkgp.ac.in/TrainingPlacementSSO/ERPMonitoring.htm" -H "Sec-Ch-Ua: \\"Not/A)Brand\\";v=\\"8\\", \\"Chromium\\";v=\\"126\\", \\"Google Chrome\\";v=\\"126\\"" -H "Sec-Ch-Ua-Mobile: ?0" -H "Sec-Ch-Ua-Platform: \\"Windows\\"" -H "Sec-Fetch-Dest: empty" -H "Sec-Fetch-Mode: cors" -H "Sec-Fetch-Site: same-origin" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" -H "X-Requested-With: XMLHttpRequest" "${url}"`;

        let data = '';
        try {
            const { stdout } = await exec(curlCmd, { maxBuffer: 1024 * 1024 * 10 });
            data = stdout;
        } catch (e) {
            console.log('[CDC] CURL Error:', e.message);
            return { success: false, error: 'CURL Request Failed' };
        }

        let elements = [];
        
        if (typeof data === 'string' && data.includes('<?xml')) {
            const $ = cheerio.load(data, { xmlMode: true });
            const xmlRows = $('row').toArray();
            console.log(`[CDC] Parsed XML, found ${xmlRows.length} rows.`);

            if (xmlRows.length > 0) {
                for (let el of xmlRows) {
                    const cells = $(el).find('cell');
                    // According to user's XML: cell[1]=Type, cell[2]=Subject, cell[3]=Company, cell[4]=Notice, cell[6]=Date, cell[8]=Attachment
                    if (cells.length >= 8) {
                        elements.push({
                            type: cells.eq(1).text().trim(),
                            subject: cells.eq(2).text().trim(),
                            company: cells.eq(3).text().trim(),
                            noticeHtml: cells.eq(4).text().trim(),
                            date: cells.eq(6).text().trim(),
                            attachHtml: cells.eq(8).text().trim()
                        });
                    }
                }
            } else {
                console.log("[CDC] Found 0 <row> tags. Raw response preview:");
                console.log(data.substring(0, 500));
            }
        }
        
        let history = loadHistory();
        let updatedHistory = [...history];
        let processedNotices = 0;
        let newNotices = [];

        for (let el of elements) {
            const type = el.type;
            const subject = el.subject;
            const company = el.company;
            const updateTime = el.date;
            
            const noticeCheerio = cheerio.load(el.noticeHtml || '');
            let noticeDetails = noticeCheerio('a').attr('title');
            if (!noticeDetails) noticeDetails = (el.noticeHtml || '').replace(/<[^>]*>?/gm, '').trim();

            const attachCheerio = cheerio.load(el.attachHtml || '');
            let downloadLink = attachCheerio('a').attr('href');
            
            if (downloadLink) {
                if (downloadLink.startsWith('/')) {
                    downloadLink = 'https://erp.iitkgp.ac.in' + downloadLink;
                } else if (!downloadLink.startsWith('http')) {
                    downloadLink = 'https://erp.iitkgp.ac.in/TrainingPlacementSSO/' + downloadLink;
                }
            } else {
                downloadLink = 'No Attachment';
            }

            if (company && updateTime) {
                const uniqueStr = company + updateTime;
                const noticeId = Buffer.from(uniqueStr).toString('base64');

                if (!history.includes(noticeId)) {
                    newNotices.push({ type, subject, company, noticeDetails, updateTime, downloadLink, noticeId });
                    updatedHistory.push(noticeId);
                }
            }
        }

        const dateMap = {};

        for (let notice of newNotices) {
            const ddmm = getDDMM(notice.updateTime);
            if (!ddmm) continue;
            
            let link = notice.downloadLink;
            if (!fetchAll && link !== 'No Attachment') {
                link = await downloadAttachment(link, db.erpCookie, notice.noticeId);
            }
            notice.downloadLink = link;

            if (!dateMap[ddmm]) {
                const df = path.join(cdcDataDir, `${ddmm}.json`);
                dateMap[ddmm] = fs.existsSync(df) ? JSON.parse(fs.readFileSync(df)) : [];
            }
            dateMap[ddmm].push(notice);
            processedNotices++;
        }

        for (const [ddmm, notices] of Object.entries(dateMap)) {
            fs.writeFileSync(path.join(cdcDataDir, `${ddmm}.json`), JSON.stringify(notices, null, 2));
        }

        saveHistory(updatedHistory);
        return { success: true, processed: processedNotices };

    } catch (error) {
        console.error("CDC Scraper Error:", error.message);
        return { success: false, error: error.message };
    }
}

module.exports = { scrapeCDC };
