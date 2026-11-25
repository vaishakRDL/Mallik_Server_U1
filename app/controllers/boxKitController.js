const { connection, barcodeDB, CustomError, handleSuccessResponse, handleErrorResponse } = require('../config/dbSql');

const utility = require('../utility/utilityFunction');
const path = require('path');


exports.getContract = async (req, res) => {
    try {

        // const id = req.params.id;

        const query = `
            SELECT  DISTINCT
             ContractNo
            FROM Barcode_CSL   
            `;

        const [rows] = await barcodeDB.execute(query, []);

        if (rows.length >= 0) {

            //Auto Index value
            rows.forEach((element, index) => {
                element.id = index + 1;
            });

            return res.status(200).json({
                success: true,
                message: "Contract list",
                data: rows
            });
        }
    } catch (err) {
        return res.status(err.statusCode || 500).json({ success: false, message: err.message || 'An error occured' });
    }
}



exports.getPart = async (req, res) => {
    try {

        const no = req.body.no;

        const query = `
            SELECT BOMPartNo, MIN(id) as id
            FROM Barcode_CSL
            WHERE ContractNo = ? AND BOMPartNo IS NOT NULL AND BOMPartNo != ''
            GROUP BY BOMPartNo
        
        `;

        const [rows] = await barcodeDB.execute(query, [no]);

        if (rows.length >= 0) {

            return res.status(200).json({
                success: true,
                message: "Assembly Parts list",
                data: rows
            });
        }
    } catch (err) {
        return res.status(err.statusCode || 500).json({ success: false, message: err.message || 'An error occured' });
    }
}



exports.upload = async (req, res) => {
    const conn = await connection.getConnection();
    await conn.beginTransaction();

    try {

        const kit = req.body;
        let contractNo, bomPart, flag;


        if (kit.txtField) {

            if (!kit.txtField.includes('-')) {
                throw new CustomError("Enter Specified AssemblyPart!.");
            }
            // Split the txtField value by the delimiter '-'
            const getPart = kit.txtField.split('-');

            // Get the first part of the split string
            contractNo = getPart[0];

            bomPart = kit.txtField;
            flag = 1;


        } else {

            contractNo = kit.contractNo;
            bomPart = kit.bomPart;
            flag = 0;
        }

        const fileName = utility.storeFileReq(kit.file, 'boxKit', bomPart);

        const storeQuery = 'INSERT INTO box_kit_files (contractNo,  BOMPartNo, txtFlag, file) VALUES (?, ?, ?, ?)';
        const values = [contractNo, bomPart, flag, fileName];

        const [sRows] = await connection.execute(storeQuery, values);

        await conn.commit();
        return handleSuccessResponse(res, "Image Uploaded Successfully.");
    } catch (err) {
        await conn.rollback();
        return handleErrorResponse(res, err);
    } finally {
        conn.release();
    }
};



exports.viewFile = async (req, res) => {
    try {

        const kit = req.body;

        // Get the local IP address
        const ipAddress = utility.getLocalIpAddress();

        // Get the port number from environment variables
        const port = process.env.APP_PORT || 8000;

        let query = `
            SELECT 
                box_kit_files.id, CONCAT('http://', ? , ':', ? , '/', box_kit_files.file) AS file_url
            FROM box_kit_files`;

        const params = [ipAddress, port];

        //if value uploaded through dropDown so  (txtFlag =0) 
        if (kit.contract && kit.bomPart) {
            query += ` WHERE contractNo = ? AND BOMPartNo LIKE ?`;
            params.push(kit.contract, `%${kit.bomPart}%`);


            //if value uploaded through TextField so  (txtFlag =1)  
        } else if (kit.bomPart) {
            query += ` WHERE BOMPartNo LIKE ?`;
            params.push(`%${kit.bomPart}%`);
        }


        const [rows] = await connection.execute(query, params);

        if (rows.length >= 0) {

            return res.status(200).json({
                success: true,
                message: "File",
                data: rows
            });
        }
    } catch (err) {
        return res.status(err.statusCode || 500).json({ success: false, message: err.message || 'An error occured' });
    }
}


//App
exports.view = async (req, res) => {
    try {

        const kit = req.body;

        let query = `
            SELECT 
                box_kit_files.id,  box_kit_files.file 
            FROM box_kit_files
            WHERE box_kit_files.BOMPartNo = ?`;

        const params = [kit.bomPart];

        const [rows] = await connection.execute(query, params);

        if (rows.length >= 0) {

            return res.status(200).json({
                success: true,
                message: "File",
                data: rows
            });
        }
    } catch (err) {
        return res.status(err.statusCode || 500).json({ success: false, message: err.message || 'An error occured' });
    }
}


