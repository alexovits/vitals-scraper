import { logger } from './utils';
import ora from 'ora';
import * as path from 'path';
import { Downloader } from './Downloader';
import moment from 'moment';
import {
    StructuredStreamWriter,
    StructuredFormat,
} from './utils/structuredStreamWriter';

const validErrorTypes = ['crash', 'ANR'];

export interface CrashData {
    error: string;
    type: string;
    occurrences: string;
    impactedUsers: string;
    lastOccurred: string;
    crashPage: string;
}

export async function scrapeErrors(argv: any) {
    if (!argv.accountId) {
        throw new Error(`No [--accountId] set, this is required`);
    }
    if (!argv.packageName) {
        throw new Error(`No [--packageName] set, this is required`);
    }

    const errorTypes: string[] = (argv.errorType || 'crash,ANR').split(',');
    if (!argv.errorType) {
        logger.log(
            `[--errorType] is not set, defaulting to [${errorTypes.join(
                ','
            )}] (options: crash,ANR)`
        );
    } else {
        const invalidErrorType = errorTypes.find(
            (et: string) => !validErrorTypes.includes(et)
        );
        if (invalidErrorType) {
            throw new Error(
                `An invalid errorType was specified (${invalidErrorType}), valid options are [crash,ANR]`
            );
        }
    }

    const verbose = argv.verbose || false;
    if (!argv.verbose) {
        logger.log(`[--verbose] is not set, defaulting to [${verbose}]`);
    }
    (process as any).verbose = verbose;

    const parallel = argv.parallel || 1;
    if (!argv.parallel) {
        logger.log(`[--parallel] is not set, defaulting to [${parallel}]`);
    }

    const daysToScrape = argv.days || 7;
    if (!argv.days) {
        logger.log(`[--days] is not set, defaulting to [${daysToScrape}]`);
    } else {
        logger.log(`scraping for [${daysToScrape}]`);
    }

    if (![1, 7, 14, 30, 60].includes(daysToScrape)) {
        throw new Error(
            `[--days=${argv.days}] is invalid, please supply one of: [1, 7, 14, 30, 60]`
        );
    }

    const format = argv.format || 'json';
    if (!argv.format) {
        logger.log(
            `[--format] is not set, defaulting to [${format}] (options: json | csv)`
        );
    }
    if (!['json', 'csv'].includes(format)) {
        throw new Error(`Currently supports csv or json`);
    }

    let headless = argv.headless === 'true';
    if (!['true', 'false'].includes(argv.headless)) {
        headless = true;
        logger.log(
          `[--headless] is not set/valid, defaulting to [${headless}] (options: true | false)`
        );
    }

    let outputDir;
    if (!argv.outDir) {
        outputDir = process.cwd();
        logger.log(`[--outDir] is not set, using [${outputDir}]`);
    } else {
        outputDir = path.join(process.cwd(), argv.outDir);
        logger.log(`Writing data to [${outputDir}]`);
    }

    let numExceptions: 'all' | number = 'all';
    if (!argv.numExceptions) {
        logger.log(`[--numExceptions] is not set, using [${numExceptions}]`);
    } else {
        const nE = Number(argv.numExceptions);
        if (isNaN(nE)) {
            if (argv.numExceptions !== 'all') {
                logger.warn(
                    `[--numExceptions] is invalid, please set a number or "all"`
                );
            } else {
                numExceptions = argv.numExceptions;
            }
        } else {
            numExceptions = nE;
        }
        logger.log(
            `[--numExceptions] specified, [${numExceptions}] will be retrieved`
        );
    }

    console.log('\n\n');

    const downloader = new Downloader(parallel, argv.accountId);

    await downloader.init(headless);

    const loginProgress = ora(`Logging In(see popped Chromium window)`).start();
    await downloader.login();
    loginProgress.succeed('Logging In');

    const availablePackages = await downloader.getOverview();
    // Remove any suspended and draft apps from the set of available packages as these aren't in use.
    const publishedPackages = availablePackages.filter(
        (p) => p.status === 'Production'
    );
    const publishedPackageNames = publishedPackages.map((p) => p.packageName);
    if (verbose) {
        console.log('Available packages: ', availablePackages);
    }
    let packageNamesToScrape = argv.packageName.split(',');
    if (packageNamesToScrape.includes('*')) {
        packageNamesToScrape = publishedPackageNames;
    } else {
        for (const packageName of packageNamesToScrape) {
            if (!publishedPackageNames.includes(packageName)) {
                downloader.close();
                throw new Error(
                    `Package name [${packageName}]is not available`
                );
            }
        }
    }

    await downloader.login();

    for (const packageName of packageNamesToScrape) {
        const packageInfos = availablePackages.find(
            (value, index) => value.packageName === packageName
        );
        console.log(
            `Scraping package ${packageName} ${JSON.stringify(packageInfos)}`
        );
        const crashOverview = await downloader.getCrashOverview(
            packageInfos.appId,
            daysToScrape
        );
        if (crashOverview.length > 0) {
            if (verbose) {
                console.log('CRASH OVERVIEW', crashOverview);
            }
            await createGeneralErrorReport(
              outputDir,
              packageName,
              format,
              crashOverview
            );
        } else {
            console.log('No errors found');
        }
        console.log('\n\n');
        console.info(`Successfully scraped [${packageName}]`);
    }
    downloader.close();
}

function convertLastOccurredStringToDate(lastOccurred: string): string {
    const now = moment();
    const value = lastOccurred.split(' ')[0];
    const unit = lastOccurred.split(' ')[1];
    // @ts-ignore
    now.subtract(value, unit);
    return now.toISOString();
}

async function createGeneralErrorReport(
    outputDir: string,
    packageName: string,
    format: StructuredFormat,
    crashOverview: CrashData[]
) {
    const outFilePath = path.join(
        outputDir,
        `android-vitals-${packageName}_${Date.now()}.${format}`
    );

    const clustersProgress = ora(
        `[${packageName}] Getting and writing vitals info to [${outFilePath}]`
    ).start();

    try {
        const fileWriter = new StructuredStreamWriter(
            format,
            outFilePath,
            Object.keys(crashOverview[0])
        );
        await Promise.all(
            crashOverview.map(async (crashData) => {
                try {
                    crashData.lastOccurred = convertLastOccurredStringToDate(crashData.lastOccurred);
                    return fileWriter.writeItem(crashData);
                } catch (err) {
                    console.error(
                        `Failed to get error cluster, skipping:`,
                        { packageName },
                        err
                    );
                    return Promise.resolve();
                }
            })
        );
        fileWriter.done();
        clustersProgress.succeed();
    } catch (err) {
        clustersProgress.fail();
        console.info(`Failed to createGeneralErrorReport [${packageName}]`, err);
        throw err;
    }
}
