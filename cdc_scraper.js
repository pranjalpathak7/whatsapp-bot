const axios = require('axios');
const cheerio = require('cheerio');
const db = require('./database');

async function scrapeCDCNotices() {
    try {
        if (!db.erpCookie) {
            console.log('[CDC] No cookie configured. Skipping.');
            return [];
        }

        const url = 'https://erp.iitkgp.ac.in/TrainingPlacementSSO/ERPMonitoring.htm?action=fetchData&jqqueryid=54&_search=false&nd=' + Date.now() + '&rows=200&page=1&sidx=&sord=asc&totalrows=500';
        
        console.log(`[CDC] Fetching notices from ERP with perfect headers...`);
        const res = await axios.get(url, {
            headers: {
                'Accept': 'application/xml, text/xml, */*; q=0.01',
                'Accept-Encoding': 'gzip, deflate, br, zstd',
                'Accept-Language': 'en-US,en;q=0.9',
                'Connection': 'keep-alive',
                'Cookie': db.erpCookie,
                'Host': 'erp.iitkgp.ac.in',
                'Referer': 'https://erp.iitkgp.ac.in/TrainingPlacementSSO/ERPMonitoring.htm',
                'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': '"Windows"',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'X-Requested-With': 'XMLHttpRequest'
            },
            timeout: 15000,
            validateStatus: () => true
        });

        if (res.status !== 200) {
            console.log('[CDC] ERP returned non-200 status:', res.status);
            return [];
        }

        const data = res.data;
        let notices = [];

        // It is returning XML!
        if (typeof data === 'string' && data.includes('<?xml')) {
            const $xml = cheerio.load(data, { xmlMode: true });
            const xmlRows = $xml('row').toArray();
            console.log(`[CDC] Parsed XML, found ${xmlRows.length} rows.`);

            if (xmlRows.length > 0) {
                xmlRows.forEach(row => {
                    const cells = $xml(row).find('cell').toArray();
                    if (cells.length >= 7) {
                        const type = $xml(cells[1]).text().trim();
                        const subject = $xml(cells[2]).text().trim();
                        const company = $xml(cells[3]).text().trim();
                        
                        // Description might have HTML anchor tags inside CDATA
                        const descHtml = $xml(cells[4]).text().trim();
                        const $desc = cheerio.load(descHtml, { xmlMode: false });
                        const noticeDesc = $desc('a').attr('title') || $desc.text().trim();

                        const dateStr = $xml(cells[6]).text().trim();
                        
                        let attachmentId = null;
                        const uploadHtml = $xml(cells[8]).text();
                        const idMatch = uploadHtml.match(/id=(\d+)/);
                        if (idMatch) {
                            attachmentId = idMatch[1];
                        }

                        notices.push({
                            id: $xml(row).attr('id') || attachmentId || Math.random().toString(),
                            type,
                            subject,
                            company,
                            notice: noticeDesc,
                            date: dateStr,
                            attachmentId
                        });
                    }
                });
                return notices;
            } else {
                console.log("[CDC] XML contained 0 <row> elements. Raw output:");
                console.log(data.substring(0, 500));
            }
        }

        console.log('[CDC] Extracted', notices.length, 'notices (fallback check).');
        return notices;

    } catch (error) {
        console.error('[CDC Scraper Error]:', error.message);
        return [];
    }
}

module.exports = { scrapeCDCNotices };