//***********************************************************    BAR CODE       *************************************************************** */


/**
 * GET /boxKit/qcStatus?crNumber=..&fimNumber=..
 * Looks up assembly_qc_counts.qcStatus (0 or 1) for the given crNumber (contractNo) + fimNumber (fimNo).
 */
// exports.getQcStatus = async (req, res) => {
//     try {
//         const { crNumber, fimNumber } = req.query;
//         const isStr = (v) => typeof v === 'string' && v.trim() !== '';

//         if (!isStr(crNumber) || !isStr(fimNumber)) {
//             return res.status(400).json({
//                 success: false,
//                 message: 'crNumber and fimNumber query parameters are required',
//             });
//         }

//         const [rows] = await connection.query(
//             'SELECT qcStatus FROM assembly_qc_counts WHERE contractNo = ? AND fimNo = ?',
//             [crNumber, fimNumber]
//         );

//         if (!rows.length) {
//             return res.status(404).json({
//                 success: false,
//                 message: `No record found for crNumber ${crNumber} and fimNumber ${fimNumber}`,
//             });
//         }

//         return res.status(200).json({
//             success: true,
//             message: 'QC status',
//             qcStatus: rows[0].qcStatus,
//         });
//     } catch (err) {
//         return handleErrorResponse(res, err);
//     }
// };



exports.getQcStatus = async (req, res) => {
    try {
        const { crNumber, fimNumber } = req.query;
        const isStr = (v) => typeof v === 'string' && v.trim() !== '';

        if (!isStr(crNumber) || !isStr(fimNumber)) {
            return res.status(400).json({
                success: false,
                message: 'crNumber and fimNumber query parameters are required',
            });
        }

        const lookupQcStatus = async (fim) => {
            const [rows] = await connection.query(
                'SELECT qcStatus FROM assembly_qc_counts WHERE contractNo = ? AND fimNo = ?',
                [crNumber, fim]
            );
            return rows;
        };

        let rows = await lookupQcStatus(fimNumber);

        if (!rows.length) {
            // e.g. "LFIM4.4" / "ELFIM4.4" -> "FIM4.4": only when fimNumber is one
            // unbroken token (no spaces) do we strip the prefix before "FIM".
            const fimIndex = fimNumber.indexOf('FIM');
            if (fimIndex > 0 && !/\s/.test(fimNumber)) {
                rows = await lookupQcStatus(fimNumber.slice(fimIndex));
            }
        }

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: `No record found for crNumber ${crNumber} and fimNumber ${fimNumber}`,
            });
        }

        return res.status(200).json({
            success: true,
            message: 'QC status',
            qcStatus: rows[0].qcStatus,
        });
    } catch (err) {
        return handleErrorResponse(res, err);
    }
};




/**
 * API 1 — POST /boxKit/uploadeddata  (Barcode Kitting -> ERP)
 * Body:     [ BarcodeKittingInfo, ... ]
 * Response: { successList: [{crNumber, fimNumber}], failureList: [{crNumber, fimNumber, reason}] }
 */
