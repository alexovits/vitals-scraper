import { Page, Browser } from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import { fallbackPromise, logger, sleep } from './utils';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());

export class Downloader {
    private browser: Browser;
    private pages: Page[] = [];
    private parallel: number = 1;
    private accountId: string;
    private claimRequest: Promise<Page> = Promise.resolve(null);

    constructor(parallel: number, accountId: string) {
        this.parallel = Math.abs(Math.max(1, parallel));
        this.accountId = accountId;
    }

    public safeStringify = (obj: Object, indent = 2) => {
        let cache: Array<any> = [];
        const retVal = JSON.stringify(
            obj,
            (key, value) =>
                typeof value === 'object' && value !== null
                    ? cache.includes(value)
                        ? undefined // Duplicate reference found, discard key
                        : cache.push(value) && value // Store value in our collection
                    : value,
            indent
        );
        cache = null;
        return retVal;
    };

    public async init(headless: boolean) {
        this.browser = await puppeteer.launch({
            headless,
            userDataDir: './data',
            defaultViewport: null,
        });

        for (let i = 0; i < this.parallel; i++) {
            const page = await this.browser.newPage();
            (page as any).currentRequest = Promise.resolve();
            this.pages.push(page);
        }
    }

    public async login() {
        const page = await this.claimPage();
        try {
            await page.goto('https://play.google.com/apps/publish');
            await page.waitForResponse(
                (response) => {
                    console.log('Original check:', response.url().includes('developer'));
                    return response.url().includes('developer');
                },
                { timeout: null }
            );
            await pageLoadFinished(page);
        } finally {
            this.releasePage(page);
        }
    }

    public async loadAppList(page: Page): Promise<any> {
        try {
            await page.goto(`https://play.google.com/console/u/0/developers/${this.accountId}/app-list`);
            await pageLoadFinished(page);
            await sleep(2000);
            await page.waitForSelector(`pagination-bar dropdown-button material-icon`);
            await page.click('pagination-bar dropdown-button material-icon');
            await sleep(2000);
            await page.waitForSelector(`material-select-dropdown-item:last-child`);
            await page.click('material-select-dropdown-item:last-child');
        } catch (err) {
            logger.warn(`Failed to loadAppList, trying again`);
            await sleep(1000);
            return this.loadAppList(page);
        }
    }

    public async loadCrashANRList(page: Page, appId: String, daysToScrape: number): Promise<any> {
        // https://play.google.com/console/u/0/developers/8109871065813726294/app/4972842327387852418/vitals/crashes?installedFrom=PLAY_STORE&days=1
        try {
            await page.goto(
                `https://play.google.com/console/u/0/developers/${this.accountId}/app/${appId}/vitals/crashes?installedFrom=PLAY_STORE&days=${daysToScrape}`
            );
            await pageLoadFinished(page);
            await page.waitForSelector(`pagination-bar dropdown-button material-icon`);
            await page.click('pagination-bar dropdown-button material-icon');
            await sleep(2000);
            await page.waitForSelector(`material-select-dropdown-item:last-child`);
            await page.click('material-select-dropdown-item:last-child');
            await sleep(3000);
        } catch (err) {
            logger.warn(`Failed to loadCrashANRList, trying again`);
            await sleep(1000);
            return this.loadCrashANRList(page, appId, daysToScrape);
        }
    }

    public async getCrashOverview(appId: String, daysToScrape: number) {
        const page = await this.claimPage();
        try {
            await this.loadCrashANRList(page, appId, daysToScrape);
            page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));
            const packageDetails = await page.$$eval('ess-table .particle-table-row', (rows) => {
                // Here every row is a Crash/ANR row
                // console.log(`DEBUG - number of rows: ${rows.length}`);
                return rows.map((row) => {
                    const cols = Array.from(row.querySelectorAll('ess-cell')).filter((cell) => cell.textContent);
                    // console.log(`DEBUG - number of cols: ${cols.length}`);
                    // $<name> doesnt have any role here, it's arbitrary not a special syntax
                    const [$crashName, $type, $new, $occur, $impact, $latest, $crashPage] = cols;
                    return {
                        error: `${$crashName
                            .querySelector('.main-text-line')
                            .textContent.trim()} - ${$crashName.querySelector('.secondary-line').textContent.trim()}`,
                        type: $type.textContent.trim(),
                        occurrences: $occur.textContent.trim(),
                        impactedUsers: $impact.textContent.trim(),
                        lastOccurred: $latest.textContent.trim(),
                        crashPage: $crashPage.querySelector('a').href,
                    };
                });
            });
            return packageDetails;
        } finally {
            this.releasePage(page);
        }
    }

    public async getOverview() {
        const page = await this.claimPage();
        try {
            await this.loadAppList(page);
            page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));
            const packageDetails = await page.$$eval('ess-table .particle-table-row', (rows) => {
                // logger.warn('Whats goin on dad!');
                return rows.map((row) => {
                    const cols = Array.from(row.querySelectorAll('ess-cell')).filter((cell) => cell.textContent);
                    // the a in ess-table has a href like:
                    // https://play.google.com/console/u/0/developers/<account-id>/app/<app-id>/app-dashboard'
                    const appSiteHref = Array.from(row.querySelectorAll('a')).filter((cell) =>
                        cell.href.includes('console/u/0/developers')
                    )[0].href;
                    const [$appName, $activeInstalls, $status, $lastUpdate] = cols;
                    return {
                        appName: $appName.querySelector('.line').textContent.trim(),
                        packageName: $appName.querySelector('.subtext .line').textContent.trim(),
                        activeInstalls: Number($activeInstalls.textContent.replace(/[^0-9]/g, '')),
                        lastUpdate: $lastUpdate.textContent.trim(),
                        status: $status.textContent.trim(),
                        appId: appSiteHref.match('app/(.*)/app-dashboard')[1],
                    };
                });
            });
            return packageDetails;
        } finally {
            this.releasePage(page);
        }
    }

    public async saveScreenshot(filename: string) {
        const page = await this.claimPage();
        try {
            await page.screenshot({ path: filename, fullPage: true });
        } finally {
            this.releasePage(page);
        }
    }

    public async takeScreenshotOfUrl(url: string, filename: string) {
        const page = await this.claimPage();
        try {
            await page.goto(url);
            await pageLoadFinished(page);
            await page.screenshot({ path: filename, fullPage: true });
        } finally {
            this.releasePage(page);
        }
    }

    public close() {
        this.browser.close();
    }

    private async claimPage(): Promise<Page> {
        const claimRequest = this.claimRequest.then(() => {
            return new Promise<Page>(async (resolve) => {
                const page = await Promise.race(this.pages.map((p: any) => p.currentRequest.then(() => p)));
                page.currentRequest = page.currentRequest.then(() => {
                    return new Promise((resolve) => {
                        page.release = resolve;
                    });
                });
                resolve(page);
            });
        });

        this.claimRequest = claimRequest;
        return claimRequest;
    }

    private async releasePage(page: Page) {
        const sleepMult = 1 + Math.random() * 5;
        await sleep(1000 * sleepMult);
        (page as any).release();
    }
}

async function pageLoadFinished(page: Page): Promise<any> {
    const contentEl = await page.$('.material-content');
    const spinnerEl = await page.$('material-spinner');
    if (!contentEl || spinnerEl) {
        await sleep(2000);
        return pageLoadFinished(page);
    }
    return;
}