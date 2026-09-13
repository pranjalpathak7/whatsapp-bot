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
        let elements = [];
        const maxPages = fetchAll ? 100 : 3; 
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


        for (let page = 1; page <= maxPages; page++) {
            console.log(`[CDC] Fetching page ${page} (jqqueryid=54) with perfect headers via CURL...`);
            
            const url = `https://erp.iitkgp.ac.in/TrainingPlacementSSO/ERPMonitoring.htm?action=fetchData&jqqueryid=54&_search=false&rows=20&page=${page}&sidx=&sord=asc&totalrows=50&nd=${Date.now()}`;
            // GET request with Referer set to showmenu.htm
            const curlCmdGet = `curl -s --compressed -H "Cookie: ${cdcCookie}" -H "Accept: application/xml, text/xml, */*; q=0.01" -H "Accept-Language: en-US,en;q=0.9" -H "Connection: keep-alive" -H "Host: erp.iitkgp.ac.in" -H "Referer: https://erp.iitkgp.ac.in/IIT_ERP3/showmenu.htm" -H "Sec-Ch-Ua: \\"Not/A)Brand\\";v=\\"8\\", \\"Chromium\\";v=\\"126\\", \\"Google Chrome\\";v=\\"126\\"" -H "Sec-Ch-Ua-Mobile: ?0" -H "Sec-Ch-Ua-Platform: \\"Windows\\"" -H "Sec-Fetch-Dest: empty" -H "Sec-Fetch-Mode: cors" -H "Sec-Fetch-Site: same-origin" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" -H "X-Requested-With: XMLHttpRequest" "${url}"`;

            let data = '';
            try {
                const { stdout } = await exec(curlCmdGet, { maxBuffer: 1024 * 1024 * 10 });
                data = stdout;
                console.log(`[CDC-DEBUG] CURL GET STDOUT on page ${page}:\n`, data.substring(0, 1500));
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

            // If GET returned 0 rows, try POST! jqGrid often uses POST for fetchData.
            if (xmlRows.length === 0) {
                console.log(`[CDC] GET returned 0 rows on page ${page}. Retrying with POST...`);
                const curlCmdPost = `curl -i -s --compressed -X POST -H "Cookie: ${cdcCookie}" -H "Accept: application/xml, text/xml, */*; q=0.01" -H "Accept-Language: en-US,en;q=0.9" -H "Connection: keep-alive" -H "Host: erp.iitkgp.ac.in" -H "Referer: https://erp.iitkgp.ac.in/IIT_ERP3/showmenu.htm" -H "Sec-Ch-Ua: \\"Not/A)Brand\\";v=\\"8\\", \\"Chromium\\";v=\\"126\\", \\"Google Chrome\\";v=\\"126\\"" -H "Sec-Ch-Ua-Mobile: ?0" -H "Sec-Ch-Ua-Platform: \\"Windows\\"" -H "Sec-Fetch-Dest: empty" -H "Sec-Fetch-Mode: cors" -H "Sec-Fetch-Site: same-origin" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" -H "X-Requested-With: XMLHttpRequest" "${url}" -d ""`;
                try {
                    const { stdout } = await exec(curlCmdPost, { maxBuffer: 1024 * 1024 * 10 });
                    console.log(`[CDC-DEBUG] CURL POST STDOUT on page ${page}:\n`, stdout.substring(0, 1500));
                    if (typeof stdout === 'string' && stdout.includes('<?xml')) {
                        $xml = cheerio.load(stdout, { xmlMode: true });
                        xmlRows = $xml('row').toArray();
                        console.log(`[CDC] POST returned ${xmlRows.length} rows!`);
                    }
                } catch (e) {
                    console.log(`[CDC] CURL POST Error on page ${page}:`, e.message);
                }
            }

            if (xmlRows.length > 0 && $xml) {
                for (let el of xmlRows) {
                    const cellsArr = $xml(el).find('cell').toArray();
                    if (cellsArr.length >= 8) {
                        elements.push({
                            type: $xml(cellsArr[1]).text().trim(),
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
