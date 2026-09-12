const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const db = require('./database');

const historyFile = path.join(__dirname, 'cdc_history.json');
const outboxDir = path.join(__dirname, 'bot4_outbox');

// Ensure directories and files exist
if (!fs.existsSync(outboxDir)) {
    fs.mkdirSync(outboxDir, { recursive: true });
}

function loadHistory() {
    try {
        return fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : [];
    } catch (e) {
        return [];
    }
}

function saveHistory(history) {
    if (history.length > 100) {
        history = history.slice(history.length - 100);
    }
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
}

async function scrapeCDC() {
    if (!db.erpCookie) return;

    try {
        const url = `https://erp.iitkgp.ac.in/TrainingPlacementSSO/ERPMonitoring.htm?action=fetchData&jqqueryid=54&_search=false&rows=50&page=1&sidx=&sord=asc&totalrows=50&nd=${Date.now()}`;
        const response = await axios.get(url, {
            headers: {
                'Cookie': db.erpCookie,
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': '*/*'
            }
        });

        const html = response.data;
        const $ = cheerio.load(html);
        
        let history = loadHistory();
        let newNotices = [];
        let updatedHistory = [...history];

        $('tr').each((i, el) => {
            const type = $(el).find('td[aria-describedby="grid54_type"]').text().trim();
            const subject = $(el).find('td[aria-describedby="grid54_category"]').text().trim();
            const company = $(el).find('td[aria-describedby="grid54_company"]').text().trim();
            
            const noticeLink = $(el).find('td[aria-describedby="grid54_notice"] a');
            const noticeDetails = noticeLink.attr('title') ? noticeLink.attr('title').trim() : '';
            
            const updateTime = $(el).find('td[aria-describedby="grid54_noticeat"]').text().trim();
            
            const downloadElem = $(el).find('td[aria-describedby="grid54_view1"] a');
            let downloadLink = downloadElem.attr('href');
            
            if (downloadLink) {
                if (downloadLink.startsWith('/')) {
                    downloadLink = 'https://erp.iitkgp.ac.in' + downloadLink;
                }
            } else {
                downloadLink = 'No Attachment';
            }

            if (company && updateTime) {
                const uniqueStr = company + updateTime;
                const noticeId = Buffer.from(uniqueStr).toString('base64');

                if (!history.includes(noticeId)) {
                    newNotices.push({
                        type, subject, company, noticeDetails, updateTime, downloadLink, noticeId
                    });
                    updatedHistory.push(noticeId);
                }
            }
        });

        if (newNotices.length > 0) {
            saveHistory(updatedHistory);
            
            // Reversing so oldest new notices are processed first (if multiple)
            newNotices.reverse().forEach(notice => {
                const formattedMessage = `*🚨 New CDC Notice*\n\n` +
                    `*🏢 Company:* ${notice.company}\n` +
                    `*📌 Type:* ${notice.type}\n` +
                    `*📝 Subject:* ${notice.subject}\n` +
                    `*🕒 Updated At:* ${notice.updateTime}\n` +
                    `*💬 Details:* ${notice.noticeDetails}\n\n` +
                    `*📎 Attachment:* ${notice.downloadLink}`;

                const task = {
                    type: 'send',
                    number: 'YOUR_ACTUAL_PHONE_NUMBER_HERE',
                    text: formattedMessage
                };
                
                const safeId = notice.noticeId.substring(0, 8).replace(/[\/\+\=]/g, '0');
                const taskFile = path.join(outboxDir, `cdc_notice_${Date.now()}_${safeId}.json`);
                fs.writeFileSync(taskFile, JSON.stringify(task, null, 2));
            });
            console.log(`[CDC Scraper] Found ${newNotices.length} new notices.`);
        }

    } catch (error) {
        console.error("CDC Scraper Error:", error.message);
    }
}

module.exports = { scrapeCDC };
