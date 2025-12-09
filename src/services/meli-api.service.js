import axios from 'axios';

// ============= LOCAL VARIABLES =============
const _urlBase = 'https://api.mercadolibre.com';
// =================== END ===================

// ============= LOCAL FUNCTIONS =============
// function _chunkArray(array, chunkSize) { // Create Chunks
//     const chunks = [];

//     for (let i = 0; i < array.length; i += chunkSize) {
//         chunks.push(array.slice(i, i + chunkSize));
//     }

//     return chunks;
// }

// async function fetchInChunks(list, advertiserId, access_token, chunkSize = 10, delayMs = 0) {
//     const chunks = _chunkArray(list, chunkSize);
//     const allResults = [];

//     for (const chunk of chunks) {
//         // Mount promises of these chunk
//         const promises = chunk.map(async (item) => {
//             const url = `${_urlBase}/advertising/advertisers/${advertiserId}/product_ads/items?limit=${chunkSize}&offset=0`;

//             const resp = await axios.get(url, {
//                 headers: {
//                     Authorization: `Bearer ${access_token}`,
//                     'Api-Version': '2'
//                 },
//                 params: {

//                 }
//             })
//         });
//     }
// }
// =================== END ===================

export async function get_advertiser_id(access_token, product_id) {
    try {
        const url = _urlBase + `/advertising/advertisers?product_id=${product_id}`;
        const resp = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${access_token}`,
                'Api-Version': '1'
            }
        });

        return resp.data;
    } catch (error) {
        console.error("Error in request advertiser_id:");
        console.error(
            error.response?.data || error.message || error
        );
        throw error;
    }
}

export async function get_metrics_pub(access_token, advertiserId, date_from, date_to, limit, offset) {
    try {
        const metrics = 'clicks,prints,ctr,cost,cpc,acos,organic_units_quantity,' +
        'organic_units_amount,organic_items_quantity,direct_items_quantity,' +
        'indirect_items_quantity,advertising_items_quantity,cvr,roas,sov,' +
        'direct_units_quantity,indirect_units_quantity,units_quantity,' +
        'direct_amount,indirect_amount,total_amount';

        const params = new URLSearchParams({
            date_from,
            date_to,
            limit: String(limit),
            offset: String(offset),
            metrics,
            metrics_summary: 'true'
        });

        const url = _urlBase + 
        `/advertising/advertisers/${advertiserId}/product_ads/items?` + params.toString();

        const resp = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${access_token}`,
                'api-version': '2'
            }
        });

        return resp.data;
    } catch (error) {
        console.error('Error in request get_metrics_pub:');
        console.error(error.response?.data || error.message || error);
        throw error;
    }
}

export async function get_infos_by_mlb(access_token, mlb) {
    try {
        const url = _urlBase + `/items/${mlb}`;

        const resp = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${access_token}`,
                'Api-Version': '2'
            }
        });

        return resp.data;
    } catch (error) {
        console.error('Error in request get_infos_by_mlb:');
        console.error(error.response?.data || error.message || error);
        throw error;
    }
}