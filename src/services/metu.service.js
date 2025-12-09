import axios from "axios"

// LOCAL VARIABLES
const _urlBase = "https://app.mercadoturbo.com.br";

export async function update_cost_tax(access_token, sku, cost, tax) {
    try {
        const url = _urlBase + `/rest/produtos/sku/${sku}`;
        const body = {
            custo: cost,
            imposto: tax
        }
        const config = {
            headers: {
                'Authentication': `Bearer ${access_token}`,
                'Api-Version': '2'
            }
        }

        const resp = await axios.post(url, body, config);
        return resp.data;
    } catch (error) {
        console.error('Error in request update_cost_tax:');
        console.error(error.response?.data || error.message || error);
        throw error;
    }
}