exports.uploadedData = async function uploadedData(req, res) {
    const items = req.body;

    // Whole body must be a non-empty array, otherwise nothing is processed
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
            status: 'error',
            statusCode: 400,
            error: {
                timestamp: new Date().toISOString().slice(0, 19),
                status: 400,
                error: 'Bad Request',
                message: 'Request body must be a non-empty array of BarcodeKittingInfo',
            },
        });
    }

    const successList = [];
    const failureList = [];
    const isStr = (v) => typeof v === 'string' && v.trim() !== '';
    const isInt = (v) => Number.isInteger(v) && v >= 0;

    // Each CR + FIM is processed on its own: one bad item doesn't block the others
    for (const item of items) {
        const key = { crNumber: item?.crNumber ?? null, fimNumber: item?.fimNumber ?? null };

        // ---------- 1. validate this item ----------
        const errors = [];
        if (!isStr(item?.crNumber)) errors.push('crNumber is required');
        if (!isStr(item?.fimNumber)) errors.push('fimNumber is required');
        if (!isInt(item?.bomQty)) errors.push('bomQty must be a non-negative integer');

        const parts = Array.isArray(item?.partDetails) ? item.partDetails : [];
        if (!parts.length) errors.push('partDetails must be a non-empty array');

        const seen = new Set();
        parts.forEach((p, i) => {
            if (!isStr(p?.partNumber)) errors.push(`partDetails[${i}].partNumber is required`);
            else if (seen.has(p.partNumber)) errors.push(`duplicate partNumber ${p.partNumber}`);
            else seen.add(p.partNumber);
            if (!isInt(p?.quantity)) errors.push(`partDetails[${i}].quantity invalid`);
        });

        if (errors.length) {
            failureList.push({ ...key, reason: errors.join('; ') });
            continue;
        }

        // ---------- 2. save this item (own transaction) ----------
        const conn = await connection.getConnection();
        try {
            await conn.beginTransaction();

            // Lock existing row (if any) so two uploads of the same CR+FIM can't clash
            const [existing] = await conn.query(
                'SELECT id FROM bk_kitting_header WHERE crNumber = ? AND fimNumber = ? FOR UPDATE',
                [item.crNumber, item.fimNumber]
            );

            let headerId;

            if (existing.length) {
                // Already exists
                if (!item.override) {
                    await conn.rollback();
                    failureList.push({ ...key, reason: 'CR + FIM already exists and override is false' });
                    continue;
                }

                headerId = existing[0].id;

                // Don't allow override after packing data has already come in for this CR + FIM
                const [packed] = await conn.query(
                    'SELECT id FROM bk_packing_header WHERE kittingHeaderId = ? LIMIT 1',
                    [headerId]
                );
                if (packed.length) {
                    await conn.rollback();
                    failureList.push({ ...key, reason: 'Already packed; override not allowed' });
                    continue;
                }

                // Override: update header, replace parts
                await conn.query(
                    `UPDATE bk_kitting_header
              SET barcodeKittingInfoId = ?, description = ?, bomQty = ?,
                  qualityStatus = 'PENDING', overrideCount = overrideCount + 1
            WHERE id = ?`,
                    [item.barcodeKittingInfoId || null, item.description || null, item.bomQty, headerId]
                );
                await conn.query('DELETE FROM bk_kitting_part WHERE headerId = ?', [headerId]);
            } else {
                // New CR + FIM
                const [ins] = await conn.query(
                    `INSERT INTO bk_kitting_header
             (barcodeKittingInfoId, crNumber, fimNumber, description, bomQty)
           VALUES (?, ?, ?, ?, ?)`,
                    [item.barcodeKittingInfoId || null, item.crNumber, item.fimNumber,
                    item.description || null, item.bomQty]
                );
                headerId = ins.insertId;
            }

            // Bulk insert parts
            await conn.query(
                'INSERT INTO bk_kitting_part (headerId, partNumber, description, quantity) VALUES ?',
                [parts.map((p) => [headerId, p.partNumber, p.description || null, p.quantity])]
            );

            await conn.commit();
            successList.push(key);
        } catch (err) {
            await conn.rollback();
            appLog.error('[uploadeddata]', key, err);
            failureList.push({ ...key, reason: 'Unexpected error while saving' });
        } finally {
            conn.release();
        }
    }

    // Always 200 with both lists (matches BarcodeKittingTransferResponse)
    return res.status(200).json({ successList, failureList });
};


/**
 * API 3 — POST /boxKit/packingInfoTransfer  (Barcode Kitting -> ERP)
 */
