// ### ./src/services/database.service.js ###
import { poolConfigs } from '../config/config.js';
import pg from 'pg';

const { Pool } = pg;

// console.log('poolConfigDefault ->', poolConfigDefault);

// Aqui ele vai criar um Pool para cada config (SOMENTE UMA VEZ)
const pools = Object.fromEntries(
    Object.entries(poolConfigs).map(([name, config]) => [name, new Pool(config)])
);

// Agora esse daqui é um HELPER para ajudar a buscar o pool certo
function _getPool(poolName) {
    const pool = pools[poolName];
    if (!pool) {
        throw new Error(`Pool ${poolName} não encontrado em poolConfigs`);
    }
    return pool;
}

// 2. listeners de eventos p/ TODOS os pools
// for (const [name, pool] of Object.entries(pools)) {
//     pool.on('error', (err) => {
//         console.error(`❌ ERRO INESPERADO no pool "${name}"!`, err);
//     });

//     pool.on('connect', (client) => {
//         console.log(`ℹ️ [${name}] cliente conectado. PID: ${client.processID}`);
//     });

//     pool.on('acquire', () => {
//         console.log(`ℹ️ [${name}] conexão adquirida do pool.`);
//     });

//     pool.on('remove', () => {
//         console.log(`ℹ️ [${name}] conexão devolvida/removida do pool.`);
//     });
// }

/**
 * @description Testa a conexão com o banco de dados usando variáveis de ambiente.
 * @returns {Promise<boolean>} Retorna true se a conexão for bem-sucedida, caso contrário, lança um erro.
 */
export async function conectarAoBanco(poolName) {
    const hostBanco = poolConfigs[poolName].host;
    const user = poolConfigs[poolName].user;

    // console.log(`[database.js] Tentando conectar ao banco no host: ${hostBanco} com o usuário: ${user}`);
    let client;
    try {
        // console.log('Tentando se conectar ao banco de dados...');
        const pool = _getPool(poolName);
        client = await pool.connect();
        // console.log('Conexão bem-sucedida ao banco de dados!');
        return true; // Retorna true porque a conexão foi bem-sucedida
    }
    catch (error) {
        console.error(`[database.js] Erro ao conectar ao banco "${poolName}" no host "${hostBanco}" com o usuário "${user}": ${error.message}`);
        return false; // Retorna false porque houve um erro na conexão
    } finally {
        if (client) {
            // console.log('Devolvendo a conexão ao pool...');
            client.release();
            // console.log('Conexão devolvida ao pool.');
        }
    }
}

/** 
 * @description Executa um comando SQL (query) no banco de dados.
 * @param {string} sqlCommand - O comando SQL que vai ser executado. Use $1, $2 para parâmetros.
 * @param {Array} params - Uma array com os valores para substituir $1, $2, etc.
 * @returns {Promise<Array>} Um array com as linhas retornadas pela query.
 */
export async function executarQueryInDb(sqlCommand, params = [], poolName) {
    let client;
    try {
        const pool = _getPool(poolName);
        client = await pool.connect();
        // console.log('Executando comando:', { sqlCommand, params });
        const resultado = await client.query(sqlCommand, params);
        // console.log(`Comando executado com sucesso, ${resultado.rowCount} linhas retornadas/afetadas.`);
        return resultado.rows;
    } catch (error) {
        console.error(`❌ Erro ao executar comando no banco "${poolName}": ${error.message}`);
        // Lança o erro para que a função que chamou saiba que algo deu errado
        throw error;
    } finally {
        if (client) {
            // console.log('Devolvendo a conexão ao pool...');
            client.release();
            // console.log('Conexão devolvida ao pool.');
        }
    }
}

/** @typedef {{ schema: string, owner: string }} SchemaInfo */

/**
 * @description Lista todos os schemas
 * @returns {Promise<SchemaInfo[]>} Retorna um Array com todos os schemas que o usuário definido nas variáveis do ambiente tem acesso.
 */
export async function listSchemas(poolName) {
    const q = `
    -- \dn  (lista schemas e dono)
    SELECT n.nspname AS schema,
        pg_get_userbyid(n.nspowner) AS owner
    FROM pg_namespace n
    ORDER BY 1;
    `;
    const schemas = await executarQueryInDb(q, [], poolName);
    return schemas;
}

/** @typedef {{ tablename: string }} TableInfo */

/**
 * @description Esta função lista todas as tables de um schema específico.
 * @param {string} schema - Este é o nome do schema cujo será buscado as tables de dentro.
 * @returns {Promise<TableInfo[]>} Retorna um Array com todas as tables do schema especificado.
 */
export async function listTablesBySchema(schema, poolName) {
    const q = `
        SELECT tablename
        FROM pg_catalog.pg_tables
        WHERE schemaname = '${schema}'
        ORDER BY tablename;
    `;

    const tables = await executarQueryInDb(q, [], poolName);
    return tables;
}

