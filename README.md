# JauPesca-Impostos-MercadoTurbo

Serviço em Node.js responsável por **atualizar o custo e o imposto dos produtos no Mercado Turbo**, combinando:

- Métricas de anúncios do **Mercado Livre (product ads)** – para calcular o **TACOS** por SKU.  
- Dados de produtos vindos do **Tiny ERP** espelhados em um **PostgreSQL**.  
- Regras fiscais e exceções definidas em **planilhas do Google Sheets**.  

<a href="https://wakatime.com/badge/user/db4a2800-e564-4201-9406-b98e170a6764/project/d08b4f45-c03c-4c44-b2a3-74e35f9416f3"><img src="https://wakatime.com/badge/user/db4a2800-e564-4201-9406-b98e170a6764/project/d08b4f45-c03c-4c44-b2a3-74e35f9416f3.svg" alt="wakatime"></a>

---

## Índice

- [Visão geral do fluxo](#visão-geral-do-fluxo)
- [Stack e arquitetura](#stack-e-arquitetura)
- [Pré-requisitos](#pré-requisitos)
- [Configuração do ambiente (.env)](#configuração-do-ambiente-env)
  - [Variáveis globais](#variáveis-globais)
  - [Configuração multi-empresa](#configuração-multi-empresa)
- [Configuração do Google Sheets](#configuração-do-google-sheets)
  - [Service Account e credenciais](#service-account-e-credenciais)
  - [Formato da planilha principal (ID_SHEET + RANGE)](#formato-da-planilha-principal-id_sheet--range)
  - [Formato da planilha de exceções de CUSTO](#formato-da-planilha-de-exceções-de-custo)
  - [Formato da planilha de exceções de IMPOSTO](#formato-da-planilha-de-exceções-de-imposto)
  - [O que fazer se as planilhas não funcionarem](#o-que-fazer-se-as-planilhas-não-funcionarem)
- [Banco de dados esperado](#banco-de-dados-esperado)
  - [Tabela tiny.produtos](#tabela-tinyprodutos)
  - [Tabela tokens.credentials](#tabela-tokenscredentials)
- [Como executar o projeto](#como-executar-o-projeto)
  - [Execução manual](#execução-manual)
  - [Agendamento (cron, PM2, n8n)](#agendamento-cron-pm2-n8n)
- [Detalhe do fluxo de cálculo](#detalhe-do-fluxo-de-cálculo)
- [Adicionando uma nova empresa](#adicionando-uma-nova-empresa)
- [Resolução de problemas comuns](#resolução-de-problemas-comuns)
- [Licença](#licença)

---

## Visão geral do fluxo

Em alto nível, o serviço faz:

```text
[Mercado Livre Ads] --> métricas por anúncio (MLB) ------.
                                                        |
                                                        v
                                             [SKU + TACOS % por SKU]
                                                        |
[PostgreSQL (Tiny)] --> produtos, custo base -----------+----.
                                                             |
                                                             v
                           [Google Sheets] --> imposto padrão da empresa
                                               + exceções de custo
                                               + exceções de imposto
                                                             |
                                                             v
                                   [Cálculo final de custo e imposto]
                                                             |
                                                             v
                             [Mercado Turbo] --> update_cost_tax (custo + imposto)
```

Tudo isso é feito **para cada empresa ativa** definida em `ACTIVE_COMPANIES`.

---

## Stack e arquitetura

**Linguagem / runtime**

- Node.js (módulos ES – `"type": "module"`).

**Dependências principais**

- [`axios`](https://www.npmjs.com/package/axios) – HTTP client para APIs do Mercado Livre e Mercado Turbo.
- [`dotenv`](https://www.npmjs.com/package/dotenv) – carregamento de variáveis de ambiente.
- [`googleapis`](https://www.npmjs.com/package/googleapis) – acesso à API do Google Sheets via Service Account.
- [`pg`](https://www.npmjs.com/package/pg) – cliente PostgreSQL com múltiplos pools (um por empresa).

**Arquitetura de pastas**

- `src/main.js`  
  Orquestra o fluxo completo:
  - monta o objeto de empresas (tokens, configs, advertiser_id),
  - lê o imposto padrão por empresa,
  - busca métricas de anúncios no Mercado Livre,
  - agrega por SKU (TACOS),
  - combina com custo e imposto vindos do banco + Sheets,
  - envia custo + imposto final para o Mercado Turbo.

- `src/config/config.js`  
  Responsável por:
  - carregar `.env`,
  - garantir que `src/credentials/cred.json` existe,
  - montar `credentials` (Service Account Google),
  - montar `poolConfigs` (um pool de PostgreSQL por empresa),
  - montar `objCompanies` com:
    - `name`, `idSheet`, `range`,
    - planilhas de exceção de custo e imposto,
    - `dateRangeDays`,
    - queries de tokens ML/MT,
    - `poolName`.

- `src/services/database-psql.service.js`  
  - Cria um `Pool` do PostgreSQL por empresa.
  - `_getPool(poolName)` – helper para pegar o pool correto.
  - `executarQueryInDb(sql, params, poolName)` – execução genérica.
  - `searchProducts({ filters, limit, offset }, poolName)` – busca paginada em `tiny.produtos` com **diversos filtros permitidos**.
  - `getAllProducts({}, poolName)` – traz todos os produtos (paginando internamente), já filtrando produtos “pai” (`tipo_do_produto = 'V'`).

- `src/services/google-sheets-api.service.js`  
  - Configura `google.auth.GoogleAuth` com o `credentials` lido de `cred.json`.
  - `readSheetData(idSheet, range)` – leitura **somente leitura** de qualquer planilha.

- `src/services/meli-api.service.js`  
  - Define `_urlBase = 'https://api.mercadolibre.com'`.
  - Implementa um helper genérico `callMercadoLivre` com:
    - Retry + rotação de token para 401/403 (via callbacks `getNewAccessToken`).
    - Retry com backoff progressivo para 429.
    - logging detalhado do endpoint / params.
  - Exponibiliza:
    - `get_advertiser_id(access_token, product_id, getNewAccessToken)`.
    - `get_metrics_pub(access_token, advertiserId, date_from, date_to, limit, offset, getNewAccessToken)`.
    - `get_infos_by_mlb(access_token, mlb, getNewAccessToken)`.

- `src/services/metu.service.js`  
  - Define `_urlBase = 'https://app.mercadoturbo.com.br'`.
  - `update_cost_tax(access_token, sku, cost, tax)`:
    - POST em `/rest/produtos/sku/{sku}` com `{ custo, imposto }`.
    - Trata 429 (Too Many Requests) com backoff progressivo e **múltiplas tentativas**.
    - Loga payloads problemáticos e relança erros para o caller.

- `src/index.js`  
  Re-exporta tudo em um único ponto:
  ```js
  export * as config from './config/config.js';
  export * as sheetsService from './services/google-sheets-api.service.js';
  export * as psql from './services/database-psql.service.js';
  export * as meli from './services/meli-api.service.js';
  export * as metu from './services/metu.service.js';
  ```

---

## Pré-requisitos

- **Node.js** 18+ (recomendado LTS recente).
- **PostgreSQL** acessível a partir do servidor onde este serviço roda.
- Tabelas:
  - `tiny.produtos` – espelho dos produtos do Tiny ERP.
  - `tokens.credentials` – tabela que armazena tokens de acesso do Mercado Livre e Mercado Turbo.
- Conta no **Google Cloud** com:
  - API do Google Sheets habilitada.
  - Service Account com permissão de leitura nas planilhas.
- Contas e tokens:
  - Conta de **Mercado Livre** com Advertising API habilitada.
  - Conta de **Mercado Turbo** com acesso à API v2.

---

## Configuração do ambiente (.env)

Copie o arquivo de exemplo:

```bash
cp .env.example .env
```

E então preencha os valores conforme abaixo.

### Variáveis globais

```ini
ACTIVE_COMPANIES=LT,JF

DATE_RANGE_DAYS=10

DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=CHANGE_ME_DB_PASSWORD
DB_DATABASE=api
DB_SSL=false
```

- `ACTIVE_COMPANIES`  
  Lista de **códigos de empresas** separados por vírgula (sem espaço), ex.: `LT,JF`.  
  Cada código será usado como **prefixo** para as variáveis específicas da empresa.

- `DATE_RANGE_DAYS`  
  Janela padrão (em dias) usada para puxar métricas de anúncios do Mercado Livre.  
  Exemplo: `10` → considera os últimos 10 dias **sem contar hoje**.

- `DB_*`  
  Configuração padrão de conexão ao PostgreSQL.  
  Cada empresa pode sobrescrever esses valores com `LT_DB_HOST`, `JF_DB_HOST`, etc.  
  Se não houver override, usa estes globais.

### Configuração multi-empresa

Para cada empresa listada em `ACTIVE_COMPANIES`, você precisa definir um conjunto de variáveis.

Exemplo para `LT` (L.T. Sports):

```ini
LT_NAME=ltsports

LT_ID_SHEET=CHANGE_ME_LT_SHEET_ID
LT_RANGE='Table'!D12

LT_ID_SHEET_EXCEPTIONS_COST=CHANGE_ME_LT_SHEET_EXC_COST_ID
LT_RANGE_EXCEPTIONS_COST='Custo Lucas [LT][Excecao]'!A2:C

LT_ID_SHEET_EXCEPTIONS_TAX=CHANGE_ME_LT_SHEET_EXC_TAX_ID
LT_RANGE_EXCEPTIONS_TAX='Imposto Lucas [LT][Excecao]'!A2:O

LT_DATE_RANGE_DAYS=10

LT_TOKEN_QUERY_ML=SELECT * FROM tokens.credentials WHERE company = 'ltsports' AND provider = 'meli' AND env = 'dev' LIMIT 1
LT_TOKEN_QUERY_MT=SELECT * FROM tokens.credentials WHERE company = 'ltsports' AND provider = 'metu' AND env = 'dev' LIMIT 1
```

E para `JF` (Jaú Fishing), um exemplo simplificado:

```ini
JF_NAME=jaufishing

JF_ID_SHEET=CHANGE_ME_JF_SHEET_ID
JF_RANGE='Table'!E12

JF_DATE_RANGE_DAYS=10

JF_TOKEN_QUERY_ML=SELECT * FROM tokens.credentials WHERE company = 'jaufishing' AND provider = 'meli' AND env = 'dev' LIMIT 1
JF_TOKEN_QUERY_MT=SELECT * FROM tokens.credentials WHERE company = 'jaufishing' AND provider = 'metu' AND env = 'dev' LIMIT 1
```

**Explicando cada variável:**

- `*_NAME`  
  Nome interno da empresa (usado em logs, debug, etc.).

- `*_ID_SHEET`  
  ID da **planilha principal** da empresa (aparece na URL do Google Sheets).

- `*_RANGE`  
  Intervalo que será lido dentro da planilha principal.  
  A célula `rows[0][0]` desse range é usada como **imposto padrão da empresa**.

- `*_ID_SHEET_EXCEPTIONS_COST` / `*_RANGE_EXCEPTIONS_COST`  
  Planilha + range com exceções de **custo adicional** por SKU (opcional).  
  Se estiverem vazios ou não configurados, **nenhuma exceção de custo** será aplicada.

- `*_ID_SHEET_EXCEPTIONS_TAX` / `*_RANGE_EXCEPTIONS_TAX`  
  Planilha + range com exceções de **imposto** por SKU (opcional).  
  Se não configurados, o sistema usa apenas o imposto padrão da empresa.

- `*_DATE_RANGE_DAYS`  
  Permite sobrescrever a janela de dias **por empresa**.  
  Se não definido, cai em `DATE_RANGE_DAYS`.

- `*_TOKEN_QUERY_ML` / `*_TOKEN_QUERY_MT`  
  Query SQL que deve retornar **exatamente 1 linha** de `tokens.credentials` com pelo menos a coluna `access_token`.  
  Exemplo:
  ```sql
  SELECT * 
  FROM tokens.credentials 
  WHERE company = 'ltsports' 
    AND provider = 'meli' 
    AND env = 'dev' 
  LIMIT 1;
  ```

---

## Configuração do Google Sheets

### Service Account e credenciais

1. Crie um projeto no **Google Cloud Console**.
2. Ative a API **Google Sheets**.
3. Crie uma **Service Account**.
4. Gere uma chave JSON para ela.
5. Salve o arquivo JSON em:
   ```text
   src/credentials/cred.json
   ```
6. Compartilhe as planilhas (principal e exceções) com o e-mail da Service Account com pelo menos permissão de **leitura**.

> ⚠️ `src/credentials/cred.json` está no `.gitignore` e **não deve ser commitado**.

---

### Formato da planilha principal (ID_SHEET + RANGE)

A planilha principal é usada apenas para capturar o **imposto padrão da empresa**.

- Range exemplo: `'Table'!D12` ou `'Table'!E12`.
- O código lê:

```js
const rows = await readSheetData(company.idSheet, company.range);
const impostoPadrao = rows[0][0];
```

Ou seja:

- A célula **superior esquerda** do range (`rows[0][0]`) deve conter **uma porcentagem de imposto**, por exemplo:
  - `"20,00%"`,
  - `"15%"`,
  - `"18,5"` (também será aceito, pois o código limpa `%` e troca `,` por `.`).

O restante da planilha principal pode ter qualquer layout; este serviço não usa as demais colunas/linhas.

---

### Formato da planilha de exceções de CUSTO

Essa planilha é opcional e serve para aplicar um **acréscimo de custo** por SKU em cima do `preco_de_custo` do banco.

- Exemplo de range:  
  `LT_RANGE_EXCEPTIONS_COST='Custo Lucas [LT][Excecao]'!A2:C`

Recomendação de colunas:

| Coluna | Conteúdo                          | Uso no código                       |
|--------|-----------------------------------|-------------------------------------|
| A      | `SKU` (ex.: `JP3735`)            | Usado para localizar o produto.     |
| B      | Nome/descrição (informativo)     | Ignorado pelo código (apenas visual)|
| C      | Acréscimo de custo em %          | Usado como `tax_aditional`.         |

Internamente, o código faz:

```js
const custoAdicionalExecao = await readSheetData(idSheetCost, rangeCost);
custoMap = custoAdicionalExecao.map(item => ({
  sku: item[0],          // Coluna A
  tax_aditional: item[2] // Coluna C
}));
```

E ao calcular o custo:

```js
const raw = String(custoFinded.tax_aditional)
  .replace('%', '')
  .replace(',', '.');

const extraTax = Number(raw) / 100;
precoDeCusto = +(precoDeCusto * (1 + extraTax)).toFixed(2);
```

Ou seja:

- Se `preco_de_custo` no banco é `100,00` e na planilha estiver `"18,00%"`, o custo final enviado ao Mercado Turbo será:  
  `100 * (1 + 0.18) = 118,00`.

Se o SKU não estiver nesta planilha, **nenhuma exceção de custo** é aplicada.

---

### Formato da planilha de exceções de IMPOSTO

Essa planilha também é opcional e serve para sobrescrever/ajustar o **imposto por SKU**.

- Exemplo de range:  
  `LT_RANGE_EXCEPTIONS_TAX='Imposto Lucas [LT][Excecao]'!A2:O`

Mapeamento de colunas (com base no código):

| Coluna | Índice | Conteúdo                | Uso no código                                      |
|--------|--------|-------------------------|----------------------------------------------------|
| A      | 0      | `SKU`                   | Chave para localizar o produto.                   |
| B      | 1      | Nome/descrição          | Apenas informativo.                                |
| C      | 2      | `ICMS` (%)              | Somado ao imposto final.                          |
| D      | 3      | `Fixo` (%)              | Somado ao imposto final.                          |
| E      | 4      | `PIS` (%)               | Somado ao imposto final.                          |
| F      | 5      | `COFINS` (%)            | Somado ao imposto final.                          |
| ...    | 6–13   | Outras colunas livres   | Ignoradas pelo código.                            |
| O      | 14     | `newTaxSheet` (%)       | Imposto base ajustado para o SKU específico.      |

Trecho relevante:

```js
const taxAdicionalExecao = await readSheetData(idSheetTax, rangeTax);
taxMap = taxAdicionalExecao.map(item => ({
  sku: item[0],
  produto: item[1],
  icms: item[2],
  fixo: item[3],
  pis: item[4],
  cofins: item[5],
  newTaxSheet: item[14]
}));
```

E o cálculo:

```js
let taxSheet = objTax[company.name]; // imposto padrão (rows[0][0])

if (taxMap.length > 0) {
  const taxFinded = taxMap.find(t => t.sku === sku);
  if (taxFinded) {
    const taxSheetNum = parseFloat(taxSheet.replace(',', '.').replace('%', ''));
    const newTaxSheet = parseFloat(taxFinded.newTaxSheet.replace(',', '.').replace('%', ''));
    const icmsNum = parseFloat(taxFinded.icms.replace(',', '.').replace('%', ''));
    const fixoNum = parseFloat(taxFinded.fixo.replace(',', '.').replace('%', ''));
    const pisNum = parseFloat(taxFinded.pis.replace(',', '.').replace('%', ''));
    const cofinsNum = parseFloat(taxFinded.cofins.replace(',', '.').replace('%', ''));

    taxSheet = (newTaxSheet + icmsNum + fixoNum + pisNum + cofinsNum).toFixed(2);
  }
}
```

Portanto:

- **Se o SKU não está na planilha de exceções** → usa apenas o imposto padrão da empresa (`rows[0][0]` da planilha principal).
- **Se está** → o imposto final da planilha se torna:  
  `newTaxSheet + ICMS + Fixo + PIS + COFINS` (todos em %).

Mais adiante, esse imposto é somado ao TACOS para formar o imposto enviado ao Mercado Turbo.

---

### O que fazer se as planilhas não funcionarem

Se algo der errado na parte de Sheets (valores estranhos, imposto zerado, erro de formato etc.), siga este checklist:

1. **Verifique o acesso da Service Account**
   - No Google Sheets, abra cada planilha (principal e exceções).
   - Confirme que a Service Account está listada em **Compartilhar** com pelo menos leitura.

2. **Cheque os IDs e RANGES no `.env`**
   - Certifique-se de que:
     - `*_ID_SHEET` é o ID correto da planilha (a parte entre `/d/` e `/edit` na URL).
     - `*_RANGE` aponta para o local certo (por exemplo `'Imposto Lucas [LT][Excecao]'!A2:O`).
   - Um range errado pode fazer o código ler **células vazias**.

3. **Valide os formatos numéricos**
   - Os campos percentuais podem estar como:
     - `"18,00%"`, `"18%"`, `"18,5"`, `"18.5"`, `"18"`.
   - O código remove `%` e troca `,` por `.` antes de converter.  
   - Evite strings com texto adicional tipo `"18% (ICMS)"`.

4. **Confirme se há dados no range**
   - A planilha principal lê `rows[0][0]`.  
     Se o range começar em uma linha vazia, o imposto padrão será vazio.
   - As planilhas de exceção têm header geralmente na linha 1 e dados a partir da linha 2.  
     O range deve começar na **linha dos dados**, não no cabeçalho.

5. **Checar os SKUs**
   - Os SKUs nas planilhas de exceção devem bater com:
     - `codigo_sku` no banco (`tiny.produtos`).
     - `SELLER_SKU` configurado nos anúncios do Mercado Livre.
   - Espaços extras, letras minúsculas vs maiúsculas e caracteres adicionais podem fazer o match falhar.

6. **Olhar os logs**
   - O script loga:
     - `Impostos capturados: { ... }`
     - Mensagens como `SKU XXX sem preco_de_custo.`
   - Se necessário, coloque logs adicionais ao redor da leitura das planilhas para inspecionar `rows`.

7. **Isolar o problema**
   - Você pode rodar um teste rápido no Node REPL:
     ```js
     import { sheetsService, config } from './src/index.js';

     const company = config.objCompanies.find(c => c.name === 'ltsports');
     const rows = await sheetsService.readSheetData(company.idSheet, company.range);
     console.log(rows);
     ```
   - Isso ajuda a confirmar se a leitura da planilha está correta **antes** de chamar Mercado Livre / Mercado Turbo.

---

## Banco de dados esperado

### Tabela `tiny.produtos`

A tabela deve conter ao menos:

- `codigo_sku` – SKU do produto.
- `descricao` – descrição / nome.
- `preco_de_custo` – custo base (preferencial).
- `preco` – preço (usado como fallback se `preco_de_custo` estiver 0).
- `tipo_do_produto` – usado pelo `getAllProducts` para ignorar produtos pai (`'V'`).

Outras colunas são usadas para filtros e debug, mas o essencial para este serviço é:

- Conseguir buscar o produto via:

  ```js
  await searchProducts({ filters: { codigo_sku: 'JP3735' } }, poolName);
  ```

- Ter um custo de referência (`preco_de_custo` ou `preco`).

### Tabela `tokens.credentials`

O serviço espera que esta tabela armazene tokens de acesso de **Meli** e **Mercado Turbo**.  
Os exemplos de queries no `.env` são:

```sql
SELECT *
FROM tokens.credentials
WHERE company = 'ltsports'
  AND provider = 'meli'
  AND env = 'dev'
LIMIT 1;
```

Requisitos mínimos:

- A query deve retornar **1 linha**.
- Essa linha deve ter pelo menos a coluna:
  - `access_token` – o token atual.

O serviço ainda possui helpers `getNewAccessTokenMl` / `getNewAccessTokenMt` que **sempre** fazem uma nova leitura no banco quando precisam renovar o token (em respostas 401/403 das APIs).

---

## Como executar o projeto

### Execução manual

1. Instale as dependências:

   ```bash
   npm install
   ```

2. Garanta que:

   - `.env` está preenchido corretamente.
   - `src/credentials/cred.json` existe e contém a Service Account válida.
   - O banco PostgreSQL está acessível.

3. Execute:

   ```bash
   npm start
   ```

   Isso simplesmente roda:

   ```json
   "start": "node ./src/main.js"
   ```

4. O script irá:

   - Montar `objCompanies` e validar variáveis obrigatórias.
   - Para cada empresa ativa:
     - Ler imposto padrão via Google Sheets.
     - Buscar anúncios no Mercado Livre (janela de `DATE_RANGE_DAYS` / `*_DATE_RANGE_DAYS`).
     - Agregar métricas por SKU e calcular TACOS.
     - Consultar o banco para obter custo (e aplicar exceções de custo/imposto).
     - Enviar o custo + imposto para o Mercado Turbo em **chunks** (por padrão: 50 SKUs por chunk).

5. Resultado:

   - Em caso de sucesso, o processo finaliza com `process.exit(0)`.
   - Se houver falhas que o código considera críticas, o processo loga o erro e finaliza com `process.exit(1)`.

### Agendamento (cron, PM2, n8n)

Você pode integrar esse serviço em qualquer scheduler/orquestrador.

**Exemplo de cron (Linux):**

```cron
0 3 * * * cd /caminho/para/JauPesca-Impostos-MercadoTurbo && /usr/bin/node ./src/main.js >> logs/mt-sync.log 2>&1
```

**Exemplo com PM2:**

```bash
pm2 start src/main.js --name "impostos-mercadoturbo"
```

**Exemplo com n8n:**

- Use um node **Execute Command**:
  ```bash
  node /caminho/para/JauPesca-Impostos-MercadoTurbo/src/main.js
  ```
- Ou encapsule esse serviço numa rota HTTP em outro projeto e chame via **HTTP Request**.

---

## Detalhe do fluxo de cálculo

Resumindo as principais funções do `src/main.js`:

1. **`_mountObjCompanies()`**
   - Para cada empresa em `config.objCompanies`:
     - Executa `queryTokenMl` e `queryTokenMt` no banco.
     - Monta funções `getNewAccessTokenMl` e `getNewAccessTokenMt`.
     - Descobre o `advertiser_id` no Mercado Livre via `meli.get_advertiser_id`.
     - Retorna um array de empresas com todos esses dados.

2. **`_defineTax(objCompanies)`**
   - Para cada empresa:
     - Lê a planilha principal (`idSheet`, `range`).
     - Captura `rows[0][0]` como **imposto padrão**.
   - Retorna um objeto:
     ```js
     { ltsports: '20,00%', jaufishing: '15,00%', ... }
     ```

3. **`_listProductsMeli(company, chunk)`**
   - Calcula `date_from` / `date_to` com base em `company.dateRangeDays`.
   - Chama `get_metrics_pub` em páginas (chunk de até 300 anúncios, no código atual).
   - Junta todos os resultados em uma lista bruta por anúncio (MLB).

4. **`_get_sku_by_list(company, list, chunkSize)`**
   - Para cada anúncio (MLB):
     - Chama `get_infos_by_mlb` para descobrir o `SELLER_SKU`.
   - Ignora itens sem SKU ou com `/` no SKU.
   - Agrega por SKU:
     - Soma `cost` (gasto em anúncios).
     - Soma `total_amount + organic_units_amount`.
   - Calcula **TACOS** por SKU:
     ```js
     tacos = (totalCost / totalAmount) * 100;
     ```
   - Retorna:
     ```js
     [{ sku: 'JP3735', tacos: 12.34 }, ...]
     ```

5. **`_get_price_cost(company, list, chunkSize, objTax)`**
   - Lê planilha de exceções de **custo** (se configurada).
   - Lê planilha de exceções de **imposto** (se configurada).
   - Para cada SKU:
     - Busca o produto no banco via `searchProducts({ filters: { codigo_sku: item.sku } })`.
     - Define `precoDeCusto` como:
       - `preco_de_custo`, se diferente de 0; senão `preco`.
     - Aplica exceção de custo (se houver):
       - `precoDeCusto *= (1 + tax_aditional%)`.
     - Define `taxSheet`:
       - Padrão = imposto da empresa (`objTax[company.name]`).
       - Se houver registro em exceções de imposto:
         - `taxSheet = newTaxSheet + icms + fixo + pis + cofins`.

   - Em seguida:
     - Busca **todos** os produtos do banco via `getAllProducts`.
     - Junta `produtos do banco` + `SKUs com anúncio`.
     - Remove duplicados por SKU e objetos vazios.
     - Para produtos que **não apareceram** nos anúncios:
       - Cria entrada com:
         - `tacos = 0`, imposto padrão da empresa, custo do banco.

6. **`_update_price_cost_tax(company, list, chunkSize, maxRetries, retryDelayMs)`**
   - Divide a lista em chunks (no `start()` está com `chunkSize = 50`).
   - Para cada item da chunk:
     - Calcula o imposto final enviado ao MT:
       ```js
       const tax = (
         parseFloat(item.tacos) +
         parseFloat(item.tax_sheet)
       ).toFixed(2);
       ```
       (ambos em %).
     - Monta payload:
       ```js
       {
         sku: item.sku,
         preco_de_custo: item.preco_de_custo,
         tax
       }
       ```
     - Chama `metu.update_cost_tax(access_token, sku, preco_de_custo, tax)`.

   - Em caso de 5xx ou erros de rede, re-tenta a chunk até `maxRetries`.

---

## Adicionando uma nova empresa

Para adicionar outra empresa (por exemplo `JW`):

1. Adicione ao `.env`:
   ```ini
   ACTIVE_COMPANIES=LT,JF,JW
   ```

2. Crie as variáveis:

   ```ini
   JW_NAME=jwexemplo

   JW_ID_SHEET=CHANGE_ME_JW_SHEET_ID
   JW_RANGE='Table'!D12

   JW_ID_SHEET_EXCEPTIONS_COST=CHANGE_ME_JW_SHEET_EXC_COST_ID
   JW_RANGE_EXCEPTIONS_COST='Custo Lucas [JW][Excecao]'!A2:C

   JW_ID_SHEET_EXCEPTIONS_TAX=CHANGE_ME_JW_SHEET_EXC_TAX_ID
   JW_RANGE_EXCEPTIONS_TAX='Imposto Lucas [JW][Excecao]'!A2:O

   JW_DATE_RANGE_DAYS=10

   JW_TOKEN_QUERY_ML=SELECT * FROM tokens.credentials WHERE company = 'jwexemplo' AND provider = 'meli' AND env = 'dev' LIMIT 1
   JW_TOKEN_QUERY_MT=SELECT * FROM tokens.credentials WHERE company = 'jwexemplo' AND provider = 'metu' AND env = 'dev' LIMIT 1

   JW_DB_HOST=...
   JW_DB_PORT=...
   JW_DB_USER=...
   JW_DB_PASSWORD=...
   JW_DB_DATABASE=...
   JW_DB_SSL=false
   ```

3. Garanta que:
   - A empresa tem tokens configurados em `tokens.credentials`.
   - As planilhas existem e foram compartilhadas com a Service Account.
   - O banco da empresa (`JW_DB_*`) tem a tabela `tiny.produtos` preenchida.

Nenhum código adicional é necessário: o `config.js` monta tudo dinamicamente com base em `ACTIVE_COMPANIES`.

---

## Resolução de problemas comuns

- **Erro: `Credentials file not found.`**
  - Verifique se `src/credentials/cred.json` existe e é um JSON válido.

- **Erro: `ACTIVE_COMPANIES environment variable is not set.`**
  - Defina `ACTIVE_COMPANIES` no `.env`.

- **Erro: `Missing or invalid environment variables for company`**
  - Alguma das variáveis obrigatórias (`*_NAME`, `*_ID_SHEET`, `*_RANGE`, `*_DATE_RANGE_DAYS`, `*_TOKEN_QUERY_*`) está faltando ou inválida.
  - O log mostra quais chaves estão faltando.

- **Erro: `[ML] Nenhum access_token encontrado no banco`**
  - A query `*_TOKEN_QUERY_ML` não retornou nenhuma linha, ou a linha não tem `access_token`.
  - Corrija a query ou insira/atualize o registro na tabela `tokens.credentials`.

- **Erro: `[MT] Nenhum access_token encontrado no banco`**
  - Mesma ideia, porém para o Mercado Turbo.

- **Erros 429 (rate limit) do Mercado Livre / Mercado Turbo**
  - O código já trata 429 com backoff progressivo.
  - Se mesmo assim continuar, pode ser necessário:
    - Reduzir `chunkSize` em `_listProductsMeli`, `_get_price_cost` ou `_update_price_cost_tax`.
    - Aumentar o intervalo entre execuções no cron.

- **Produtos sem `preco_de_custo`**
  - O log mostra avisos: `SKU XXX sem preco_de_custo.`
  - Preencha o custo no Tiny/espelho ou trate manualmente no banco.

- **Nenhuma métrica retornada do Mercado Livre**
  - Verifique:
    - Se os anúncios estão ativos.
    - Se a janela de datas (`DATE_RANGE_DAYS` / `*_DATE_RANGE_DAYS`) está apropriada.
    - Se o token ML tem permissão na Advertising API.

---

## Licença

Este projeto está licenciado sob a licença **ISC**, conforme definido em `package.json`.
