import axios from "axios"

// LOCAL VARIABLES
const _urlBase = "https://app.mercadoturbo.com.br";

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function update_cost_tax(access_token, sku, cost, tax) {
    const url = _urlBase + `/rest/produtos/sku/${sku}`;
    const body = {
        custo: cost,
        imposto: tax
    };
    const config = {
        headers: {
            'Authentication': `Bearer ${access_token}`,
            'Api-Version': '2'
        }
    };

    async function doRequest() {
        const resp = await axios.post(url, body, config);
        return resp.data;
    }

    try {
        // 1ª tentativa
        return await doRequest();
    } catch (error) {
        const status = error.response?.status;

        // Só aplicamos backoff específico para 429
        if (status === 429) {
            console.warn(`[MT][RATE LIMIT] 429 ao atualizar SKU=${sku}. Iniciando backoff progressivo...`);

            const backoffMs = [
                5_000,   // 5s
                10_000,  // 10s
                30_000,  // 30s
                60_000,  // 1min
                120_000, // 2min
                300_000, // 5min
                600_000, // 10min
            ];

            let lastError = error;

            for (let i = 0; i < backoffMs.length; i++) {
                const wait = backoffMs[i];
                console.warn(
                    `[MT][RATE LIMIT] Aguardando ${wait / 1000}s antes de nova tentativa para SKU=${sku} (${i + 1}/${backoffMs.length})...`
                );
                await sleep(wait);

                try {
                    const data = await doRequest();
                    console.log(`[MT][RATE LIMIT] Sucesso ao atualizar SKU=${sku} após backoff (${i + 1}/${backoffMs.length}).`);
                    return data;
                } catch (retryErr) {
                    lastError = retryErr;
                    const retryStatus = retryErr.response?.status;

                    // Se mudou o tipo de erro, sai do fluxo de 429 e deixa estourar
                    if (retryStatus !== 429) {
                        console.error(
                            `[MT][RATE LIMIT] Status mudou de 429 para ${retryStatus} ao atualizar SKU=${sku}. Abortando backoff.`
                        );
                        throw retryErr;
                    }

                    console.warn(
                        `[MT][RATE LIMIT] Ainda 429 ao atualizar SKU=${sku} (tentativa ${i + 1}/${backoffMs.length}).`
                    );
                }
            }

            const finalMsg = `[MT][RATE LIMIT] Ainda recebendo 429 (Too Many Requests) para SKU=${sku} após múltiplas tentativas. Provável limite/bloqueio temporário no Mercado Turbo.`;
            const wrappedError = new Error(finalMsg);
            wrappedError.originalError = lastError;
            console.error('Error in request update_cost_tax (after 429 retries):');
            console.error(lastError.response?.data || lastError.message || lastError);
            throw wrappedError;
        }

        // Qualquer outro erro (400, 401, 500, etc) cai aqui e sobe pro caller
        console.error('Error in request update_cost_tax:');
        console.error(error.response?.data || error.message || error);
        throw error;
    }
}