/**
 * @typedef {Object} ProductSearchFilters
 * @property {number|string} [id]
 * @property {string} [codigo_sku]
 * @property {string} [descricao]
 * @property {string} [unidade]
 * @property {string} [classificacao_fiscal]
 * @property {string} [origem]
 * @property {number} [preco]
 * @property {number} [valor_ipi_fixo]
 * @property {string} [observacoes]
 * @property {string} [situacao]
 * @property {number} [estoque]
 * @property {number} [preco_de_custo]
 * @property {string} [cod_do_fornecedor]
 * @property {string} [fornecedor]
 * @property {string} [localizacao]
 * @property {number} [estoque_maximo]
 * @property {number} [estoque_minimo]
 * @property {number} [peso_liquido_kg]
 * @property {number} [peso_bruto_kg]
 * @property {string} [gtin_ean]
 * @property {string} [gtin_ean_tributavel]
 * @property {string} [descricao_complementar]
 * @property {string} [cest]
 * @property {string} [codigo_de_enquadramento_ipi]
 * @property {string} [formato_embalagem]
 * @property {number} [largura_embalagem]
 * @property {number} [altura_embalagem]
 * @property {number} [comprimento_embalagem]
 * @property {number} [diametro_embalagem]
 * @property {string} [tipo_do_produto]
 * @property {string} [url_imagem_1]
 * @property {string} [url_imagem_2]
 * @property {string} [url_imagem_3]
 * @property {string} [url_imagem_4]
 * @property {string} [url_imagem_5]
 * @property {string} [url_imagem_6]
 * @property {string} [categoria]
 * @property {string} [codigo_do_pai]
 * @property {string} [variacoes]
 * @property {string} [marca]
 * @property {string} [garantia]
 * @property {boolean} [sob_encomenda]
 * @property {number} [preco_promocional]
 * @property {string} [url_imagem_externa_1]
 * @property {string} [url_imagem_externa_2]
 * @property {string} [url_imagem_externa_3]
 * @property {string} [url_imagem_externa_4]
 * @property {string} [url_imagem_externa_5]
 * @property {string} [url_imagem_externa_6]
 * @property {string} [link_do_video]
 * @property {string} [titulo_seo]
 * @property {string} [descricao_seo]
 * @property {string} [palavras_chave_seo]
 * @property {string} [slug]
 * @property {number} [dias_para_preparacao]
 * @property {boolean} [controlar_lotes]
 * @property {number} [unidade_por_caixa]
 * @property {string} [url_imagem_externa_7]
 * @property {string} [url_imagem_externa_8]
 * @property {string} [url_imagem_externa_9]
 * @property {string} [url_imagem_externa_10]
 * @property {number} [markup]
 * @property {boolean} [permitir_inclusao_nas_vendas]
 * @property {string} [ex_tipi]
 *
 * @property {string} [global]      termo de busca geral (procurar em várias colunas)
 */

/**
 * @description Pesquisa produtos permitindo filtro por qualquer coluna conhecida
 *              e/ou uma pesquisa geral em múltiplas colunas de texto.
 *
 * @param {Object} options
 * @param {ProductSearchFilters} [options.filters] - Filtros por coluna (id, codigo_sku, gtin_ean, etc.)
 * @param {number} [options.limit=50] - Limite de registros retornados
 * @param {number} [options.offset=0] - Offset para paginação
 * @returns {Promise<Array>} Lista de produtos encontrados
 *
 * @example
 *  // Buscar por SKU
 *  await searchProducts({ filters: { codigo_sku: 'JP13616' } });
 *
 * @example
 *  // Buscar por termo geral (SKU, descrição, marca, etc.)
 *  await searchProducts({ filters: { global: 'barraca' } });
 *
 * @example
 *  // Combinar filtro específico + termo geral
 *  await searchProducts({ filters: { categoria: 'Barracas', global: 'belfix' } });
 */
