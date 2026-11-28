const { connection, CustomError, handleErrorResponse } = require('../config/dbSql');
const { generateDocNo, updateDocCounter } = require('../utility/docNo');
const { storeSfg } = require('./allocateController');
const { jobCardPlanning, childPartPlanning } = require('./planningController');
const { shopFloorSchedule, aggregateChildCounts } = require('./scheduleController');
const { storeRequestNote } = require('./storeReqController');

const npdItemsCheck = async (opId, db = connection) => {
    try {
        const [orderRows] = await db.execute(`SELECT itemCode FROM orderlist WHERE orderPlnId = ?`, [opId]);
        if (orderRows.length === 0) throw new CustomError(`Items not found!`);

        const itemCodes = orderRows.map(row => row.itemCode);
        const placeholders = itemCodes.map(() => '?').join(',');

        const [itemRows] = await db.execute(`SELECT itemCode FROM items WHERE itemCode IN (${placeholders})`, itemCodes);

        if (itemRows.length !== itemCodes.length) {
            throw new CustomError(`Npd Items are not registered!`, 400);
        }

        return true;
    } catch (err) {
        throw err;
    }
}

// `db`: the MRP transaction's connection. The order row is read with FOR UPDATE, so a second
// request for the same order waits here and then sees mrpStatus = 1 (no double generation).
exports.fetchSobItems = async (opId, db = connection) => {
    try {
        let isOrderInput = false;
        let isBatchProd = true;
        const lock = db === connection ? '' : ' FOR UPDATE';
        const [rows] = await db.execute(`SELECT * FROM order_plannings WHERE id = ?${lock}`, [opId]);

        if (rows.length === 0) throw new CustomError('Order Planing not found!', 404);

        const { mrpStatus, saleId, isNpd } = rows[0];

        if (mrpStatus === 1) throw new CustomError('MRP has already been generated for this order!', 400);

        if (isNpd) {
            await npdItemsCheck(opId, db);
        }

        if (saleId != null) {
            isOrderInput = true;
            const [OIRows] = await db.execute('SELECT id FROM sales WHERE id = ? AND isBatchProd = ?', [rows[0].saleId, 1]);
            if (!OIRows.length) {
                isBatchProd = false;
            }
        }

        const query = `SELECT ol.id, items.id as itemId, ol.sobMstId, ol.sOrderId, ol.itemCode, ol.Qty, ol.fimNo, ol.contractNo, items.jcPart FROM orderList ol
            INNER JOIN items ON items.itemCode = ol.itemCode
            WHERE ol.orderPlnId = ?
        `;
        const [cRows] = await db.execute(query, [opId]);

        return { isOrderInput, isBatchProd, rows, cRows };
    } catch (err) {
        throw err;
    }
}


// Store MRP data into the database
exports.storeMrp = async (conn, mrpMstId, sobList) => {
    try {
        //console.log('MRP insertion started...');

        // Aggregating quantities, orderIds, and contractNos by jcId and itemCode
        const aggregatedData = {};
        sobList.forEach(item => {
            const jcIdKey = item.jcId === null ? 'null' : item.jcId.toString();
            const key = `${jcIdKey}_${item.itemCode}`;
            if (!aggregatedData[key]) {
                aggregatedData[key] = {
                    mrpMstId,
                    orderPlnId: item.opId,
                    orderListId: new Set([item.orderId]),
                    contractNos: new Set([item.contractNo]),
                    jcId: item.jcId,
                    itemId: item.itemId,
                    itemCode: item.itemCode,
                    Qty: Number(item.Qty),
                    fim: item.fim,
                    jcPart: item.isJcPart
                };
            } else {
                aggregatedData[key].Qty += Number(item.Qty);
                aggregatedData[key].orderListId.add(item.orderId);
                aggregatedData[key].contractNos.add(item.contractNo);
            }
        });

        // Convert Sets to comma-separated strings
        Object.values(aggregatedData).forEach(item => {
            item.orderListId = Array.from(item.orderListId).join(',');
            item.contractNos = Array.from(item.contractNos).join(',');
        });

        // One multi-row insert instead of one query per row
        const rowsToInsert = Object.values(aggregatedData).map(item =>
            [item.mrpMstId, item.orderPlnId, item.orderListId, item.contractNos, item.jcId, item.itemId, item.itemCode, item.Qty, item.fim, item.jcPart]
        );

        let allSuccessful = true;
        if (rowsToInsert.length) {
            const [result] = await conn.query(
                'INSERT INTO mrp (mrpMstId, orderPlnId, orderListId, contractNos, jcId, itemId, itemCode, Qty, fim, jcPart) VALUES ?',
                [rowsToInsert]
            );
            allSuccessful = result.affectedRows === rowsToInsert.length;
        }

        if (allSuccessful) {
            //console.log('MRP insertion successful.');
            return true;
        } else {
            throw new CustomError("Failed to insert MRP data.", 500);
        }
    } catch (err) {
        //console.log('Error storing MRP data:', err);
        throw err; // Rethrow the caught error for further handling
    }
}

