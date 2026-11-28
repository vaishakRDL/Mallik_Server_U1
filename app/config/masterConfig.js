// Configuration for different master types used in Bulk Update and Excel Loading

const normCode = (code) => String(code).trim().toUpperCase();
const hasCode = (row) => row.id && row.itemCode !== undefined && row.itemCode !== null && String(row.itemCode).trim() !== '';

/*
 * Item codes must stay unique among active items (same rule as item add/edit).
 * Returns Map<row, message> for rows whose new itemCode
 *   - is given to more than one item in this upload, or
 *   - is already used by another active item that keeps it (a code freed by a rename
 *     in the same upload is allowed, so codes can be swapped).
 */
const findItemCodeConflicts = async (conn, data) => {
    const conflicts = new Map();
    const rows = data.filter(hasCode);
    if (!rows.length) return conflicts;

    const newCodeById = new Map();   // itemId -> new code (normalised)
    const rowsById = new Map();      // itemId -> rows in this upload
    for (const row of rows) {
        const id = String(row.id);
        newCodeById.set(id, normCode(row.itemCode));
        if (!rowsById.has(id)) rowsById.set(id, []);
        rowsById.get(id).push(row);
    }

    const idsByCode = new Map();     // code -> item ids taking it in this upload
    for (const [id, code] of newCodeById) {
        if (!idsByCode.has(code)) idsByCode.set(code, new Set());
        idsByCode.get(code).add(id);
    }

    const flag = (id, message) => rowsById.get(id).forEach((row) => conflicts.set(row, message));

    // 1) Same code for two different items in this upload
    for (const [code, ids] of idsByCode) {
        if (ids.size > 1) {
            ids.forEach((id) => flag(id, `Item Code "${code}" is given to more than one item in this upload`));
        }
    }

    // 2) Code already held by another active item
    const codes = [...idsByCode.keys()];
    for (let i = 0; i < codes.length; i += 5000) {
        const [existing] = await conn.query(
            `SELECT id, itemCode FROM items WHERE dflag = 0 AND itemCode IN (?)`,
            [codes.slice(i, i + 5000)]
        );

        for (const holder of existing) {
            const holderId = String(holder.id);
            const code = normCode(holder.itemCode);

            // Holder gets a different code in this same upload → its old code is free
            const holderNewCode = newCodeById.get(holderId);
            if (holderNewCode !== undefined && holderNewCode !== code) continue;

            for (const id of idsByCode.get(code) || []) {
                if (id !== holderId && !conflicts.has(rowsById.get(id)[0])) {
                    flag(id, `Item Code "${holder.itemCode}" already exists for another item`);
                }
            }
        }
    }

    return conflicts;
};

