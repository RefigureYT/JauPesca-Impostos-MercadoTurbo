// src/services/mercado_livre.service.js
import axios from 'axios';

// ============= LOCAL VARIABLES =============
const _urlBase = 'https://api.mercadolibre.com';
// =================== END ===================

// ============= HELPERS GERAIS =============
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Helper genérico para chamadas ao Mercado Livre com:
 * - Retry + rotação de token para 401/403
 * - Retry com backoff para 429
 *
 * @param {Object} options
 * @param {'get'|'post'|'put'|'delete'|'patch'} options.method
 * @param {string} options.path - Caminho da API (sem o _urlBase)
 * @param {string} options.accessToken - Token inicial
 * @param {Function} [options.getNewAccessToken] - Função async que busca um NOVO token no banco
 * @param {Object} [options.params] - Query params
 * @param {Object} [options.data] - Body da requisição (para POST/PUT/PATCH)
 * @param {Object} [options.extraHeaders] - Headers adicionais (ex: Api-Version)
 * @param {string} [options.descriptionForLogs] - Texto curto para logs/erros
 */
async function callMercadoLivre({
    method = 'get',
    path,
    accessToken,
    getNewAccessToken,
    params,
    data,
    extraHeaders = {},
    descriptionForLogs = '',
}) {
    let tokenAtual = accessToken;
    const url = `${_urlBase}${path}`;

    async function doRequest() {
        const resp = await axios({
            method,
            url,
            params,
            data,
            headers: {
                Authorization: `Bearer ${tokenAtual}`,
                ...extraHeaders,
            },
        });
        return resp;
    }

    let lastError;

    try {
        const resp = await doRequest();
        return resp.data;
    } catch (error) {
        lastError = error;
        const status = error.response?.status;

        // ========== 401 / 403 - TOKEN INVÁLIDO / EXPIRADO ==========
        if (status === 401 || status === 403) {
            // Se não tiver função para pegar novo token, apenas propaga o erro
            if (typeof getNewAccessToken !== 'function') {
                console.error(`[ML][AUTH] Erro ${status} em ${descriptionForLogs || path} e nenhuma função getNewAccessToken foi fornecida.`);
                throw error;
            }

            // Sequência de esperas:
            // 1) troca de token imediata
            // 2) espera 10s
            // 3) espera 60s
            // 4) espera 600s (10min)
            const backoffMs = [0, 10_000, 60_000, 600_000];

            for (let i = 0; i < backoffMs.length; i++) {
                const wait = backoffMs[i];

                if (wait > 0) {
                    console.warn(`[ML][AUTH] Erro ${status}. Aguardando ${wait / 1000}s antes de tentar novo token... (${i + 1}/${backoffMs.length})`);
                    await sleep(wait);
                } else {
                    console.warn(`[ML][AUTH] Erro ${status}. Tentando novo token imediatamente... (${i + 1}/${backoffMs.length})`);
                }

                try {
                    tokenAtual = await getNewAccessToken();

                    if (!tokenAtual || typeof tokenAtual !== 'string') {
                        console.error('[ML][AUTH] getNewAccessToken retornou valor inválido.');
                        break;
                    }

                    const respRetry = await doRequest();
                    return respRetry.data;
                } catch (retryErr) {
                    lastError = retryErr;
                    const retryStatus = retryErr.response?.status;

                    // Se mudou o tipo de erro, não faz mais sentido continuar o fluxo de AUTH
                    if (retryStatus !== status) {
                        console.error(`[ML][AUTH] Status mudou de ${status} para ${retryStatus}. Abortando fluxo de retry AUTH.`);
                        throw retryErr;
                    }

                    console.warn(`[ML][AUTH] Novo erro ${retryStatus} mesmo após troca de token. (${i + 1}/${backoffMs.length})`);
                }
            }

            // Se chegou aqui, falhou todas as tentativas
            const finalMsg = `[ML][AUTH] Falha ao obter acesso válido após múltiplas tentativas para ${descriptionForLogs || path}. Último status: ${lastError.response?.status}.`;
            const wrappedError = new Error(finalMsg);
            wrappedError.originalError = lastError;
            throw wrappedError;
        }

        // ========== 429 - TOO MANY REQUESTS ==========
        if (status === 429) {
            const backoffMs = [
                5_000,   // 5s
                10_000,  // 10s
                30_000,  // 30s
                60_000,  // 1min
                120_000, // 2min
                300_000, // 5min
                600_000, // 10min
            ];

            console.warn(`[ML][RATE LIMIT] Erro 429 em ${descriptionForLogs || path}. Iniciando backoff progressivo...`);

            for (let i = 0; i < backoffMs.length; i++) {
                const wait = backoffMs[i];
                console.warn(`[ML][RATE LIMIT] Aguardando ${wait / 1000}s antes de nova tentativa (${i + 1}/${backoffMs.length})...`);
                await sleep(wait);

                try {
                    const respRetry = await doRequest();
                    return respRetry.data;
                } catch (retryErr) {
                    lastError = retryErr;
                    const retryStatus = retryErr.response?.status;

                    if (retryStatus !== 429) {
                        console.error(`[ML][RATE LIMIT] Status mudou de 429 para ${retryStatus}. Abortando fluxo de retry RATE LIMIT.`);
                        throw retryErr;
                    }

                    console.warn(`[ML][RATE LIMIT] Ainda recebendo 429 após tentativa (${i + 1}/${backoffMs.length}).`);
                }
            }

            const finalMsg = `[ML][RATE LIMIT] Ainda recebendo 429 (Too Many Requests) após múltiplas tentativas para ${descriptionForLogs || path}. Provável limite de API estourado ou bloqueio temporário.`;
            const wrappedError = new Error(finalMsg);
            wrappedError.originalError = lastError;
            throw wrappedError;
        }

        // ========== 404 - NÃO ENCONTRADO ==========
        if (status === 404) {
            // Sem retry. Muitas vezes significa "anúncio/produto não localizado".
            console.warn(`[ML][404] Recurso não encontrado em ${descriptionForLogs || path}. Não será feito retry.`);
            throw error;
        }

        // ========== OUTROS ERROS ==========
        // Aqui você pode, no futuro, tratar 5xx, ETIMEDOUT, etc.
        throw error;
    }
}
// =================== END HELPERS ===================


