const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const db = require('./database');
const { google } = require('googleapis');

const cdcDataDir = path.join(__dirname, 'cdc_data');
if (!fs.existsSync(cdcDataDir)) fs.mkdirSync(cdcDataDir);

const HISTORY_FILE = path.join(__dirname, 'cdc_history.json');
const DRIVE_KEY_FILE = path.join(__dirname, 'drive_pass.json');
const DRIVE_FOLDER_ID = '1Ne1ENfG3xhJ0JMolEb-e4_SlhpMJJNxP';

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
        let fileName = 'CDC_Notice_' + noticeId + '.pdf';
        const urlName = url.split('/').pop();
        if (urlName && urlName.includes('.')) fileName = urlName.split('?')[0];

        const scratchDir = path.join(__dirname, 'scratch');
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        const tempPath = path.join(scratchDir, fileName);

        const curlCmd = `curl -sL --compressed -H "Cookie: ${cookie}" -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8" -H "Connection: keep-alive" -H "Referer: https://erp.iitkgp.ac.in/TrainingPlacementSSO/ERPMonitoring.htm" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" -o "${tempPath}" "${url}"`;
        
        const util = require('util');
        const exec = util.promisify(require('child_process').exec);
        await exec(curlCmd, { maxBuffer: 1024 * 1024 * 50 }); // up to 50mb

        if (!fs.existsSync(tempPath) || fs.statSync(tempPath).size === 0) {
            console.log(`[CDC] Download failed or empty file for ${url}`);
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            return url;
        }

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
        let elements = [];
        const util = require('util');
        const exec = util.promisify(require('child_process').exec);

        // FIX: The ERP has different JSESSIONIDs for different paths.
        // We must extract JSID_TrainingPlacementSSO and force it to be the JSESSIONID.
        let cdcCookie = db.erpCookie;
        const match = cdcCookie.match(/JSID_TrainingPlacementSSO=([^;]+)/);
        if (match) {
            cdcCookie = cdcCookie.replace(/JSESSIONID=[^;]+(?:;\s*)?/g, '');
            cdcCookie = `JSESSIONID=${match[1]}; ` + cdcCookie;
        }

        // STEP 1: Mimic the POST to getModules.htm to initialize ERP context
        console.log(`[CDC] Executing initialization Step 1 (getModules.htm)...`);
        const step1Cmd = `curl -s --compressed -X POST -H "Cookie: ${cdcCookie}" -H "Accept: application/json, text/javascript, */*; q=0.01" -H "Referer: https://erp.iitkgp.ac.in/IIT_ERP3/showmenu.htm" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" -H "X-Requested-With: XMLHttpRequest" "https://erp.iitkgp.ac.in/IIT_ERP3/getModules.htm" -d ""`;
        try { await exec(step1Cmd, { maxBuffer: 1024 * 1024 * 10 }); } catch (e) { console.log(`[CDC] Step 1 failed:`, e.message); }

        // STEP 2: Mimic the GET to ERPMonitoring.htm (base HTML) to initialize CDC Section context
        console.log(`[CDC] Executing initialization Step 2 (Base ERPMonitoring.htm)...`);
        const step2Cmd = `curl -s --compressed -H "Cookie: ${cdcCookie}" -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7" -H "Referer: https://erp.iitkgp.ac.in/IIT_ERP3/showmenu.htm" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" -H "Upgrade-Insecure-Requests: 1" "https://erp.iitkgp.ac.in/TrainingPlacementSSO/ERPMonitoring.htm"`;
        try { await exec(step2Cmd, { maxBuffer: 1024 * 1024 * 10 }); } catch (e) { console.log(`[CDC] Step 2 failed:`, e.message); }

        // STEP 3: Mimic the GET to jqqueryid=37
        console.log(`[CDC] Executing initialization Step 3 (jqqueryid=37)...`);
        const step3Cmd = `curl -s --compressed -H "Cookie: ${cdcCookie}" -H "Accept: application/xml, text/xml, */*; q=0.01" -H "Referer: https://erp.iitkgp.ac.in/TrainingPlacementSSO/ERPMonitoring.htm" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" -H "X-Requested-With: XMLHttpRequest" "https://erp.iitkgp.ac.in/TrainingPlacementSSO/ERPMonitoring.htm?action=fetchData&jqqueryid=37&_search=false&nd=${Date.now()}&rows=20&page=1&sidx=&sord=asc&totalrows=50"`;
        try { await exec(step3Cmd, { maxBuffer: 1024 * 1024 * 10 }); } catch (e) { console.log(`[CDC] Step 3 failed:`, e.message); }

        // FIX: The ERP server's jqGrid completely ignores pagination parameters via GET URL.
        // We MUST use POST with `application/x-www-form-urlencoded` body to successfully fetch page 2, 3, etc.
        const maxPages = fetchAll ? 100 : 3; 

        for (let page = 1; page <= maxPages; page++) {
            console.log(`[CDC] Fetching page ${page} (jqqueryid=54) with perfect POST headers via CURL...`);
            
            const url = `https://erp.iitkgp.ac.in/TrainingPlacementSSO/ERPMonitoring.htm`;
            const postBody = `action=fetchData&jqqueryid=54&_search=false&rows=20&page=${page}&sidx=&sord=asc&nd=${Date.now()}`;
            
            const curlCmd = `curl -s --compressed -X POST -H "Cookie: ${cdcCookie}" -H "Accept: application/xml, text/xml, */*; q=0.01" -H "Accept-Language: en-US,en;q=0.9" -H "Connection: keep-alive" -H "Content-Type: application/x-www-form-urlencoded" -H "Host: erp.iitkgp.ac.in" -H "Referer: https://erp.iitkgp.ac.in/IIT_ERP3/showmenu.htm" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" -H "X-Requested-With: XMLHttpRequest" -d "${postBody}" "${url}"`;

            let data = '';
            try {
                const { stdout } = await exec(curlCmd, { maxBuffer: 1024 * 1024 * 10 });
                data = stdout;
                console.log(`[CDC-DEBUG] CURL POST STDOUT on page ${page}:\n`, data.substring(0, 1500));
            } catch (e) {
                console.log(`[CDC] CURL Error on page ${page}:`, e.message);
                break;
            }

            let xmlRows = [];
            let $xml = null;
            if (typeof data === 'string' && data.includes('<?xml')) {
                $xml = cheerio.load(data, { xmlMode: true });
                xmlRows = $xml('row').toArray();
            } else {
                console.log(`[CDC-DEBUG] XML not found in GET response. Data was:`, data.substring(0, 500));
            }



            if (xmlRows.length > 0 && $xml) {
                for (let el of xmlRows) {
                    const cellsArr = $xml(el).find('cell').toArray();
                    if (cellsArr.length >= 8) {
                        const typeStr = $xml(cellsArr[1]).text().trim();
                        // USER REQUEST 1: Skip INTERNSHIP notices. 
                        // We check for INTERNSHIP specifically because ERP might use "JOB" instead of "PLACEMENT"
                        if (typeStr.toUpperCase() === 'INTERNSHIP') continue;

                        elements.push({
                            type: typeStr,
                            subject: $xml(cellsArr[2]).text().trim(),
                            company: $xml(cellsArr[3]).text().trim(),
                            noticeHtml: $xml(cellsArr[4]).text().trim(),
                            date: $xml(cellsArr[6]).text().trim(),
                            attachHtml: $xml(cellsArr[8]).text().trim()
                        });
                    }
                }
            } else {
                console.log(`[CDC] Found 0 <row> tags on page ${page} even after POST. Stopping pagination.`);
                break;
            }
        }
        
        let history = loadHistory();
        let updatedHistory = [...history];
        let processedNotices = 0;
        let newNotices = [];

        for (let i = 0; i < elements.length; i++) {
            if (i % 50 === 0) await new Promise(r => setImmediate(r)); // Yield to event loop to keep WhatsApp connection alive
            
            const el = elements[i];
            const type = el.type;
            const subject = el.subject;
            const company = el.company;
            const updateTime = el.date;
            
            // FIX: Just strip all HTML tags to get the pure text. This avoids all single quote regex issues entirely!
            let noticeDetails = (el.noticeHtml || '').replace(/<[^>]*>?/gm, '').trim();
            noticeDetails = noticeDetails.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

            let downloadLink = '';
            const hrefMatch = (el.attachHtml || '').match(/href=['"]([^'"]*)['"]/i);
            if (hrefMatch) downloadLink = hrefMatch[1].replace(/&amp;/g, '&'); // FIX: Unescape HTML entities so ERP accepts the URL!
            if (downloadLink === 'javascript:void(0);') downloadLink = '';
            
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
            // USER REQUEST 2: Download attachment for ALL notices
            if (link !== 'No Attachment') {
                console.log(`[CDC] Uploading attachment to Drive for notice ${notice.noticeId}...`);
                link = await downloadAttachment(link, cdcCookie, notice.noticeId);
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