async function updateCounter(conn, counterType) {
    await conn.execute(`
        UPDATE counter SET number = number + 1 WHERE counterType = ?`,
        [counterType]
    );

    return true;
}

// Store Mst MRP
exports.storeMstMRP = async (conn, req, opRows) => {
    try {
        if (!opRows) {
            throw new CustomError('Order planings not found!', 404);
        }

        const data = opRows[0];
        const { uniqueNo: mrpNo } = await generateDocNo(conn, req, { docType: 'Mrp' });

        const insertQ = `INSERT INTO mrp_mst (mrpNo, orderPlnId, sobMstId, saleId, orderNo, poNo, requestedBy, requestedDate, customerId, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const values = [mrpNo, data.id, data.sobMstId || null, data.saleId || null, data.orderNo || null, data.poNo || null, data.requestedBy || null, data.devliveryDate || null, data.customerId || null, 'Processed']

        const [rRows] = await conn.execute(insertQ, values);

        if (rRows.affectedRows > 0) {
            return rRows.insertId;
        }

        throw new CustomError('Mrp Insertion failed!', 400);
    } catch (err) {
        throw err;
    }
}

exports.splitFim = async (fim) => {
    if (fim == null) {
        return;
    }
    const fimNo = fim.split('FIM');
    const finalFim = 'FIM' + fimNo[1];

    return finalFim;
}

exports.checkJcCondition = async (isBatchProd, itemCode, db) => {
    try {
        const categories = ['BUY LC-S', 'MAKE'];

        if (isBatchProd) categories.push('BUY PRODUCTION');
        const categoryPlaceholders = categories.map(() => '?').join(', ');

        let query = `SELECT id FROM items WHERE itemCode = ? AND inActive = 0 AND category IN (${categoryPlaceholders})`;
        const params = [itemCode, ...categories];

        if (isBatchProd) {
            query += ` AND jcPart = ?`;
            params.push('Y');
        }
        const [rows] = await (db || connection).execute(query, params);

        return rows.length > 0 ? rows[0].id : false;
    } catch (error) {
        throw error;
    }
};

// Same answer as checkJcCondition, asked once per item code per MRP run (read on the MRP's connection)
const isJcPart = (ctx, itemCode) => {
    if (!ctx.jcCache.has(itemCode)) {
        ctx.jcCache.set(itemCode, this.checkJcCondition(ctx.isBatchProd, itemCode, ctx.conn));
    }
    return ctx.jcCache.get(itemCode);
};

// BOM children of an item, read once per item code per MRP run
const bomChildren = (ctx, itemCode) => {
    if (!ctx.bomCache.has(itemCode)) {
        ctx.bomCache.set(itemCode, this.getBomChildren(ctx.conn, itemCode));
    }
    return ctx.bomCache.get(itemCode);
};

// exports.checkJcCondition = async (isBatchProd, itemCode) => {
//     try {
//         const categories = ['BUY LC-S', 'MAKE'];

//         if (isBatchProd) categories.push('BUY PRODUCTION');
//         const categoryPlaceholders = categories.map(() => '?').join(', ');

//         let query = `SELECT id FROM items WHERE itemCode = ? AND inActive = 0 AND category IN (${categoryPlaceholders})`;
//         const params = [itemCode, ...categories];

//         if (isBatchProd) {
//             query += ` AND (jcPart = 'Y' OR buyProdJC = 'Y')`;
//         } else {
//             query += ` AND buyProdJC = 'Y'`;
//         }
//         const [rows] = await connection.execute(query, params);

//         return rows.length > 0 ? rows[0].id : false;
//     } catch (error) {
//         throw error;
//     }
// };

// Revised MRP generation logic with duplicate JC creation prevention
exports.getJcNo = async (conn, req) => {
    try {
        const { padStartNo, uniqueNo } = await generateDocNo(conn, req, { docType: 'JobCard', customValue: '' });
        const docPrefix = uniqueNo.replace(padStartNo, '');
        return { docPrefix, incNo: Number(padStartNo) };
    } catch (err) {
        throw err;
    }
};

exports.storeJcPart = async (conn, orderId, mrpMstId, itemCode, orderQty, contractNo, docPrefix, uniqueNoRef) => {
    try {
        if (!itemCode) throw new CustomError("JC itemCode not provided!", 400);

        const [[existing]] = await conn.execute(
            'SELECT id, Qty, contractNos FROM job_card WHERE mrpMstId = ? AND itemCode = ?',
            [mrpMstId, itemCode]
        );

        if (existing) {
            const updatedQty = existing.Qty + Number(orderQty);
            const contractNos = new Set((existing.contractNos || '').split(',').filter(Boolean));
            if (contractNo) contractNos.add(contractNo);
            await conn.execute('UPDATE job_card SET Qty = ?, contractNos = ? WHERE id = ?', [updatedQty, [...contractNos].join(','), existing.id]);
            return existing.id;
        }

        const [[item]] = await conn.execute('SELECT id FROM items WHERE itemCode = ?', [itemCode]);
        if (!item) throw new CustomError(`ItemCode not found: ${itemCode}`, 404);

        const jcNo = `${docPrefix}${String(uniqueNoRef.value).padStart(5, '0')}`;
        if (jcNo.includes('undefined')) {
            throw new CustomError('Job Card Number generation failed!', 500);
        }

        const [result] = await conn.execute(
            'INSERT INTO job_card (mrpMstId, orderListId, jcNo, itemId, itemCode, Qty, contractNos) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [mrpMstId, orderId, jcNo, item.id, itemCode, orderQty, contractNo]
        );

        if (result.affectedRows) {
            uniqueNoRef.value++;
            return result.insertId;
        }

        throw new CustomError('Failed to insert job card!', 500);
    } catch (err) {
        throw err;
    }
};

exports.getBomChildren = async (conn, itemCode) => {
    const [rows] = await conn.execute(`
        SELECT bm.itemId AS mstPartId, b.*, i.isBom, i.itemName, i.itemCode 
        FROM bom_mst bm
        JOIN bom b ON b.bomMstId = bm.id
        JOIN items i ON i.id = b.itemId
        WHERE bm.itemCode = ? AND i.inActive = 0
    `, [itemCode]);

    return rows;
};

// `path`: item codes from the order line down to this item, used to stop a BOM that contains itself
exports.childItems = async (conn, ctx, parentQty, parentId, parentCode, alreadyCreated = false, path = [parentCode]) => {
    const rows = await bomChildren(ctx, parentCode);
    const childMrpList = [];

    if (!alreadyCreated && await isJcPart(ctx, parentCode)) {
        parentId = await this.storeJcPart(conn, ctx.orderId, ctx.mrpMstId, parentCode, parentQty, ctx.contractNo, ctx.docPrefix, ctx.uniqueNoRef);
    }

    for (const row of rows) {
        if (row.isBom === 'Y' && path.includes(row.itemCode)) {
            throw new CustomError(`BOM loop found: ${[...path, row.itemCode].join(' → ')}. Correct the BOM and try again.`, 400);
        }

        // A BOM line with quantity 0 / empty would create a job card with quantity 0: report it
        // (the whole MRP is stopped and rolled back after all lines are checked)
        const bomQty = Number(row.Qty);
        if (!(bomQty > 0)) {
            ctx.qtyErrors?.add(`BOM quantity is 0 for ${row.itemCode} in the BOM of ${parentCode}`);
            continue;
        }

        const childQty = parentQty * bomQty;
        const child = {
            opId: ctx.opId, orderId: ctx.orderId, jcId: parentId,
            itemId: row.itemId, itemCode: row.itemCode, Qty: childQty,
            fim: ctx.fim, contractNo: ctx.contractNo, isJcPart: row.jcPart
        };

        childMrpList.push(child);

        if (row.isBom === 'Y') {
            const nested = await this.childItems(conn, ctx, childQty, parentId, row.itemCode, false, [...path, row.itemCode]);
            childMrpList.push(...nested);
        } else if (await isJcPart(ctx, row.itemCode)) {
            await this.storeJcPart(conn, ctx.orderId, ctx.mrpMstId, row.itemCode, childQty, ctx.contractNo, ctx.docPrefix, ctx.uniqueNoRef);
        }
    }

    return childMrpList;
};

const calculateToProduce = (part, requestedQty, item) => {
    if (!item) {
        return { toProduce: 0, errorMsg: `${part} not found in inventory` };
    }

    if (item.stockControl === 'N') {
        // Stock control disabled → always produce requested qty
        return { toProduce: requestedQty, errorMsg: null };
    }

    if (Number(item.maxStock) === 0) {
        return {
            toProduce: 0,
            errorMsg: `${part}: Production not allowed (maxStock = 0)`
        };
    }

    let toProduce = 0;

    // Case 1: stock already below minStock → must produce everything
    if (Number(item.curStock) < Number(item.minStock)) {
        toProduce = requestedQty;
    } else {
        const usableStock = Number(item.curStock) - Number(item.minStock);

        if (requestedQty <= usableStock) {
            // Enough stock
            toProduce = 0;
            item.curStock -= requestedQty;
        } else {
            // Need to produce
            toProduce = requestedQty - usableStock;
            item.curStock = Number(item.minStock);
        }
    }

    // Final check: maxStock violation
    if (Number(item.curStock) + toProduce > Number(item.maxStock)) {
        return {
            toProduce: 0,
            errorMsg: `${part} exceeds max stock (${Number(item.maxStock)})`
        };
    }

    return { toProduce, errorMsg: null };
};

// Named MySQL lock that lets only one MRP generation run at a time
const MRP_LOCK = 'mallik_generate_mrp';
const MRP_LOCK_WAIT_SECONDS = 60;

// Mark the CSLs this order was built from as used (sobStatus = 1): the CSLs behind its SOB.
// Older orders whose SOB rows carry no CSL link keep the previous rule (today's open CSLs).
const markCslUsed = async (conn, opId) => {
    const [result] = await conn.execute(`
        UPDATE csl_mst SET sobStatus = 1
        WHERE sobStatus = 0
          AND id IN (
              SELECT cslMstId FROM (
                  SELECT DISTINCT s.cslMstId
                  FROM sob s
                  INNER JOIN order_plannings op ON op.sobMstId = s.sobMstId
                  WHERE op.id = ? AND s.cslMstId IS NOT NULL
              ) AS orderCsl
          )`,
        [opId]
    );

    if (result.affectedRows > 0) return;

    const [[linked]] = await conn.execute(`
        SELECT COUNT(*) AS n FROM sob s
        INNER JOIN order_plannings op ON op.sobMstId = s.sobMstId
        WHERE op.id = ? AND s.cslMstId IS NOT NULL`,
        [opId]
    );
    if (Number(linked.n) === 0) {
        await conn.execute(`UPDATE csl_mst SET sobStatus = 1 WHERE DATE(date) = CURDATE() AND sobStatus = 0`);
    }
};

exports.generateMRP = async (req, res) => {
    const conn = await connection.getConnection();
    let inTransaction = false;
    let hasMrpLock = false;

    try {
        await conn.beginTransaction();
        inTransaction = true;

        const { orderId: opId, kanbanDate, typeOfOrder } = req.body;
        if (!opId || !kanbanDate || !typeOfOrder) throw new CustomError('Missing required fields!', 400);

        // Take the locks before any other read, so every read below sees the latest committed data:
        //  - the order row: a second request for the same order (double-click, two users) waits, then
        //    gets "MRP has already been generated" instead of creating a second MRP
        //  - one MRP run at a time: two MRPs generated at the same moment take MRP / Job Card numbers one
        //    after the other instead of both getting the same numbers. A named lock is used so no
        //    document_counter rows are held and other screens' document numbers are never blocked.
        await conn.execute('SELECT id FROM order_plannings WHERE id = ? FOR UPDATE', [opId]);

        const [[{ locked }]] = await conn.query(`SELECT GET_LOCK(?, ?) AS locked`, [MRP_LOCK, MRP_LOCK_WAIT_SECONDS]);
        if (Number(locked) !== 1) {
            throw new CustomError('Another MRP is being generated right now. Please try again in a moment.', 409);
        }
        hasMrpLock = true;

        const { docPrefix, incNo } = await this.getJcNo(conn, req);
        const uniqueNoRef = { value: incNo };

        const { isOrderInput, isBatchProd, rows: opRows, cRows: sRows } = await this.fetchSobItems(opId, conn);
        if (!sRows.length) throw new CustomError('SOB items not found!', 404);

        const mrpMstId = await this.storeMstMRP(conn, req, opRows);
        const mrpList = [];

        const itemQuery = `SELECT id, stockControl, minStockLvl as minStock, maxLvl as maxStock, totStk as curStock FROM items WHERE id = ? AND inActive = 0`;
        const stockErrorMsg = [];

        // Stock is read once per item and reduced as order lines use it, so an item on two lines
        // cannot count the same stock twice
        const stockByItem = new Map();

        // Item lookups shared by every line of this run
        const jcCache = new Map();
        const bomCache = new Map();

        // Quantity 0 in a sales order line or in a BOM line (each reported once)
        const qtyErrors = new Set();

        for (const s of sRows) {
            let orderQty = s.Qty;

            // Sales order lines are not reduced by stock, so quantity 0 here is a data error
            if (isOrderInput && !(Number(s.Qty) > 0)) {
                qtyErrors.add(`Sales order quantity is 0 for ${s.itemCode}${s.contractNo ? ` (contract ${s.contractNo})` : ''}`);
                continue;
            }

            if (!isOrderInput) {
                if (!stockByItem.has(s.itemId)) {
                    const [[itemDetails]] = await conn.execute(itemQuery, [s.itemId]);
                    stockByItem.set(s.itemId, itemDetails);
                }
                const { toProduce, errorMsg } = calculateToProduce(s.itemCode, s.Qty, stockByItem.get(s.itemId));

                if (errorMsg) stockErrorMsg.push(errorMsg);
                orderQty = toProduce;

                // Stock covers this line: nothing to produce, so no job card or MRP rows with quantity 0
                if (!errorMsg && Number(orderQty) === 0) continue;
            }

            const fim = s.fimNo ? await this.splitFim(s.fimNo) : null;

            let jcId = null;
            const ctx = { conn, jcCache, bomCache, qtyErrors, isBatchProd, orderId: s.id, opId, mrpMstId, contractNo: s.contractNo, fim, docPrefix, uniqueNoRef };

            if (await isJcPart(ctx, s.itemCode)) {
                jcId = await this.storeJcPart(conn, s.id, mrpMstId, s.itemCode, orderQty, s.contractNo, docPrefix, uniqueNoRef);
            } else {
                mrpList.push({ opId, orderId: s.id, jcId, itemId: s.itemId, itemCode: s.itemCode, Qty: orderQty, fim, contractNo: s.contractNo, isJcPart: s.jcPart });
            }

            // Explode the BOM (an item without a BOM simply has no children)
            const children = await this.childItems(conn, ctx, orderQty, jcId, s.itemCode, true);
            mrpList.push(...children);
        }
        // Nothing is saved when any quantity or stock problem was found (all are listed together)
        const errors = [...qtyErrors, ...stockErrorMsg];
        if (errors.length) {
            throw new CustomError(errors.join('; '), 400);
        }

        // console.log(mrpList)
        //console.log('Total MRP items:', mrpList.length);
        const stored = await this.storeMrp(conn, mrpMstId, mrpList);

        if (stored) {
            await storeSfg(conn, mrpMstId);
            const srnMstId = await storeRequestNote(conn, req, opId, mrpMstId);
            await conn.execute(`UPDATE mrp_mst SET srnMstId = ? WHERE id = ?`, [srnMstId, mrpMstId]);

            await Promise.all([
                jobCardPlanning(conn, mrpMstId),
                childPartPlanning(conn, mrpMstId),
                shopFloorSchedule(conn, mrpMstId),
                conn.execute(
                    `UPDATE order_plannings SET typeOfOrder = ?, kanbanDate = ?, status = ?, mrpStatus = ? WHERE id = ?`,
                    [typeOfOrder, kanbanDate, 'MRP', 1, opId]
                ),
                !isOrderInput ? markCslUsed(conn, opId) : null,
                updateDocCounter(conn, 'Mrp'),
                conn.execute(
                    `UPDATE document_counter SET counter = ? WHERE docType = 'JobCard' ORDER BY id DESC LIMIT 1`,
                    [uniqueNoRef.value]
                )
            ]);

            // Aggregate child part counts into parent schedule by process
            await aggregateChildCounts(conn, mrpMstId);

            await conn.commit();
            return res.status(200).json({ success: true, message: "MRP generation successful" });
        }

        throw new CustomError('Failed to store MRP!', 500);
    } catch (err) {
        if (inTransaction) await conn.rollback().catch(() => { });
        return handleErrorResponse(res, err);
    } finally {
        // Released after commit/rollback, so the next run reads the counters this run saved.
        // The lock belongs to the connection, so it must be freed before the connection goes back to the pool.
        if (hasMrpLock) await conn.query(`SELECT RELEASE_LOCK(?)`, [MRP_LOCK]).catch(() => { });
        conn.release();
    }
};