exports.packingInfoTransfer = async function packingInfoTransfer(req, res) {
    const body = req.body;

    // ---------- response helpers (same format as their API 2) ----------
    const ok = (result) =>
        res.status(200).json({ status: 'success', statusCode: 200, result, error: {} });

    const fail = (code, message, details) =>
        res.status(code).json({
            status: 'error',
            statusCode: code,
            error: {
                timestamp: new Date().toISOString().slice(0, 19),
                status: code,
                error: { 400: 'Bad Request', 404: 'Not Found', 500: 'Internal Server Error' }[code],
                message,
                ...(details ? { details } : {}),
            },
        });

    // ---------- 1. validate ----------
    const errors = [];
    const isStr = (v) => typeof v === 'string' && v.trim() !== '';
    const isInt = (v) => Number.isInteger(v) && v >= 0;

    if (!body || typeof body !== 'object') return fail(400, 'Body must be a JSON object');
    if (!isStr(body.crNumber)) errors.push('crNumber is required');
    if (!isStr(body.fimNumber)) errors.push('fimNumber is required');
    if (!isInt(body.bomQty)) errors.push('bomQty must be a non-negative integer');

    // packedDate: "2026-11-04T10:15:30" or [2026,11,4,10,15,30]
    let packedDate = null;
    const pad = (n) => String(n).padStart(2, '0');
    if (Array.isArray(body.packedDate)) {
        const [y, mo, d, h = 0, mi = 0, s = 0] = body.packedDate;
        packedDate = `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(s)}`;
    } else if (typeof body.packedDate === 'string') {
        const m = body.packedDate.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/);
        if (m) packedDate = `${m[1]} ${m[2]}:${m[3] || '00'}`;
    }
    if (!packedDate) errors.push('packedDate is missing or invalid');

    const labels = Array.isArray(body.packingLabels) ? body.packingLabels : [];
    const parts = Array.isArray(body.partDetails) ? body.partDetails : [];
    if (!labels.length) errors.push('packingLabels must be a non-empty array');
    if (!parts.length) errors.push('partDetails must be a non-empty array');

    const boxBarcodes = new Set();
    labels.forEach((l, i) => {
        if (!isStr(l.barcode)) errors.push(`packingLabels[${i}].barcode is required`);
        else if (boxBarcodes.has(l.barcode)) errors.push(`duplicate barcode ${l.barcode}`);
        else boxBarcodes.add(l.barcode);
        if (!Number.isInteger(l.boxNo) || l.boxNo <= 0) errors.push(`packingLabels[${i}].boxNo invalid`);
        if (typeof l.grossWeight !== 'number' || l.grossWeight < 0) errors.push(`packingLabels[${i}].grossWeight invalid`);
    });

    parts.forEach((p, i) => {
        if (!isStr(p.partNumber)) errors.push(`partDetails[${i}].partNumber is required`);
        if (!isInt(p.quantity)) errors.push(`partDetails[${i}].quantity invalid`);
        const map = p.labelMap || {};
        let sum = 0;
        for (const [barcode, qty] of Object.entries(map)) {
            if (!boxBarcodes.has(barcode)) errors.push(`${p.partNumber}: barcode ${barcode} not in packingLabels`);
            if (!isInt(qty)) errors.push(`${p.partNumber}: labelMap qty for ${barcode} invalid`);
            else sum += qty;
        }
        // e.g. P-1002: 12 + 8 must equal 20
        if (sum !== p.quantity) errors.push(`${p.partNumber}: labelMap total ${sum} != quantity ${p.quantity}`);
    });

    if (errors.length) return fail(400, 'Invalid request body', errors);

    // ---------- 2. save (one transaction) ----------
    const conn = await connection.getConnection();
    try {
        await conn.beginTransaction();

        // CR + FIM must already exist from API 1 (/uploadeddata)
        const [kit] = await conn.query(
            'SELECT id FROM bk_kitting_header WHERE crNumber = ? AND fimNumber = ? FOR UPDATE',
            [body.crNumber, body.fimNumber]
        );
        if (!kit.length) {
            await conn.rollback();
            return fail(404, `CR number ${body.crNumber} with FIM number ${body.fimNumber} not found`);
        }
        const kittingId = kit[0].id;

        // Every packed part must be in that kit
        const [kitParts] = await conn.query(
            'SELECT partNumber FROM bk_kitting_part WHERE headerId = ?', [kittingId]
        );
        const known = new Set(kitParts.map((r) => r.partNumber));
        const unknown = parts.map((p) => p.partNumber).filter((pn) => !known.has(pn));
        if (unknown.length) {
            await conn.rollback();
            return fail(400, 'Parts not found in kitting data for this CR + FIM', unknown);
        }

        // Re-send replaces old packing (child rows cascade)
        await conn.query('DELETE FROM bk_packing_header WHERE kittingHeaderId = ?', [kittingId]);

        // Header
        const [h] = await conn.query(
            `INSERT INTO bk_packing_header
         (kittingHeaderId, crNumber, fimNumber, description, bomQty, packedDate)
       VALUES (?, ?, ?, ?, ?, ?)`,
            [kittingId, body.crNumber, body.fimNumber, body.description || null, body.bomQty, packedDate]
        );
        const packingId = h.insertId;

        // Boxes
        await conn.query(
            'INSERT INTO bk_packing_label (packingHeaderId, boxNo, barcode, grossWeight) VALUES ?',
            [labels.map((l) => [packingId, l.boxNo, l.barcode, l.grossWeight])]
        );

        // Parts + labelMap
        for (const p of parts) {
            const [pr] = await conn.query(
                `INSERT INTO bk_packing_part (packingHeaderId, partNumber, description, quantity)
         VALUES (?, ?, ?, ?)`,
                [packingId, p.partNumber, p.description || null, p.quantity]
            );
            const rows = Object.entries(p.labelMap).map(([barcode, qty]) => [pr.insertId, barcode, qty]);
            if (rows.length) {
                await conn.query(
                    'INSERT INTO bk_packing_part_label (packingPartId, barcode, quantity) VALUES ?',
                    [rows]
                );
            }
        }

        await conn.commit();
        return ok({
            message: 'Packing data saved successfully',
            packingId,
            boxes: labels.length,
            parts: parts.length,
        });
    } catch (err) {
        await conn.rollback();
        appLog.error('[packingInfoTransfer]', err);
        return fail(500, 'Unexpected server error');
    } finally {
        conn.release();
    }
};