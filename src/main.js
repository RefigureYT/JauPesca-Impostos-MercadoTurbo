import { access } from 'fs';
import * as services from './index.js';

// Imports
const { sheetsService, config, psql, meli, metu } = services;

// TODO ================ VARIABLES EXPORTS ================== 
export const objCompanies = await _mountObjCompanies();
export const tax = await _defineTax(objCompanies);
// TODO ======================= END ========================= 

//* ========================= FUNCTIONS =========================
async function _mountObjCompanies() {
    const objTokens = []; // To store access tokens for each company

    // Get Access Token for Mercado Livre and Mercado Turbo (for each company)
    for (const company of config.objCompanies) {
        try {
            const token_ml = await psql.executarQueryInDb(company.queryTokenMl, [], company.poolName); //? Mercado Livre Token
            const token_mt = await psql.executarQueryInDb(company.queryTokenMt, [], company.poolName); //? Mercado Turbo Token
            
            console.log(`Access tokens for ${company.name} retrieved successfully.`);
            
            const access_token_ml = token_ml[0]?.access_token || null;
            const access_token_mt = token_mt[0]?.access_token || null;
            
            if (!access_token_ml || access_token_ml === null || !access_token_mt || access_token_mt === null) {
                throw new Error(`Access token for ${company.name} is null or undefined.`);
            }
            const advertiser = await meli.get_advertiser_id(access_token_ml, "PADS");
            
            if (!advertiser || advertiser.length <= 0) {
                throw new Error(`Advertiser ID for ${company.name} is null or undefined.`);
            }
            
            const newObj = {
                ...company,
                access_token_ml,
                access_token_mt,
                advertiser_id: advertiser.advertisers
            }
            
            objTokens.push(newObj);
        } catch (error) {
            console.error(`Error retrieving access token for ${company.name}:`, error);
            process.exit(1);
        }
    }
    return objTokens;
}

async function _defineTax(objCompanies) {
    let tax = {}
    for(const company of objCompanies) {
        console.dir(company);
        const rows = await sheetsService.readSheetData(company.idSheet, company.range);
        tax[company.name] = rows[0][0];
    }
    console.log('Impostos capturados:', tax);
    return tax;
}