export async function searchProducts({ filters = {}, limit = 50, offset = 0 } = {}, poolName) {
    // Ajuste aqui o nome da tabela, caso seja diferente
    const tableName = 'tiny.produtos';

    // Lista de colunas permitidas para filtro direto (whitelist)
    const allowedColumns = [
        'id',
        'codigo_sku',
        'descricao',
        'unidade',
        'classificacao_fiscal',
        'origem',
        'preco',
        'valor_ipi_fixo',
        'observacoes',
        'situacao',
        'estoque',
        'preco_de_custo',
        'cod_do_fornecedor',
        'fornecedor',
        'localizacao',
        'estoque_maximo',
        'estoque_minimo',
        'peso_liquido_kg',
        'peso_bruto_kg',
        'gtin_ean',
        'gtin_ean_tributavel',
        'descricao_complementar',
        'cest',
        'codigo_de_enquadramento_ipi',
        'formato_embalagem',
        'largura_embalagem',
        'altura_embalagem',
        'comprimento_embalagem',
        'diametro_embalagem',
        'tipo_do_produto',
        'url_imagem_1',
        'url_imagem_2',
        'url_imagem_3',
        'url_imagem_4',
        'url_imagem_5',
        'url_imagem_6',
        'categoria',
        'codigo_do_pai',
        'variacoes',
        'marca',
        'garantia',
        'sob_encomenda',
        'preco_promocional',
        'url_imagem_externa_1',
        'url_imagem_externa_2',
        'url_imagem_externa_3',
        'url_imagem_externa_4',
        'url_imagem_externa_5',
        'url_imagem_externa_6',
        'link_do_video',
        'titulo_seo',
        'descricao_seo',
        'palavras_chave_seo',
        'slug',
        'dias_para_preparacao',
        'controlar_lotes',
        'unidade_por_caixa',
        'url_imagem_externa_7',
        'url_imagem_externa_8',
        'url_imagem_externa_9',
        'url_imagem_externa_10',
        'markup',
        'permitir_inclusao_nas_vendas',
        'ex_tipi'
    ];

    // Colunas usadas na "pesquisa geral" (global)
    const globalSearchColumns = [
        'id',
        'codigo_sku',
        'descricao',
        'descricao_complementar',
        'cod_do_fornecedor',
        'fornecedor',
        'localizacao',
        'gtin_ean',
        'gtin_ean_tributavel',
        'categoria',
        'marca',
        'palavras_chave_seo',
        'slug',
        'observacoes'
    ];

    const whereClauses = [];
    const values = [];

    // Sanitização básica de limit/offset
    let limitNum = Number(limit);
    if (!Number.isFinite(limitNum) || limitNum <= 0) limitNum = 50;
    if (limitNum > 1000) limitNum = 1000;

    let offsetNum = Number(offset);
    if (!Number.isFinite(offsetNum) || offsetNum < 0) offsetNum = 0;

    // ------- 1) PESQUISA GERAL (filters.global) -------
    const globalTerm = filters.global;
    if (globalTerm && String(globalTerm).trim() !== '') {
        values.push(`%${globalTerm}%`);
        const placeholder = `$${values.length}`;

        const orParts = globalSearchColumns.map((col) => {
            // ::text para permitir busca mesmo em colunas numéricas/inteiras
            return `${col}::text ILIKE ${placeholder}`;
        });

        whereClauses.push(`(${orParts.join(' OR ')})`);
    }

    // ------- 2) FILTROS ESPECÍFICOS POR COLUNA -------
    for (const [column, value] of Object.entries(filters)) {
        if (column === 'global') continue; // já tratamos acima
        if (value === undefined || value === null || value === '') continue;
        if (!allowedColumns.includes(column)) continue; // ignora colunas não permitidas

        // String -> ILIKE com wildcard
        if (typeof value === 'string') {
            values.push(`%${value}%`);
            const placeholder = `$${values.length}`;
            whereClauses.push(`${column}::text ILIKE ${placeholder}`);
        } else {
            // Número / boolean / etc. -> comparação direta
            values.push(value);
            const placeholder = `$${values.length}`;
            whereClauses.push(`${column} = ${placeholder}`);
        }
    }

    // ------- 3) LIMIT / OFFSET -------
    values.push(limitNum);
    const limitPlaceholder = `$${values.length}`;

    values.push(offsetNum);
    const offsetPlaceholder = `$${values.length}`;

    const whereSql = whereClauses.length
        ? `WHERE ${whereClauses.join(' AND ')}`
        : '';

    const sql = `
        SELECT *
        FROM ${tableName}
        ${whereSql}
        ORDER BY id
        LIMIT ${limitPlaceholder}
        OFFSET ${offsetPlaceholder};
    `;

    const rows = await executarQueryInDb(sql, values, poolName);
    return rows;
}

// Busca TODOS os produtos, paginando em blocos de até 1000
export async function getAllProducts({ filters = {} } = {}, poolName) {
    const pageSize = 1000; // respeita o limite interno do searchProducts
    const allRows = [];
    let offset = 0;

    while (true) {
        const page = await searchProducts(
            { filters, limit: pageSize, offset },
            poolName
        );

        allRows.push(...page);

        // Se voltou menos do que pageSize, acabou
        if (page.length < pageSize) {
            break;
        }

        offset += pageSize;
    }

    // 🔎 Aqui filtramos para pegar apenas produtos que NÃO sejam "produto pai"
    // Regra:
    // - Se tipo_do_produto estiver "S" ou "K" => é SIMPLES ou KIT / pode ter pai => MANTÉM
    // - Se tipo_do_produto estiver "V" => consideramos produto pai => REMOVE
    const productsWithoutParent = allRows.filter(prod => {
        const parentCode = (prod.tipo_do_produto ?? '').toString().trim();
        return parentCode !== 'V';
    });

    return productsWithoutParent;
}