# Vitals Scraper

> 🤖 A simple Android Vitals scraper

## Usage
```bash
npm i
npm run start:dev -- --accountId="<accountId>" --packageName="<packageName>" --format=csv --outDir=./save/ --headless=true --verbose
```

### Options
- `--accountId` required
- `--packageName` required (`*` would download data for all the apps on the account)
- `--days` (default `7`)
- `--format` (default: `csv`)
- `--outDir` (default: `./`)
- `--verbose` (default: `false`)