function _toYyyyMmDd(date) {
    return date.toISOString().slice(0, 10);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function _listProductsMeli(company, chunk = 10) {
    const today = new Date();

    // date_to = yesterday
    const date_to = new Date(today);
    date_to.setDate(today.getDate() - 1);

    // date_from = date_to - dateRangeDays
    const date_from = new Date(today);
    date_from.setDate(today.getDate() - (company.dateRangeDays + 1));

    const access_token = company.access_token_ml;
    //! VAI SEMPRE SER USADO O PRIMEIRO ÍNDICE
    //! PORQUE HÁ UM ÚNICO ANÚNCIANTE POR EMPRESA
    const advertiser_id = company.advertiser_id[0].advertiser_id;
    const fromStr = _toYyyyMmDd(date_from);
    const toStr = _toYyyyMmDd(date_to);
    console.log('De:', fromStr, 'Até:', toStr);

    // console.log(access_token, advertiser_id, fromStr, toStr, chunk, 0);
    const listProducts = [];

    const firstPage = await meli.get_metrics_pub(access_token, advertiser_id, fromStr, toStr, chunk, 0);

    console.log('FIRST PAGE CAPTURED!!!!');
    // console.log(firstPage);

    if (!firstPage.results || firstPage.results.length <= 0 || process.env.DEBUG === 'true') { // ! ADICIONEI O TRUE NO FINAL PARA ELE SEMPRE RETORNAR APENAS A PRIMEIRA PÁGINA
        console.log("No results in first page."); // ! ISSO É APENAS PARA DEBUG E PRECISA SER REMOVIDO NO FINAL!!
        listProducts.push(...firstPage.results); //! <-- ISSO É APENAS DEBUG PRECISA SER REMOVIDO!!!
        return listProducts;
    }

    listProducts.push(...firstPage.results);

    const total = firstPage.paging.total;
    const totalPages = Math.ceil(parseInt(total) / parseInt(chunk));

    // Looping 
    for (let offset = chunk, pageIndex = 2; offset < total; offset += chunk, pageIndex++) {
        const page = await meli.get_metrics_pub(access_token, advertiser_id, fromStr, toStr, chunk, offset);

        if (page?.results?.length) {
            listProducts.push(...page.results);
        }

        console.log(`Page ${pageIndex} of ${totalPages} ||===|| ${offset - chunk + page.results.length} successfully.`);
    }
    return listProducts;
}

function _chunkArray(array, chunkSize) {
    const chunks = [];
    for (let i = 0; i < array.length; i += chunkSize) {
        chunks.push(array.slice(i, i + chunkSize));
    }

    return chunks;
}

async function _get_price_cost(company, list, chunkSize = 1, objTax) {
    const chunks = _chunkArray(list, chunkSize);
    const allResults = [];

    for (const chunk of chunks) {
        const promises = chunk.map(async (item) => {
            // Busca o produto no banco pelo código de SKU vindo do ML
            const rows = await psql.searchProducts({
                filters: { codigo_sku: item.sku }
            }, company.poolName);

            const row = rows[0];

            if (!row) {
                // console.log(`ITEM: ${item.sku} NOT FOUND IN DATABASE`);
                // Mantém o item na lista, mas sem dados de custo
                return { ...item };
            }

            return { ...item, row };
        });

        const result = await Promise.all(promises);

        const resultInJson = result.map((result) => {
            const sku = result?.row?.codigo_sku || 'NOT FOUND';

            if (sku === 'NOT FOUND') {
                // volta objeto vazio pra ser filtrado depois
                return {};
            }

            return {
                // mlb: result.id,
                // title: result.title,
                // family_name: result.family_name,
                sku: result.sku,
                tax_sheet: objTax[company.name], // imposto vindo do Google Sheets
                tacos: result.tacos,
                codigo_sku: result.row.codigo_sku,
                produto: result.row.descricao,
                preco_de_custo: result.row.preco_de_custo,
                // gtin: result.row.gtin_ean,
                // tipo_do_produto:
                //     result.row.tipo_do_produto === "S"
                //         ? "SIMPLES"
                //         : result.row.tipo_do_produto === "K"
                //             ? "KIT"
                //             : "OUTRO",
            };
        });

        allResults.push(...resultInJson);
    }

    return allResults;
}

async function _get_sku_by_list(company, list, chunkSize = 1) {
    const chunks = _chunkArray(list, chunkSize);
    const allResults = [];
    const objComplete = [];
    const access_token = company.access_token_ml;

    //? After capturing all the SKUs, it filters by each SKU and averages the obtained metrics
    const skuSet = new Set();

    for (const chunk of chunks) {
        const promises = chunk.map(async (item) => {
            try {
                const resp = await meli.get_infos_by_mlb(access_token, item.item_id);
                const cost = item.metrics.cost;
                const total_amount = item.metrics.total_amount;
                const organic_units_amount = item.metrics.organic_units_amount;

                // let tacos = 0;
                // if (cost !== 0 && total_amount !== 0) {
                //     tacos = (cost / (total_amount + organic_units_amount) * 100)
                //         .toFixed(2)
                //         .replace(/\./g, ",");
                // }

                return { ...resp, cost, total_amount, organic_units_amount };
            } catch (error) {
                // Se for item inexistente, só loga e ignora
                if (error.response?.status === 404) {
                    console.warn(
                        `MLB ${item.item_id} não encontrado para a empresa ${company.name}. Ignorando...`
                    );
                    return null; // <-- isso será filtrado depois
                }

                // Qualquer outro erro: loga e deixa estourar
                console.error(
                    `Erro ao buscar MLB ${item.item_id} para a empresa ${company.name}:`,
                    error.response?.data || error.message || error
                );
                throw error;
            }
        });

        // executa tudo da chunk e remove os null (itens ignorados)
        const results = (await Promise.all(promises)).filter(r => r !== null);

        results.forEach((result) => {
            const obj = {
                sku:
                    result.attributes.find(attr =>
                        attr.id === 'SELLER_SKU' ? attr : null
                    )?.value_name || 'NOT FOUND'
            }

            if (obj.sku !== 'NOT FOUND') {
                skuSet.add(obj);
            }
        });

        const resultsInJson = results.map(result => ({
            id: result.id,
            title: result.title,
            family_name: result.family_name,
            sku:
                result.attributes.find(attr =>
                    attr.id === 'SELLER_SKU' ? attr : null
                )?.value_name || 'NOT FOUND',
            cost: result.cost,
            total_amount: result.total_amount,
            organic_units_amount: result.organic_units_amount
        }));

        allResults.push(...resultsInJson);
        console.log(`Chunk ${chunks.indexOf(chunk) + 1} de ${chunks.length}`);
    }

    for (const sku of skuSet) {
        const ads = allResults.filter(item => item.sku === sku.sku);
        const allCosts = ads.reduce((acc, item) => { return acc + item.cost;}, 0);
        const allAmount = ads.reduce((acc, item) => { return acc + item.total_amount + item.organic_units_amount;}, 0);
        // console.log(ads);
        let newTacos = 0;

        if (allCosts !== 0 && allAmount !== 0) {
            newTacos = parseFloat(((allCosts / allAmount) * 100).toFixed(2));
        }

        objComplete.push({ ...sku, tacos: newTacos });
        // console.log(objComplete); // TODO [DEBUG]
    }

    return objComplete;
}

async function _update_price_cost_tax(
    company,
    list,
    chunkSize = 1,
    maxRetries = 3,
    retryDelayMs = 5000
) {
    const chunks = _chunkArray(list, chunkSize);
    const allResults = [];
    const access_token = company.access_token_mt;

    for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        let attempt = 0;

        // Retry da MESMA chunk
        while (true) {
            try {
                const promises = chunk.map(async (item) => {
                    try {
                        const tax = (
                            parseFloat(String(item.tacos).replace(",", ".").replace("%", "")) +
                            parseFloat(String(item.tax_sheet).replace(",", ".").replace("%", ""))
                        ).toFixed(2);

                        console.log(
                            `Chunk ${index + 1}/${chunks.length} | Tentativa ${attempt + 1} | SKU: ${item.sku} <=> Tax: ${tax}`
                        );

                        return await metu.update_cost_tax(
                            access_token,
                            item.sku,
                            item.preco_de_custo,
                            tax
                        );
                    } catch (err) {
                        // marca o item que explodiu pra debug
                        err._item = item;
                        throw err;
                    }
                });

                const results = await Promise.all(promises);
                allResults.push(...results);

                // Se chegou aqui, a chunk passou → sai do while e vai pra próxima
                break;
            } catch (error) {
                attempt++;

                const status = error.response?.status;
                const data = error.response?.data || error.message || error;

                console.error(
                    `Erro ao processar chunk ${index + 1}/${chunks.length} (tentativa ${attempt}/${maxRetries}).`
                );
                console.error('Status:', status);
                console.error('Payload de erro:', data);

                if (error._item) {
                    console.error('Item que causou o erro:');
                    console.dir(error._item, { depth: null });
                }

                // Regra de retry:
                // - Re-tenta se for erro "besta" (sem status ou 5xx)
                // - Não re-tenta se for erro 4xx (problema de dado/autorização)
                const shouldRetry =
                    (!status || status >= 500) && attempt < maxRetries;

                if (!shouldRetry) {
                    console.error('Sem condições de retry para esta chunk, abortando.');
                    throw error; // deixa subir pro caller
                }

                console.log(
                    `Aguardando ${retryDelayMs / 1000}s para tentar novamente esta chunk...`
                );
                await sleep(retryDelayMs);
            }
        }
    }

    return allResults;
}