const MASTER_CONFIG = {
    itemMaster: {
        tableName: 'items',
        primaryKey: 'id',
        fields: [
            'itemCode', 'itemName', 'itemGroup', 'inActive', 'uom', 'stdRate', 'gstCategory',
            'minStockLvl', 'maxLvl', 'underLedger', 'reorder', 'rol', 'roq', 'shelfLifeItem',
            'hsnCode', 'critical', 'mainLocation', 'productFinish', 'productFamily',
            'category', 'fimId', 'grossWeight', 'netWeight', 'scrapWeight',
            'rmItemCode', 'rmThickness', 'rmWidth', 'rmLength',
            'stockControl', 'material', 'materialThickness', 'jcPart', 'nonStockable'
        ],
        booleanFields: ['inActive', 'nonStockable'],
        fkMappings: {
            itemGroup: { table: 'mst_item_group', label: 'Item Group' },
            uom: { table: 'mst_uom', label: 'UOM' },
            hsnCode: { table: 'item_hsn_code', label: 'HSN' },
            mainLocation: { table: 'item_main_loc', label: 'Location' },
            productFinish: { table: 'item_product_finish', label: 'Finish' },
            productFamily: { table: 'item_product_family', label: 'Product Family' },
            fimId: { table: 'item_fim_id', label: 'FIM' },
            underLedger: { table: 'item_under_ledger', label: 'Ledger' }
        },
        // Excel preview: mark duplicate item codes as row errors
        validateBatch: async (conn, data) => {
            const conflicts = await findItemCodeConflicts(conn, data);
            conflicts.forEach((message, row) => {
                row.status = 'ERROR';
                row.errors.push(message);
            });
        },
        // Before the update (inside the transaction): block duplicate codes and note renamed items
        preUpdate: async (conn, data, ctx) => {
            const { CustomError } = require('./dbSql');

            const conflicts = await findItemCodeConflicts(conn, data);
            if (conflicts.size) {
                const messages = [...new Set(conflicts.values())];
                const more = messages.length > 5 ? ` (and ${messages.length - 5} more)` : '';
                throw new CustomError(`Duplicate item codes: ${messages.slice(0, 5).join('; ')}${more}`, 400);
            }

            const rows = data.filter(hasCode);
            if (!rows.length) return;

            const oldCodeById = new Map();
            const ids = [...new Set(rows.map((r) => r.id))];
            for (let i = 0; i < ids.length; i += 5000) {
                const [current] = await conn.query(`SELECT id, itemCode FROM items WHERE id IN (?)`, [ids.slice(i, i + 5000)]);
                current.forEach((r) => oldCodeById.set(String(r.id), r.itemCode));
            }

            ctx.renamedItemIds = [...new Set(rows
                .filter((r) => oldCodeById.has(String(r.id)) && normCode(oldCodeById.get(String(r.id)) || '') !== normCode(r.itemCode))
                .map((r) => r.id))];
        },
        postUpdate: async (conn) => {
            const { incCacheVersion } = require('../controllers/itemController');
            await incCacheVersion();
        },
        // After commit: rebuild the search index for items whose code changed
        afterCommit: async (ctx) => {
            if (!ctx.renamedItemIds?.length) return;
            const { reindexItemsById } = require('../controllers/itemController');
            await reindexItemsById(ctx.renamedItemIds);
        }
    },
    bom: {
        tableName: 'bom',
        primaryKey: 'id',
        trackUpdates: false,
        fields: ['Qty', 'jcPart'],
        excelAliases: {
            'bomitemcode': 'mainItemCode',
            'itemcode': 'childItemCode'
        },
        validateRow: (rowData) => {
            if (!rowData.mainItemCode || !rowData.childItemCode) {
                if (!rowData.id) {
                    rowData.status = 'ERROR';
                    rowData.errors.push("BOM Item Code and Item Code are required");
                }
            }
        },
        resolveId: async (conn, data) => {
            const pairs = data.filter(r => r.mainItemCode && r.childItemCode && !r.id);
            if (pairs.length === 0) return;

            const chunkArray = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));

            // Fetch main item IDs
            const mainCodes = [...new Set(pairs.map(r => r.mainItemCode))];
            const mainMap = new Map();
            if (mainCodes.length > 0) {
                for (const chunk of chunkArray(mainCodes, 5000)) {
                    const [rows] = await conn.query('SELECT id, itemCode FROM bom_mst WHERE itemCode IN (?)', [chunk]);
                    rows.forEach(r => mainMap.set(r.itemCode, r.id));
                }
            }

            // Fetch child item IDs
            const childCodes = [...new Set(pairs.map(r => r.childItemCode))];
            const childMap = new Map();
            if (childCodes.length > 0) {
                for (const chunk of chunkArray(childCodes, 5000)) {
                    const [rows] = await conn.query('SELECT id, itemCode FROM items WHERE itemCode IN (?)', [chunk]);
                    rows.forEach(r => childMap.set(r.itemCode, r.id));
                }
            }

            const bomLookups = [];
            for (const row of pairs) {
                const mstId = mainMap.get(row.mainItemCode);
                const itemId = childMap.get(row.childItemCode);
                if (mstId && itemId) {
                    bomLookups.push({ row, mstId, itemId });
                } else {
                    row.status = 'ERROR';
                    row.errors.push(`Main or Child item not found in master.`);
                }
            }

            if (bomLookups.length === 0) return;

            // Highly Optimized ID resolution:
            // Instead of tuple IN clauses which are slow in MySQL, fetch all BOMs for the involved main items.
            const uniqueMstIds = [...new Set(bomLookups.map(l => l.mstId))];
            const bomMap = new Map();
            
            for (const chunk of chunkArray(uniqueMstIds, 2000)) {
                const [bomRows] = await conn.query(`SELECT id, bomMstId, itemId FROM bom WHERE bomMstId IN (?)`, [chunk]);
                bomRows.forEach(r => bomMap.set(`${r.bomMstId}-${r.itemId}`, r.id));
            }

            for (const lookup of bomLookups) {
                const key = `${lookup.mstId}-${lookup.itemId}`;
                const bomId = bomMap.get(key);
                if (bomId) {
                    lookup.row.id = bomId;
                } else {
                    lookup.row.status = 'ERROR';
                    lookup.row.errors.push(`BOM record not found for this main-child combination.`);
                }
            }
        }
    }
};

