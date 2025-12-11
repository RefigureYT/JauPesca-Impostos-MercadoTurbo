import { access, readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { configDotenv } from "dotenv";
import path from "path";
configDotenv();

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ============= HELPERS =============

async function checkFileExist(dirFile) {
    try {
        await access(dirFile);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') { // File not found or not exist
            return false;
        }
        return false;
    }
}

async function readFileJson(dirFile) {
    const content = await readFile(dirFile, 'utf8');
    const dados = JSON.parse(content);
    return dados;
}

// ========= FIM DOS HELPERS =========

if (!(await checkFileExist(path.resolve(__dirname, '../credentials/cred.json')))) {
    console.error("Credentials file not found.");
    process.exit(1);
}

export const credentials = await readFileJson(path.resolve(__dirname, '../credentials/cred.json'));

if (!credentials) {
    console.error("Credentials file not found.");
    process.exit(1);
}

// verify companies by .env variable
const companiesEnv = process.env.ACTIVE_COMPANIES || '';

if (!companiesEnv) {
    console.error("ACTIVE_COMPANIES environment variable is not set.");
    process.exit(1);
}

const companies = companiesEnv.split(',').map(a => a.trim());
console.log('Active companies:', companies);

export const objCompanies = [];
export const poolConfigs = companies.reduce((acc, name) => {
    const poolConfig = {
        host: process.env[`${name}_DB_HOST`] || process.env.DB_HOST,
        port: process.env[`${name}_DB_PORT`] || process.env.DB_PORT,
        user: process.env[`${name}_DB_USER`] || process.env.DB_USER,
        password: process.env[`${name}_DB_PASSWORD`] || process.env.DB_PASSWORD,
        database: process.env[`${name}_DB_DATABASE`] || process.env.DB_DATABASE,
        ssl: process.env[`${name}_DB_SSL`] === 'true' ? true : process.env.DB_SSL === 'true' ? true : false
    }

    const requiredMapPool = {
        host: poolConfig.host,
        port: poolConfig.port,
        user: poolConfig.user,
        database: poolConfig.database,
        password: poolConfig.password
    }

    const missingVarsPool = Object.entries(requiredMapPool)
        .filter(([_, value]) => value === '' || value === undefined || value === null || Number.isNaN(value))
        .map(([key]) => `${name}_${key}`);

    if (missingVarsPool.length > 0) {
        console.error(
            `Missing or invalid environment variables for company "${name}". ` +
            `The following variables must be defined: ${missingVarsPool.join(', ')}.`
        );
        process.exit(1);
    }

    acc[name] = poolConfig;
    return acc;
}, {});

for (const company of companies) {
    const name = process.env[`${company}_NAME`] || '';
    const idSheet = process.env[`${company}_ID_SHEET`] || '';
    const range = process.env[`${company}_RANGE`] || '';
    const idSheetExceptionsCost = process.env[`${company}_ID_SHEET_EXCEPTIONS_COST`] || null; // null is allowed
    const rangeExceptionsCost = process.env[`${company}_RANGE_EXCEPTIONS_COST`] || null;     // null is allowed
    const idSheetExceptionsTax = process.env[`${company}_ID_SHEET_EXCEPTIONS_TAX`] || null; // null is allowed
    const rangeExceptionsTax = process.env[`${company}_RANGE_EXCEPTIONS_TAX`] || null;     // null is allowed
    const dateRangeDays = parseInt(process.env[`${company}_DATE_RANGE_DAYS`]) || parseInt(process.env.DATE_RANGE_DAYS);
    const queryTokenMl = process.env[`${company}_TOKEN_QUERY_ML`] || '';
    const queryTokenMt = process.env[`${company}_TOKEN_QUERY_MT`] || '';

    // Map pra saber exatamente qual faltou
    const requiredMap = {
        NAME: name,
        ID_SHEET: idSheet,
        RANGE: range,
        DATE_RANGE_DAYS: dateRangeDays,
        TOKEN_QUERY_ML: queryTokenMl,
        TOKEN_QUERY_MT: queryTokenMt
    };

    const missingVars = Object.entries(requiredMap)
        .filter(([_, value]) => value === '' || value === undefined || value === null || Number.isNaN(value))
        .map(([key]) => `${company}_${key}`);

    if (missingVars.length > 0) {
        console.error(
            `Missing or invalid environment variables for company "${company}". ` +
            `The following variables must be defined: ${missingVars.join(', ')}.`
        );
        process.exit(1);
    }

    const obj = {
        name,
        idSheet,
        range,
        idSheetExceptionsCost,
        rangeExceptionsCost,
        idSheetExceptionsTax,
        rangeExceptionsTax,
        dateRangeDays,
        queryTokenMl,
        queryTokenMt,
        poolName: company
    }

    objCompanies.push(obj);
}


