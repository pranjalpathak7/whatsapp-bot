const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const db = require('./database');
const { google } = require('googleapis');

const cdcDataDir = path.join(__dirname, 'cdc_data');
if (!fs.existsSync(cdcDataDir)) fs.mkdirSync(cdcDataDir);

// FIX: HISTORY_FILE must be inside cdc_data so the '.bot4 cdc reset' command actually clears it!
const HISTORY_FILE = path.join(cdcDataDir, 'cdc_history.json');
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
        if (urlName && urlName.includes('.')) {
            let extracted = urlName.split('?')[0];
            // If the endpoint is a JSP servlet, use our unique noticeId and default to PDF
            if (extracted.toLowerCase().endsWith('.jsp')) {
                extracted = 'CDC_Notice_' + noticeId + '.pdf';
            }
            fileName = extracted;
        }

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

    // USER REQUEST 4: Update the LAST_ACCESS_TIME in the cookie before sending requests so we don't timeout
    db.erpCookie = db.erpCookie.replace(/LAST_ACCESS_TIME=\d+/, 'LAST_ACCESS_TIME=' + Date.now());

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

        // FIX: The ERP server requires GET. POST returns empty.
        // We fetch a large number of rows (9999) to get all notices in one request.
        console.log(`[CDC] Fetching ALL notices in a single request (rows=9999) without pagination loop...`);
        // FIX: The URL MUST contain the exact parameters that jqGrid expects, otherwise the server throws and returns 59 bytes.
        const url = `https://erp.iitkgp.ac.in/TrainingPlacementSSO/ERPMonitoring.htm?action=fetchData&jqqueryid=54&_search=false&nd=${Date.now()}&rows=9999&page=1&sidx=&sord=asc&totalrows=9999`;
        
        // Use EXACTLY the browser's GET request format
        const curlCmd = `curl -s --compressed -H "Cookie: ${cdcCookie}" -H "Accept: application/xml, text/xml, */*; q=0.01" -H "Accept-Language: en-US,en;q=0.9" -H "Connection: keep-alive" -H "Host: erp.iitkgp.ac.in" -H "Referer: https://erp.iitkgp.ac.in/TrainingPlacementSSO/ERPMonitoring.htm" -H "Sec-Ch-Ua: \\"Not/A)Brand\\";v=\\"8\\", \\"Chromium\\";v=\\"126\\", \\"Google Chrome\\";v=\\"126\\"" -H "Sec-Ch-Ua-Mobile: ?0" -H "Sec-Ch-Ua-Platform: \\"Windows\\"" -H "Sec-Fetch-Dest: empty" -H "Sec-Fetch-Mode: cors" -H "Sec-Fetch-Site: same-origin" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" -H "X-Requested-With: XMLHttpRequest" "${url}"`;

        let data = '';
        try {
            // Give it 50MB maxBuffer because 10,000 notices is huge!
            const { stdout } = await exec(curlCmd, { maxBuffer: 1024 * 1024 * 50 });
            data = stdout;
            console.log(`[CDC-DEBUG] CURL STDOUT length: ${data.length} bytes.\nPreview:\n`, data.substring(0, 500));
        } catch (e) {
            console.log(`[CDC] CURL Error:`, e.message);
            return { success: false, error: e.message };
        }

        let xmlRows = [];
        let $xml = null;
        if (typeof data === 'string' && data.includes('<?xml')) {
            $xml = cheerio.load(data, { xmlMode: true });
            xmlRows = $xml('row').toArray();
            console.log(`[CDC] Parsed XML, found ${xmlRows.length} rows.`);
        } else {
            console.log(`[CDC-DEBUG] XML not found in response. Data was:`, data.substring(0, 500));
            return { success: false, error: "Invalid XML response" };
        }

        if (xmlRows.length > 0 && $xml) {
            for (let el of xmlRows) {
                const cellsArr = $xml(el).find('cell').toArray();
                if (cellsArr.length >= 6) {
                    const typeStr = $xml(cellsArr[1]).text().trim();
                    // USER REQUEST 1: Skip INTERNSHIP notices.
                    if (typeStr.toUpperCase() === 'INTERNSHIP') {
                        continue;
                    }

                    // Dynamically find the date cell (it could be at index 5 or 6 depending on if there's a Roll Number column)
                    let dateStr = '';
                    for (let c = 4; c < cellsArr.length; c++) {
                        const txt = $xml(cellsArr[c]).text().trim();
                        if (/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.test(txt)) {
                            dateStr = txt;
                            break;
                        }
                    }

                    // Dynamically find the attachment cell by strictly looking for TPFile.jsp or a direct .pdf link
                    let attachHtml = '';
                    let downloadLink = '';
                    for (let c = 5; c < cellsArr.length; c++) {
                        const html = $xml(cellsArr[c]).text().trim();
                        if (html.includes("title='Download'") || html.includes('title="Download"') || html.includes(">Download<")) {
                            const tpMatch = html.match(/TPNotice\(['"]([^'"]*)['"]\s*,\s*['"]([^'"]*)['"]\)/);
                            if (tpMatch) {
                                const year = tpMatch[1];
                                const id = tpMatch[2];
                                downloadLink = `https://erp.iitkgp.ac.in/TrainingPlacementSSO/AdmFilePDF.htm?type=NOTICE&year=${year}&id=${id}`;
                                attachHtml = html;
                                break;
                            }
                        }
                    }

                    console.log(`[CDC-DEBUG] FOUND PLACEMENT: "${$xml(cellsArr[2]).text().trim()}" | Date: ${dateStr} | Attach: ${attachHtml ? 'YES' : 'NO'}`);

                    elements.push({
                        type: typeStr,
                        subject: $xml(cellsArr[2]).text().trim(),
                        company: $xml(cellsArr[3]).text().trim(),
                        noticeHtml: $xml(cellsArr[4]).text().trim(),
                        date: dateStr,
                        attachHtml: attachHtml,
                        downloadLink: downloadLink
                    });
                }
            }
        }
        
        let history = loadHistory();
        let updatedHistory = [...history];
        let processedNotices = 0;
        let newNotices = [];

        let skippedHistory = 0;
        let skippedEmpty = 0;

        for (let i = 0; i < elements.length; i++) {
            if (i % 50 === 0) await new Promise(r => setImmediate(r)); // Yield to event loop to keep WhatsApp connection alive
            
            const el = elements[i];
            const type = el.type;
            const subject = el.subject;
            const company = el.company;
            const updateTime = el.date;
            
            // FIX: Convert structural HTML tags to newlines before stripping remaining tags to preserve formatting
            let noticeDetails = (el.noticeHtml || '')
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/?p>/gi, '\n')
                .replace(/<\/?div>/gi, '\n')
                .replace(/<\/?li>/gi, '\n')
                .replace(/<\/?tr>/gi, '\n')
                .replace(/<[^>]*>?/gm, '')
                .trim();
            
            noticeDetails = noticeDetails.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

            // ADVANCED FORMATTING: The ERP backend literally concatenates text (e.g. removing spaces between Roll Numbers and Names) 
            // before generating the XML. We use regex to artificially restore the missing newlines and spaces.
            
            // 1. Insert newline after any 9-character IITKGP Roll Number
            noticeDetails = noticeDetails.replace(/([0-9]{2}[a-zA-Z]{2}[a-zA-Z0-9]{5})/g, '$1\n');
            
            // 2. Fix "Roll Number1" -> "Roll Number\n1"
            noticeDetails = noticeDetails.replace(/Roll Number([0-9])/gi, 'Roll Number\n$1');
            
            // 3. Insert newline after colon if it's followed by a letter (e.g. "student(s):BHUKYA")
            noticeDetails = noticeDetails.replace(/:([a-zA-Z])/g, ':\n$1');
            
            // 4. Insert space between lowercase and uppercase letter (e.g. "student(s)BHUKYA")
            noticeDetails = noticeDetails.replace(/([a-z])([A-Z])/g, '$1 $2');
            
            // 5. Insert space between digit and Title Case name (e.g. "1Vatsal" -> "1 Vatsal")
            noticeDetails = noticeDetails.replace(/([0-9])([A-Z][a-z])/g, '$1 $2');
            
            // 6. Fix missing spaces after punctuation (e.g. "22.09.26.(For")
            noticeDetails = noticeDetails.replace(/\.\(/g, '. (');
            
            // Clean up excessive newlines and multiple spaces
            noticeDetails = noticeDetails.replace(/ {2,}/g, ' ');
            noticeDetails = noticeDetails.replace(/\n\s*\n+/g, '\n\n').trim();

            let downloadLink = el.downloadLink || 'No Attachment';

            const safeCompany = company || 'General';
            if (updateTime) {
                const uniqueStr = safeCompany + updateTime;
                const noticeId = Buffer.from(uniqueStr).toString('base64');

                if (!history.includes(noticeId)) {
                    newNotices.push({ type, subject, company: safeCompany, noticeDetails, updateTime, downloadLink, noticeId });
                    updatedHistory.push(noticeId);
                } else {
                    skippedHistory++;
                }
            } else {
                skippedEmpty++;
            }
        }
        
        console.log(`[CDC-DEBUG] newNotices.length: ${newNotices.length}, skippedHistory: ${skippedHistory}, skippedEmpty: ${skippedEmpty}`);

        const dateMap = {};

        for (let notice of newNotices) {
            const ddmm = getDDMM(notice.updateTime);
            if (!ddmm) {
                console.log(`[CDC-DEBUG] Skipping notice because getDDMM failed for: ${notice.updateTime}`);
                continue;
            }
            
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
        return { success: true, processed: processedNotices, newNotices: newNotices };

    } catch (error) {
        console.error("CDC Scraper Error:", error.message);
        return { success: false, error: error.message };
    }
}

module.exports = { scrapeCDC };