//* ============================ END ============================


//? ============================ Flow ===========================
async function start() {
    console.log('Starting application...');
    const _objCompanies = objCompanies;
    // console.log(_objCompanies); //! ONLY DEBUG COMMENT FOR PRODUCTION [SENSITIVE DATA]
    // console.log(_objCompanies[0].advertiser_id); //! ONLY DEBUG COMMENT FOR PRODUCTION [SENSITIVE DATA]

    const _tax = tax;
    for (const company of _objCompanies) {
        console.log(`DATE_RANGE_DAYS for ${company.name}: ${company.dateRangeDays}`);
    }
    const listProducts = {};

    for (const company of _objCompanies) {
        try {
            const listProduct = await _listProductsMeli(company, 300); // TODO [DEBUG] COLOQUEI 3 APENAS PARA TESTE!!!
            listProducts[company.name] = listProduct;
        } catch (error) {
            console.error("Deu erro se liga no erro:");
            console.error(
                error.response?.data || error.message || error
            );
            throw error;
        }
    }

    // console.log(listProducts.ltsports.slice(0, 3)); // TODO DEBUG ONLY
    // console.log(listProducts.jaufishing.slice(0, 3)); // TODO DEBUG ONLY
    // console.log('Length LTSPORTS >', listProducts.ltsports.length); // TODO DEBUG ONLY
    // console.log('Length JAUFISHING >', listProducts.jaufishing.length); // TODO DEBUG ONLY
    
    for (const [key, items] of Object.entries(listProducts)) { //* Converte a lista de anúncios em lista com ID, TITLE, FAMILY_NAME e SKU
        console.log('ADS\'s length:', listProducts[key].length); // TODO DEBUG ONLY
        const company = _objCompanies.find(json => json.name === key);
        
        const generalList = await _get_sku_by_list(company, items, 100);
        const listFiltered = generalList.filter(item => item.sku !== "NOT FOUND");

        listProducts[key] = listFiltered;
    }
    // console.log(listProducts.ltsports.slice(0, 3)); // TODO DEBUG ONLY
    // console.log(listProducts.jaufishing.slice(0, 3)); // TODO DEBUG ONLY
    // console.log('Length LTSPORTS >', listProducts.ltsports.length); // TODO DEBUG ONLY
    // console.log('Length JAUFISHING >', listProducts.jaufishing.length); // TODO DEBUG ONLY
    // console.log('=================================');
    // console.log('=================================');
    // console.log('=================================');
    // console.log('=================================');
    // console.log(listProducts);
    // console.log('=================================');
    // console.log('=================================');
    // console.log('=================================');
    // console.log('=================================');
    // process.exit(0);

    for (const [key, items] of Object.entries(listProducts)) { //* Adiciona o preço de custo na lista
        const company = _objCompanies.find(json => json.name === key);

        const listProductsWithCost = await _get_price_cost(company, items, 100, _tax); //! CHUNKSIZE = 3
        listProducts[key] = listProductsWithCost;
    }
    console.log('TESTE >:', listProducts);
    console.log(listProducts);
    // console.log(listProducts);
    for (const [key, items] of Object.entries(listProducts)) {
        listProducts[key] = items.filter(a => a && Object.keys(a).length > 0);
    }

    // console.log(listProducts.ltsports.slice(0, 3)); // TODO DEBUG ONLY
    // console.log(listProducts.jaufishing.slice(0, 3)); // TODO DEBUG ONLY
    // console.log('Length LTSPORTS >', listProducts.ltsports.length); // TODO DEBUG ONLY
    // console.log('Length JAUFISHING >', listProducts.jaufishing.length); // TODO DEBUG ONLY
    
    for (const [key, items] of Object.entries(listProducts)) { //* Aqui ele vai alterar dentro do Mercado Turbo o preço de custo e imposto
        const company = _objCompanies.find(json => json.name === key);
        
        const result = await _update_price_cost_tax(company, items, 50);
        const allNotOk = result.filter(r => !['Atualizado', 'Adicionado'].includes(r.status));

        if (allNotOk.length === 0) {
            console.log(`Successfully: ${key}`);
        } else {
            console.log(`Failed (${key}):`, allNotOk);
            console.log('Ending application with error...');
            process.exit(1); // process(1) Not Exist
        }
    }

    console.log('Ending application...');
}

await start();
process.exit(0);