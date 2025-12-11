import { all } from 'axios';
import * as services from './index.js';
import { getAllProducts } from './services/database-psql.service.js';

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
            const token_ml = await psql.executarQueryInDb(
                company.queryTokenMl,
                [],
                company.poolName
            ); //? Mercado Livre Token
            const token_mt = await psql.executarQueryInDb(
                company.queryTokenMt,
                [],
                company.poolName
            ); //? Mercado Turbo Token

            console.log(`Access tokens for ${company.name} retrieved successfully.`);

            const access_token_ml = token_ml[0]?.access_token || null;
            const access_token_mt = token_mt[0]?.access_token || null;

            if (!access_token_ml || !access_token_mt) {
                throw new Error(`Access token for ${company.name} is null or undefined.`);
            }

            // === Função para SEMPRE buscar o token mais atual do banco (para retries 401/403) ===
            const getNewAccessTokenMl = async () => {
                const rows = await psql.executarQueryInDb(
                    company.queryTokenMl,
                    [],
                    company.poolName
                );

                if (!rows || rows.length === 0 || !rows[0]?.access_token) {
                    throw new Error(
                        `[ML] Nenhum access_token encontrado no banco para company=${company.name || company.poolName || 'desconhecida'}`
                    );
                }

                return rows[0].access_token;
            };

            const getNewAccessTokenMt = async () => {
                const rows = await psql.executarQueryInDb(
                    company.queryTokenMt,
                    [],
                    company.poolName
                );

                if (!rows || rows.length === 0 || !rows[0]?.access_token) {
                    throw new Error(
                        `[MT] Nenhum access_token encontrado no banco para company=${company.name || company.poolName || 'desconhecida'}`
                    );
                }

                return rows[0].access_token;
            };

            // Aqui já usamos o helper de retry/rotação do service do Mercado Livre
            const advertiser = await meli.get_advertiser_id(
                access_token_ml,
                "PADS",
                getNewAccessTokenMl // <- callback para trocar token em caso de 401/403
            );

            if (!advertiser?.advertisers || advertiser.advertisers.length === 0) {
                throw new Error(`Advertiser ID for ${company.name} not found.`);
            }

            const newObj = {
                ...company,
                access_token_ml,
                access_token_mt,
                advertiser_id: advertiser.advertisers,
                // guardamos as funções para usar em outras partes do fluxo
                getNewAccessTokenMl,
                getNewAccessTokenMt
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
    for (const company of objCompanies) {
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

function removeDuplicadosPorSku(lista) {
    // 1) Conta quantas vezes cada SKU aparece (ignorando itens sem SKU
    //    e ignorando SKUs que contenham "/")
    const counts = new Map();

    for (const item of lista) {
        const sku = String(item.sku ?? item.codigo_sku ?? '').trim();

        // ignora itens sem SKU OU com "/" no SKU (não queremos mandar para MT)
        if (!sku || sku.includes('/')) continue;

        counts.set(sku, (counts.get(sku) || 0) + 1);
    }

    // 2) Mantém apenas itens cujo SKU existe, NÃO contém "/",
    //    e aparece UMA única vez
    const resultado = lista.filter(item => {
        const sku = String(item.sku ?? item.codigo_sku ?? '').trim();

        // fora: sem SKU ou com "/"
        if (!sku || sku.includes('/')) return false;

        return counts.get(sku) === 1;
    });

    return resultado;
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

    const firstPage = await meli.get_metrics_pub(
        access_token,
        advertiser_id,
        fromStr,
        toStr,
        chunk,
        0,
        company.getNewAccessTokenMl
    );

    console.log('FIRST PAGE CAPTURED!!!!');
    // console.log(firstPage);

    if (!firstPage.results || firstPage.results.length <= 0) { // ! ADICIONEI O TRUE NO FINAL PARA ELE SEMPRE RETORNAR APENAS A PRIMEIRA PÁGINA
        console.log("No results in first page.");
        return listProducts;
    }

    if (process.env.DEBUG === 'true') {
        console.log("DEBUG mode: usando apenas a primeira página de resultados.");
        listProducts.push(...firstPage.results);
        return listProducts;
    }

    listProducts.push(...firstPage.results);

    const total = firstPage.paging.total;
    const totalPages = Math.ceil(parseInt(total) / parseInt(chunk));

    // Looping 
    for (let offset = chunk, pageIndex = 2; offset < total; offset += chunk, pageIndex++) {
        const page = await meli.get_metrics_pub(
            access_token,
            advertiser_id,
            fromStr,
            toStr,
            chunk,
            offset,
            company.getNewAccessTokenMl // <- idem aqui
        );

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
    //? Aqui list já vem sem SKUs duplicados (garantido por _get_sku_by_list)
    const chunks = _chunkArray(list, chunkSize);
    const allResults = [];

    //? Captura os custos adicionais da planilha de exceção
    const idSheetCost = company.idSheetExceptionsCost;
    const rangeCost = company.rangeExceptionsCost;
    let custoMap = [];

    if (idSheetCost && rangeCost) {
        const custoAdicionalExecao = await sheetsService.readSheetData(idSheetCost, rangeCost);
        custoMap = custoAdicionalExecao.map(item => ({
            sku: item[0],
            tax_aditional: item[2]
        }));
    }

    //? Captura os impostos da planilha de exceção
    const idSheetTax = company.idSheetExceptionsTax;
    const rangeTax = company.rangeExceptionsTax;
    let taxMap = [];

    if (idSheetTax && rangeTax) {
        const taxAdicionalExecao = await sheetsService.readSheetData(idSheetTax, rangeTax);
        taxMap = taxAdicionalExecao.map(item => ({
            sku: item[0],
            produto: item[1],
            icms: item[2],
            fixo: item[3],
            pis: item[4],
            cofins: item[5],
            newTaxSheet: item[14]
        }));
    }

    for (const chunk of chunks) {
        const promises = chunk.map(async (item) => {
            // Busca o produto no banco pelo código de SKU vindo do ML
            const rows = await psql.searchProducts({
                filters: { codigo_sku: item.sku }
            }, company.poolName);

            const row = rows[0];

            if (!row) {
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

            let precoDeCusto = Number(result.row.preco_de_custo) !== 0 ? parseFloat(result.row.preco_de_custo) : Number(result?.row?.preco || 0);

            if (!precoDeCusto || Number.isNaN(precoDeCusto) || precoDeCusto === 0) {
                console.warn(`SKU ${result.row.codigo_sku} sem preco_de_custo.`)
            }

            const precoDeCustoOriginal = precoDeCusto;
            if (custoMap.length > 0) {
                const custoFinded = custoMap.find(c => c.sku === sku);

                if (custoFinded?.tax_aditional) {
                    const raw = String(custoFinded.tax_aditional)
                        .replace('%', '')
                        .replace(',', '.');

                    const extraTax = Number(raw) / 100;
                    precoDeCusto = +(precoDeCusto * (1 + extraTax)).toFixed(2);
                }
            }

            //? Aqui ele vai sempre estar como "objTax" (Default)
            //? Mas caso tenha sido especificado no .env uma planilha para exceção, ele irá substituir os valores para os SKUs correspondentes.
            let taxSheet = objTax[company.name];

            if (taxMap.length > 0) {
                const taxFinded = taxMap.find(t => t.sku === sku);
                if (taxFinded) {
                    const taxSheetNum = parseFloat(taxSheet.replace(',', '.').replace('%', ''));
                    const newTaxSheet = parseFloat(taxFinded.newTaxSheet.replace(',', '.').replace('%', ''));
                    const icmsNum = parseFloat(taxFinded.icms.replace(',', '.').replace('%', ''));
                    const fixoNum = parseFloat(taxFinded.fixo.replace(',', '.').replace('%', ''));
                    const pisNum = parseFloat(taxFinded.pis.replace(',', '.').replace('%', ''));
                    const cofinsNum = parseFloat(taxFinded.cofins.replace(',', '.').replace('%', ''));

                    console.log('taxFinded ->', taxFinded);
                    console.log('taxSheet antes:', taxSheetNum);

                    console.log('taxSheetNum:', taxSheetNum);
                    console.log('icmsNum:', icmsNum);
                    console.log('fixoNum:', fixoNum);
                    console.log('pisNum:', pisNum);
                    console.log('cofinsNum:', cofinsNum);

                    taxSheet = (newTaxSheet + icmsNum + fixoNum + pisNum + cofinsNum).toFixed(2);
                    console.log('taxSheet depois:', taxSheet);
                }
            }

            return {
                sku: result.sku,
                tax_sheet: taxSheet, // imposto vindo do Google Sheets
                tacos: result.tacos,
                codigo_sku: result.row.codigo_sku,
                produto: result.row.descricao,
                preco_de_custo_original: precoDeCustoOriginal,
                preco_de_custo: precoDeCusto,
            };
        });

        allResults.push(...resultInJson);
    }


    //? Captura todos os produtos do Tiny registrados no banco de dados
    const allProductsDB = await getAllProducts({}, company.poolName);

    //? Junta as duas listas
    const listDup = [...allProductsDB, ...allResults];
    //? Remove as duplicatas e objetos vazios
    const listFiltered = removeDuplicadosPorSku(listDup);

    // console.log(listFiltered.slice(0, 3));
    // console.log(allResults.slice(0, 3));
    // console.log('Todos produtos:', allProductsDB.length);
    // console.log('Todos Anúncios feitos', allResults.length);
    // console.log('Todos os produtos restantes:', listFiltered.length);
    // console.log('Quantos deveriam ser:', (allProductsDB.length - allResults.length));
    // console.log('=================================');
    // console.log('=================================');
    // console.log('=================================');

    //? Agora ele define os valores Default para o restante dos produtos.
    for (const item of listFiltered) {
        const precoDeCusto = Number(item.preco_de_custo) !== 0 ? parseFloat(item.preco_de_custo) : Number(item?.preco || 0);
        const obj = {
            sku: item.codigo_sku,
            tax_sheet: objTax[company.name],
            tacos: 0,
            codigo_sku: item.codigo_sku,
            produto: item.descricao,
            preco_de_custo_original: precoDeCusto,
            preco_de_custo: precoDeCusto
        };
        allResults.push(obj);
    }
    // console.log('Anúncios No Total agora (com "{}")->', allResults.length);
    // console.log('Anúncios No Total agora (sem "{}")->', removeDuplicadosPorSku(allResults).length);
    // process.exit(0);

    return removeDuplicadosPorSku(allResults);
}

async function _get_sku_by_list(company, list, chunkSize = 1) {
    const chunks = _chunkArray(list, chunkSize);
    const allResults = [];
    const access_token = company.access_token_ml;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        const promises = chunk.map(async (item) => {
            try {
                const resp = await meli.get_infos_by_mlb(
                    access_token,
                    item.item_id,
                    company.getNewAccessTokenMl
                );

                const cost = Number(item.metrics?.cost || 0);
                const total_amount = Number(item.metrics?.total_amount || 0);
                const organic_units_amount = Number(item.metrics?.organic_units_amount || 0);

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

        const resultsInJson = results.map(result => {
            const sku =
                result.attributes.find(attr => attr.id === 'SELLER_SKU')
                    ?.value_name || 'NOT FOUND';

            return {
                id: result.id,
                title: result.title,
                family_name: result.family_name,
                sku,
                cost: result.cost,
                total_amount: result.total_amount,
                organic_units_amount: result.organic_units_amount
            };
        });

        allResults.push(...resultsInJson);
        console.log(`Chunk ${i + 1} de ${chunks.length}`);
    }

    // Agora agrega por SKU: 1 entrada por SKU com TACOS médio
    const skuMap = new Map();

    for (const item of allResults) {
        if (!item.sku || item.sku === 'NOT FOUND') continue;

        const prev = skuMap.get(item.sku) || { cost: 0, amount: 0 };
        prev.cost += item.cost;
        prev.amount += (item.total_amount + item.organic_units_amount);
        skuMap.set(item.sku, prev);
    }

    const objComplete = [];

    for (const [sku, agg] of skuMap.entries()) {
        let tacos = 0;

        if (agg.cost !== 0 && agg.amount !== 0) {
            tacos = parseFloat(((agg.cost / agg.amount) * 100).toFixed(2));
        }

        objComplete.push({ sku, tacos });
    }

    return objComplete;
}

async function _update_price_cost_tax(
    company,
    list,
    chunkSize = 1,
    maxRetries = 5,
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
                console.log(
                    `Processando chunk ${index + 1}/${chunks.length} | Tamanho: ${chunk.length} | Tentativa: ${attempt + 1}`
                );

                // AGORA: tudo em paralelo dentro da chunk 👇
                const promises = chunk.map(async (item) => {
                    // monta payload que será enviado
                    const tax = (
                        parseFloat(String(item.tacos).replace(",", ".").replace("%", "")) +
                        parseFloat(String(item.tax_sheet).replace(",", ".").replace("%", ""))
                    ).toFixed(2);

                    const payload = {
                        sku: item.sku,
                        preco_de_custo: item.preco_de_custo,
                        tax, // já tratado
                    };

                    try {
                        console.log(
                            `Chunk ${index + 1}/${chunks.length} | Enviando para MT |`,
                            payload
                        );

                        const result = await metu.update_cost_tax(
                            access_token,
                            payload.sku,
                            payload.preco_de_custo,
                            payload.tax
                        );

                        return result;
                    } catch (err) {
                        // marca o item e o payload que explodiram pra debug
                        err._item = item;
                        err._payload = payload;
                        throw err;
                    }
                });

                const results = await Promise.all(promises);
                allResults.push(...results);
                sleep(1000); // Espera 1 segundinho antes de ir pra próxima chunk
                // Se chegou aqui, a chunk inteira passou → sai do while e vai pra próxima
                break;
            } catch (error) {
                attempt++;

                const status = error.response?.status;
                const data = error.response?.data || error.message || error;

                console.error(
                    `Erro ao processar chunk ${index + 1}/${chunks.length} (tentativa ${attempt}/${maxRetries}).`
                );
                console.error(
                    'Status:',
                    status
                );
                console.error(
                    'Payload de erro (resumido):',
                    typeof data === 'string' ? data.slice(0, 500) + '...' : data
                );

                if (error._item) {
                    console.error('Item que causou o erro:');
                    console.dir(error._item, { depth: null });
                }

                if (error._payload) {
                    console.error('Payload enviado para MT que causou o erro:');
                    console.dir(error._payload, { depth: null });
                }

                // Re-tenta se:
                // - não tiver status (erro de rede) OU for 5xx
                // - e ainda não tiver estourado o número máximo de tentativas
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
    // console.log('TESTE >:', listProducts);
    // console.log(listProducts);
    // console.log(listProducts);
    for (const [key, items] of Object.entries(listProducts)) {
        listProducts[key] = items.filter(a => a && Object.keys(a).length > 0);
    }

    // console.log(listProducts.ltsports.slice(0, 3)); // TODO DEBUG ONLY
    // console.log(listProducts.jaufishing.slice(0, 3)); // TODO DEBUG ONLY
    // console.log('Length LTSPORTS >', listProducts.ltsports.length); // TODO DEBUG ONLY
    // process.exit(0);
    // console.log('Length JAUFISHING >', listProducts.jaufishing.length); // TODO DEBUG ONLY

    // console.log(listProducts.ltsports.slice(0, 3));
    // console.log(listProducts.jaufishing.slice(0, 3));

    // const a = listProducts.jaufishing.filter(a => a.sku === 'JP13169');
    // const b = listProducts.ltsports.filter(a => a.sku === 'JP13169');
    // console.log(a);
    // console.log(b);
    // process.exit(0);

    for (const [key, items] of Object.entries(listProducts)) { //* Aqui ele vai alterar dentro do Mercado Turbo o preço de custo e imposto
        const company = _objCompanies.find(json => json.name === key);

        const result = await _update_price_cost_tax(
            company,
            items,
            50,      // chunkSize
        );

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