// --- DYNAMIC REGISTRATION FOR SIMPLE MASTERS ---
const generalMasters = require('../utility/master').collection;
const itemMasters = require('../utility/itemMaster').collection;

const generalFieldsMap = {
    currency: ['code', 'name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    customerGroup: ['code', 'name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    pm: ['code', 'name', 'vendorProcess', 'inactiveStatus', 'inactiveRemarks', 'description'],
    machine: ['code', 'name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    role: ['code', 'name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    department: ['code', 'name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    sp: ['code', 'name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    dtr: ['code', 'name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    section: ['name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    city: ['code', 'countryId', 'stateId', 'name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    state: ['code', 'countryId', 'name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    country: ['code', 'name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    supplierGroup: ['code', 'name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    tool: ['code', 'name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    uom: ['code', 'name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    supplyType: ['name', 'description'],
    gstinOrUin: ['name', 'description'],
    placeOfSupply: ['name', 'description', 'stateCode'],
    designation: ['code', 'name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    itemGroup: ['code', 'name', 'inactiveStatus', 'inactiveRemarks', 'description', 'chapterHdr', 'isstoreGroup'],
    tarrif: ['code', 'name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    trf: ['code', 'name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    orderType: ['orderType', 'description'],
    menu: ['type', 'code', 'name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    location: ['country', 'state', 'city', 'description'],
    displayName: ['code', 'name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    inspectionLevel: ['code', 'name', 'inactiveStatus', 'inactiveRemarks', 'description'],
    problemCategory: ['name', 'description'],
    natureOfProblem: ['name', 'description'],
};

const itemMastersFieldsMap = {
    underLedger: ['code', 'name', 'description'],
    reorder : ['name', 'description'],
    mainLocation : ['name', 'description'],
    hsnCode : ['name', 'description'],
    subLocation : ['name', 'description'],
    productFinish : ['name', 'description'],
    productFamily : ['name', 'description'],
    category : ['name', 'description'],
    fim : ['name', 'description', 'packingCharge'],
    rmItemcode : ['name', 'description'],
    product: ['name', 'description']
};

Object.keys(generalFieldsMap).forEach(key => {
    if (generalMasters[key]) {
        MASTER_CONFIG[key] = {
            tableName: generalMasters[key].tbName,
            primaryKey: 'id',
            trackUpdates: false,
            fields: generalFieldsMap[key]
        };
    }
});

Object.keys(itemMastersFieldsMap).forEach(key => {
    if (itemMasters[key]) {
        MASTER_CONFIG[key] = {
            tableName: itemMasters[key].tbName,
            primaryKey: 'id',
            trackUpdates: false,
            fields: itemMastersFieldsMap[key]
        };
    }
});

module.exports = MASTER_CONFIG;