// ============= FUNÇÕES PÚBLICAS (SERVICES) =============

/**
 * Busca advertiser_id a partir de um product_id.
 *
 * @param {string} access_token - Token inicial
 * @param {string} product_id - product_id do ML
 * @param {Function} [getNewAccessToken] - Função async que busca um NOVO token no banco
 */
export async function get_advertiser_id(access_token, product_id, getNewAccessToken) {
    try {
        const data = await callMercadoLivre({
            method: 'get',
            path: `/advertising/advertisers`,
            accessToken: access_token,
            getNewAccessToken,
            params: { product_id },
            extraHeaders: {
                'Api-Version': '1',
            },
            descriptionForLogs: `get_advertiser_id(product_id=${product_id})`,
        });

        return data;
    } catch (error) {
        console.error('[ML][get_advertiser_id] Erro na requisição:');
        console.error(error.response?.data || error.message || error);
        throw error;
    }
}

/**
 * Busca métricas de product_ads por advertiser.
 *
 * @param {string} access_token - Token inicial
 * @param {number|string} advertiserId
 * @param {string} date_from - Ex: '2025-01-01'
 * @param {string} date_to   - Ex: '2025-01-10'
 * @param {number} limit
 * @param {number} offset
 * @param {Function} [getNewAccessToken] - Função async que busca um NOVO token no banco
 */
export async function get_metrics_pub(
    access_token,
    advertiserId,
    date_from,
    date_to,
    limit,
    offset,
    getNewAccessToken,
) {
    try {
        const metrics =
            'clicks,prints,ctr,cost,cpc,acos,organic_units_quantity,' +
            'organic_units_amount,organic_items_quantity,direct_items_quantity,' +
            'indirect_items_quantity,advertising_items_quantity,cvr,roas,sov,' +
            'direct_units_quantity,indirect_units_quantity,units_quantity,' +
            'direct_amount,indirect_amount,total_amount';

        const params = {
            date_from,
            date_to,
            limit: String(limit),
            offset: String(offset),
            metrics,
            metrics_summary: 'true',
        };

        const data = await callMercadoLivre({
            method: 'get',
            path: `/advertising/advertisers/${advertiserId}/product_ads/items`,
            accessToken: access_token,
            getNewAccessToken,
            params,
            extraHeaders: {
                'Api-Version': '2',
            },
            descriptionForLogs: `get_metrics_pub(advertiserId=${advertiserId}, ${date_from}..${date_to}, limit=${limit}, offset=${offset})`,
        });

        return data;
    } catch (error) {
        console.error('[ML][get_metrics_pub] Erro na requisição:');
        console.error(error.response?.data || error.message || error);
        throw error;
    }
}

/**
 * Busca infos de um item (MLB) na API de items.
 *
 * @param {string} access_token - Token inicial
 * @param {string} mlb - Código MLB (ex: "MLB123456")
 * @param {Function} [getNewAccessToken] - Função async que busca um NOVO token no banco
 */
export async function get_infos_by_mlb(access_token, mlb, getNewAccessToken) {
    try {
        const data = await callMercadoLivre({
            method: 'get',
            path: `/items/${mlb}`,
            accessToken: access_token,
            getNewAccessToken,
            extraHeaders: {
                'Api-Version': '2',
            },
            descriptionForLogs: `get_infos_by_mlb(mlb=${mlb})`,
        });

        return data;
    } catch (error) {
        console.error('[ML][get_infos_by_mlb] Erro na requisição:');
        console.error(error.response?.data || error.message || error);
        throw error;
    }
}
// =================== END SERVICES ===================