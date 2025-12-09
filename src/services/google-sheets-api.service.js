import { google } from 'googleapis';
import { credentials } from './index.js';

const auth = new google.auth.GoogleAuth({ // Only Read Access
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

export async function readSheetData(idSheet, range) {

    const client = await auth.getClient(); // Create client authenticated
    const sheets = google.sheets({
        version: 'v4',
        auth: client,
    });

    // Call API to read data from the specified sheet and range
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: idSheet,
        range,
    });

    const rows = res.data.values || [];

    if (!rows.length) {
        console.log('No data found.');
        return [];
    }

    console.log('Data from sheet:');
    return rows;
}