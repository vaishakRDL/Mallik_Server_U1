const { connection, CustomError, handleErrorResponse, handleSuccessResponse } = require("../../config/dbSql");
const exceljs = require("exceljs");
const JSZip = require("jszip");
const { currentDateTime } = require("../../utility/utilityFunction");

exports.template = async (req, res) => {
    try {
        const workbook = new exceljs.Workbook();
        const worksheet = workbook.addWorksheet("Sheet 1");

        const headerRow = worksheet.addRow([
            "Contract No",
            "Part No",
            "Qty",
            "Source",
            "Desciption",
            "Box No",
        ]);

        headerRow.font = { bold: true }; // Make text bold
        headerRow.alignment = { horizontal: "center" }; // Center align text

        worksheet.columns.forEach((column) => {
            column.width = 20;
        });

        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader("Content-Disposition", "attachment; filename = CSL.xlsx");

        workbook.xlsx
            .write(res)
            .then(() => {
                // End the response stream
                res.end();
            })
            .catch((err) => {
                console.error("Error writing Excel file:", err);
                res.status(500).send("Error generating Excel file");
            });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message || "An error occurred" });
    }
};

/* ------------------------------ CSL IMPORT ------------------------------ */

const IMPORT_TYPES = ['View', 'Import', 'Export'];
const PACKLIST_SHEET = 'PackList';     // part rows + header contract no / FIM (row 3)
const CONTRACT_SHEET = 'CSL-M';        // Duty (C2) and Stop (C3)
const FIRST_DATA_ROW = 3;

// PackList columns
const COL = { CONTRACT: 1, PART: 2, QTY: 3, DESC: 5, BOX: 6 };

const SPREADSHEETML_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const NS_PREFIX_DECL = new RegExp(`\\sxmlns:(\\w+)="${escapeRegExp(SPREADSHEETML_NS)}"`);

// The import only reads these two sheets (same name rules as getWorksheet / findSheet below)
const isNeededSheet = (name) =>
    name === PACKLIST_SHEET || (name || '').trim().toUpperCase() === CONTRACT_SHEET.toUpperCase();

const decodeXmlAttr = (s) =>
    s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const getXmlAttr = (tag, attrRegex) => {
    const match = tag.match(attrRegex);
    return match ? decodeXmlAttr(match[1]) : null;
};

/*
 * CSL files carry ~14 sheets (one "Contract BOM" alone is ~3 MB of XML) but the import reads
 * only PackList and CSL-M. Remove the other worksheet parts from the in-memory copy so exceljs
 * parses only what is used. Shared strings and styles are kept, so cell values are unchanged.
 * exceljs skips sheets whose part is missing (as it does for chart sheets).
 */
const dropUnusedSheets = async (zip) => {
    const wbPart = zip.file('xl/workbook.xml');
    const relsPart = zip.file('xl/_rels/workbook.xml.rels');
    if (!wbPart || !relsPart) return;

    const [wbXml, relsXml] = await Promise.all([wbPart.async('string'), relsPart.async('string')]);

    // rId -> part path, resolved the same way exceljs does
    const targets = {};
    for (const tag of relsXml.match(/<(?:\w+:)?Relationship\b[^>]*>/g) || []) {
        const id = getXmlAttr(tag, /\sId="([^"]*)"/);
        const target = getXmlAttr(tag, /\sTarget="([^"]*)"/);
        if (id && target) targets[id] = `xl/${target.replace(/^(\s|\/xl\/)+/, '')}`;
    }

    const sheets = (wbXml.match(/<(?:\w+:)?sheet\b[^>]*>/g) || []).map((tag) => ({
        name: getXmlAttr(tag, /\sname="([^"]*)"/),
        path: targets[getXmlAttr(tag, /\s(?:\w+:)?id="([^"]*)"/)],
    }));

    // Only prune when the needed sheets were clearly identified; otherwise leave the file as is
    if (!sheets.some((s) => isNeededSheet(s.name) && s.path && zip.file(s.path))) return;

    for (const { name, path } of sheets) {
        if (isNeededSheet(name) || !path) continue;

        const part = path.match(/^xl\/worksheets\/(sheet\d+\.xml)$/);
        if (!part) continue; // only regular worksheet parts are dropped

        zip.remove(path);
        zip.remove(`xl/worksheets/_rels/${part[1]}.rels`);
    }
};

/*
 * Some tools (e.g. the .NET OpenXML SDK) write valid xlsx files with prefixed tags
 * (<x:workbook>, <ap:Properties>, unprefixed <lastModifiedBy>) that exceljs cannot parse.
 * Rewrite the sheet XML to the unprefixed form exceljs expects and drop the document
 * property parts (author/app metadata, not used by the import) when they are in that form.
 */
const normalizePrefixedParts = async (zip) => {
    for (const name of Object.keys(zip.files)) {
        if (zip.files[name].dir || !name.endsWith('.xml')) continue;

        const xml = await zip.file(name).async('string');
        const match = xml.match(NS_PREFIX_DECL);
        if (!match) continue;

        const prefix = match[1];
        let out = xml.replace(new RegExp(`(</?)${prefix}:`, 'g'), '$1');
        out = out.replace(NS_PREFIX_DECL, /\sxmlns="/.test(out) ? '' : ` xmlns="${SPREADSHEETML_NS}"`);
        zip.file(name, out);
    }

    const expectedRoot = {
        'docProps/core.xml': /<cp:coreProperties[\s>]/,
        'docProps/app.xml': /<Properties[\s>]/,
    };
    for (const [name, rootTag] of Object.entries(expectedRoot)) {
        const part = zip.file(name);
        if (part && !rootTag.test(await part.async('string'))) zip.remove(name);
    }
};

// Build the in-memory copy exceljs loads: unused sheets dropped, prefixed XML normalised if needed
const prepareXlsx = async (buffer) => {
    const zip = await JSZip.loadAsync(buffer);

    // Prune first so normalisation only touches the parts that remain
    await dropUnusedSheets(zip);

    const wbPart = zip.file('xl/workbook.xml');
    if (wbPart && NS_PREFIX_DECL.test(await wbPart.async('string'))) {
        await normalizePrefixedParts(zip);
    }

    // No compression: the copy only lives in memory, so skip the deflate cost
    return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
};

const loadXlsx = async (buffer) => {
    const workbook = new exceljs.Workbook();
    await workbook.xlsx.load(buffer);
    return workbook;
};

// Decode one uploaded file ({ name, data: base64 data URL }) into a workbook
const loadWorkbook = async (file) => {
    if (!file || typeof file.data !== 'string') {
        throw new CustomError(`Invalid file data${file?.name ? `: ${file.name}` : ''}`, 400);
    }

    const base64Data = file.data.replace(/^data:.*?;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    try {
        return await loadXlsx(await prepareXlsx(buffer));
    } catch (prepErr) {
        // Safety net: if pre-processing ever fails, load the untouched file as before
        try {
            return await loadXlsx(buffer);
        } catch (err) {
            // exceljs throws low-level errors (e.g. "reading 'sheets'") for files it cannot parse
            throw new CustomError(
                `File ${file.name || ''} could not be read (${err.message}). Open it in Excel, use Save As "Excel Workbook (*.xlsx)" and import again.`,
                400
            );
        }
    }
};

// Sheet lookup ignoring case and surrounding spaces, so a moved/renamed-case sheet is still found
const findSheet = (workbook, sheetName) =>
    workbook.worksheets.find(
        (ws) => (ws.name || '').trim().toUpperCase() === sheetName.toUpperCase()
    );

// Validate one PackList row; returns the first problem found, or null
const validateRow = (row, { hdrContractNo, FIM }) => {
    const contractNo = row.getCell(COL.CONTRACT).value;
    const boxNo = row.getCell(COL.BOX).value;

    if (boxNo == null) return `Box number is empty in Contract No ${hdrContractNo}`;
    if (!String(boxNo).startsWith(FIM)) return `Box number does not start with FIM: ${boxNo} at Contract No ${hdrContractNo}`;
    if (hdrContractNo !== contractNo) return `Mismatched Contract no ${contractNo} in sheet with header ${hdrContractNo}`;
    if (row.getCell(COL.QTY).value == null) return `Quantity required for Part ${row.getCell(COL.PART).value}`;

    return null;
};

// Read one CSL file: header details, part rows and validation errors
const parseCslWorkbook = (workbook, fileName) => {
    const packList = workbook.getWorksheet(PACKLIST_SHEET);
    if (!packList) {
        throw new CustomError(`Sheet ${PACKLIST_SHEET} not found in file ${fileName || ''}`.trim(), 400);
    }

    const hdrRow = packList.getRow(FIRST_DATA_ROW);
    const hdrContractNo = hdrRow.getCell(COL.CONTRACT).text || '';
    const rowFIM = hdrRow.getCell(COL.BOX).text || '';
    const FIM = (rowFIM.match(/^[^\d]*/) || [''])[0];

    const errorMessages = new Set();
    const items = [];

    packList.eachRow((row, rowNumber) => {
        if (rowNumber < FIRST_DATA_ROW) return;

        const contractNo = row.getCell(COL.CONTRACT).value;
        const boxNo = row.getCell(COL.BOX).value;

        if (!contractNo && !boxNo) return; // skip empty rows

        const error = validateRow(row, { hdrContractNo, FIM });
        if (error) errorMessages.add(error);

        items.push({
            id: rowNumber,
            contractNo,
            partNo: row.getCell(COL.PART).value,
            Qty: row.getCell(COL.QTY).value,
            desc: row.getCell(COL.DESC).value,
            boxNo,
        });
    });

    // Duty and Stop come from the CSL-M sheet, found by name because its position can change
    const contractWS = findSheet(workbook, CONTRACT_SHEET);
    if (!contractWS) {
        errorMessages.add(`Sheet ${CONTRACT_SHEET} not found in Contract No ${hdrContractNo}`);
    }

    return {
        contractNo: hdrContractNo,
        items,
        details: {
            FIM,
            duty: contractWS ? contractWS.getCell('C2').value : null,
            stop: contractWS ? contractWS.getCell('C3').value : null,
            type: FIM.replace(/FIM/g, '') || FIM,
            errorMessage: errorMessages.size ? [...errorMessages].join(', ') : null,
        },
    };
};

const orderGeneratedMessage = (contractNo) =>
    `Order already generated for Contract No ${contractNo}. CSL cannot be replaced.`;

// Order plan exists for the contract (sob_mst.processed = 1). Exact contract number only:
// a suffixed contract (e.g. 52KK2954A) is a different contract from 52KK2954, and SOB stores
// contract numbers exactly as in the CSL.
const isOrderGenerated = (orderGeneratedSet, contractNo) =>
    orderGeneratedSet.has(String(contractNo || '').trim());

// Contracts in this upload that already have a CSL (re-import will replace them)
const existingCslContracts = async (contractNos) => {
    const list = [...new Set(contractNos.filter(Boolean))];
    if (!list.length) return new Set();

    const [rows] = await connection.execute(
        `SELECT DISTINCT contractNo FROM csl_mst WHERE contractNo IN (${list.map(() => '?').join(',')})`,
        list
    );
    return new Set(rows.map((r) => r.contractNo));
};

// Preview rows for the "View" step
const buildPreview = async (allSheetContents, contractDetails) => {
    const contractNos = allSheetContents.map((obj) => Object.keys(obj)[0]);
    const [orderGenerated, existingCsl] = await Promise.all([
        getProcessedContractNos(),
        existingCslContracts(contractNos),
    ]);

    return allSheetContents.map((obj, index) => {
        const contractNo = Object.keys(obj)[0];
        const details = { ...contractDetails[contractNo] };

        // Order already generated → same rule the import enforces; shown as an error, not replaceable
        const blocked = isOrderGenerated(orderGenerated, contractNo);
        if (blocked) {
            details.errorMessage = [details.errorMessage, orderGeneratedMessage(contractNo)]
                .filter(Boolean)
                .join(', ');
        }

        return {
            id: index + 1,
            contractNo,
            ...details,
            childItems: obj[contractNo],
            // CSL exists but no order yet → user is asked to confirm, then it is replaced
            contractLoaded: !blocked && existingCsl.has(contractNo),
        };
    });
};

exports.import = async (req, res) => {
    try {
        const { type, contractList: excelDataArray } = req.body;

        if (!Array.isArray(excelDataArray) || excelDataArray.length === 0) {
            throw new CustomError('Please select a file!', 400);
        }

        if (!IMPORT_TYPES.includes(type)) {
            throw new CustomError('Invalid type id provided!', 400);
        }

        // Export to excel (contractList holds preview rows here, not files)
        if (type === 'Export') {
            return await exportCSL(res, excelDataArray);
        }

        const allSheetContents = [];
        const contractDetails = {};

        for (const file of excelDataArray) {
            const workbook = await loadWorkbook(file);
            const { contractNo, items, details } = parseCslWorkbook(workbook, file.name);

            allSheetContents.push({ [contractNo]: items });
            contractDetails[contractNo] = details;
        }

        if (type === 'View') {
            const result = await buildPreview(allSheetContents, contractDetails);
            return res.status(200).json({ success: true, message: 'Contracts list', data: result });
        }

        // type === 'Import'
        await insertCSLData(allSheetContents, contractDetails);
        return handleSuccessResponse(res, 'Successfully imported');
    } catch (err) {
        return handleErrorResponse(res, err);
    }
};

const exportCSL = async (res, contractList) => {
    try {
        if (!Array.isArray(contractList) || contractList.length === 0) {
            return res.status(400).json({ error: 'Invalid or empty contract list provided.' });
        }

        const workbook = new exceljs.Workbook();
        const worksheet = workbook.addWorksheet('CSL');

        const HEADERS = [
            'Contract No',
            'Part No',
            'Qty',
            'Description',
            'Box No',
            'Duty',
            'Stop',
            'Type'
        ];

        // Add header row with styling
        const headerRow = worksheet.addRow(HEADERS);
        headerRow.eachCell(cell => {
            cell.font = { bold: true, size: 13 };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
        });

        // Process each contract
        contractList.forEach(contract => {
            const { duty = '', stop = '', type = '', childItems = [] } = contract;

            childItems.forEach(item => {
                const rowData = [
                    item.contractNo || '',
                    item.partNo || '',
                    item.Qty || '',
                    item.desc || '',
                    item.boxNo || '',
                    duty,
                    stop,
                    type
                ];

                const row = worksheet.addRow(rowData);
                row.eachCell(cell => {
                    cell.alignment = { horizontal: 'center' };
                });
            });
        });

        // Set column widths (based on importance)
        const columnWidths = [22, 32, 10, 35, 18, 10, 10, 12];
        worksheet.columns.forEach((column, i) => {
            column.width = columnWidths[i] || 20;
        });

        // Configure response headers for download
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=contract-details.xlsx');
        res.status(200);

        // Write to response stream
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error('Error exporting CSL:', err);
        res.status(500).json({ error: 'Failed to export contract sheet list.' });
    }
};

// Contract numbers whose SOB already has an order plan (set in orderPlanningController)
const getProcessedContractNos = async () => {
    const [rows] = await connection.execute(
        `
        SELECT sob_mst.contractNos
        FROM sob_mst
        WHERE sob_mst.processed = ?
        `,
        [1]
    );

    return new Set(
        rows
            .flatMap(row => row.contractNos?.split(",") || [])
            .map(c => c.trim())
            .filter(Boolean)
    );
};

/*
async function masterCsl(
    conn,
    contractNo,
    contractDetails,
    processedContractsSet
) {
    const { FIM, duty, stop, type } = contractDetails;
    const dateTime = await currentDateTime();

    // ❌ HARD RULE: already processed → block
    if (processedContractsSet.has(contractNo)) {
        throw new CustomError(
            `ContractNo - ${contractNo} is already produced!`,
            400
        );
    }

    // 🔍 Check existing CSL (allowed to overwrite)
    const [[existingCsl]] = await conn.execute(
        "SELECT id FROM csl_mst WHERE contractNo = ? LIMIT 1",
        [contractNo]
    );

    // ♻️ Overwrite safely (CASCADE deletes children)
    if (existingCsl) {
        await conn.execute(
            "DELETE FROM csl_mst WHERE contractNo = ?",
            [contractNo]
        );
    }

    // 🔐 Concurrent-safe CSL number generation
    const [[lastRow]] = await conn.execute(
        "SELECT cslNo FROM csl_mst ORDER BY id DESC LIMIT 1 FOR UPDATE"
    );

    const nextNumber = lastRow?.cslNo
        ? Number(lastRow.cslNo.split("-")[1]) + 1
        : 1;

    const cslNo = `CSL-${nextNumber}`;

    const [insertResult] = await conn.execute(
        `
        INSERT INTO csl_mst
            (cslNo, contractNo, date, fim, duty, stop, type, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [cslNo, contractNo, dateTime, FIM, duty, stop, type, "Pending"]
    );

    return insertResult.insertId;
}

async function insertCSLData(sheetContents, contractDetails) {
    const conn = await connection.getConnection();

    try {
        // Load once → fast lookups
        const processedContractsSet = await getProcessedContractNos();

        await conn.beginTransaction();

        for (const sheetContent of sheetContents) {
            const contractNo = Object.keys(sheetContent)[0];

            const cslMstId = await masterCsl(
                conn,
                contractNo,
                contractDetails[contractNo],
                processedContractsSet
            );

            const cslDetails = sheetContent[contractNo].map(
                ({ partNo, Qty, desc, boxNo }) => [
                    cslMstId,
                    contractNo,
                    partNo,
                    Qty,
                    desc,
                    boxNo
                ]
            );

            if (cslDetails.length) {
                await bulkInsertCSLDetails(conn, cslDetails);
            }
        }

        await conn.commit();
        return true;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

async function bulkInsertCSLDetails(conn, cslDetails) {
    const [result] = await conn.query(
        `
        INSERT INTO csl
            (cslMstId, contractNo, partNo, Qty, description, boxNo)
        VALUES ?
        `,
        [cslDetails]
    );

    if (!result.affectedRows) {
        throw new CustomError("Failed to insert CSL details.", 400);
    }

    return true;
}
*/

async function masterCsl(
    conn,
    contractNo,
    contractDetails,
    processedContractsSet
) {
    const { FIM, duty, stop, type } = contractDetails;
    const dateTime = await currentDateTime();

    // Order already generated → never replace (same rule the preview shows)
    if (isOrderGenerated(processedContractsSet, contractNo)) {
        throw new CustomError(orderGeneratedMessage(contractNo), 400);
    }

    // ✅ Lock only this contract row
    const [[existingCsl]] = await conn.execute(
        `SELECT id FROM csl_mst WHERE contractNo = ? FOR UPDATE`,
        [contractNo]
    );

    if (existingCsl) {
        await conn.execute(
            `DELETE FROM csl_mst WHERE contractNo = ?`,
            [contractNo]
        );
    }

    // ✅ 🔥 BEST PRACTICE: counter table (atomic increment)
    await conn.execute(
        `UPDATE counter 
         SET number = LAST_INSERT_ID(number + 1)
         WHERE counterType = 'CSL'`
    );

    const [[row]] = await conn.execute(
        `SELECT LAST_INSERT_ID() AS nextNumber`
    );

    const nextNumber = row.nextNumber;
    const cslNo = `CSL-${nextNumber}`;

    const [insertResult] = await conn.execute(
        `
        INSERT INTO csl_mst
        (cslNo, contractNo, date, fim, duty, stop, type, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [cslNo, contractNo, dateTime, FIM, duty, stop, type, "Pending"]
    );

    return insertResult.insertId;
}

async function insertCSLData(sheetContents, contractDetails) {
    const conn = await connection.getConnection();
    const MAX_RETRIES = 3;

    // try/finally so the connection goes back to the pool on success, error and retry exhaustion
    try {
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const processedContractsSet = await getProcessedContractNos();

                await conn.beginTransaction();

                // ✅ CRITICAL: consistent order to avoid deadlocks
                const sortedSheets = [...sheetContents].sort((a, b) => {
                    const keyA = Object.keys(a)[0];
                    const keyB = Object.keys(b)[0];
                    return keyA.localeCompare(keyB);
                });

                for (const sheetContent of sortedSheets) {
                    const contractNo = Object.keys(sheetContent)[0];

                    const cslMstId = await masterCsl(
                        conn,
                        contractNo,
                        contractDetails[contractNo],
                        processedContractsSet
                    );

                    const cslDetails = sheetContent[contractNo].map(
                        ({ partNo, Qty, desc, boxNo }) => [
                            cslMstId,
                            contractNo,
                            partNo,
                            Qty,
                            desc,
                            boxNo
                        ]
                    );

                    if (cslDetails.length) {
                        await bulkInsertCSLDetails(conn, cslDetails);
                    }
                }

                await conn.commit();
                return true;

            } catch (err) {
                await conn.rollback();

                // ✅ retry for deadlocks
                if (err.code === 'ER_LOCK_DEADLOCK' && attempt < MAX_RETRIES) {
                    continue;
                }

                throw err;
            }
        }
    } finally {
        conn.release();
    }
}

async function bulkInsertCSLDetails(conn, cslDetails) {
    const [result] = await conn.query(
        `
        INSERT INTO csl
        (cslMstId, contractNo, partNo, Qty, description, boxNo)
        VALUES ?
        `,
        [cslDetails]
    );

    if (!result.affectedRows) {
        throw new CustomError("Failed to insert CSL details.", 400);
    }

    return true;
}

exports.cslExport = async (req, res) => {
    try {
        const { cslMstId, fromDate, toDate } = req.query;
        const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

        // Columns must stay in header order: Contract No, Part No, Qty, Description, Box No
        let cslQuery, cslParams;
        if (cslMstId) {
            cslQuery = `SELECT contractNo, partNo, Qty, description, boxNo FROM csl WHERE cslMstId = ?`;
            cslParams = [cslMstId];
        } else if (isDate(fromDate) && isDate(toDate)) {
            cslQuery = `
                SELECT c.contractNo, c.partNo, c.Qty, c.description, c.boxNo
                FROM csl c
                INNER JOIN csl_mst m ON m.id = c.cslMstId
                WHERE DATE(m.date) BETWEEN ? AND ?
                ORDER BY m.id, c.id`;
            cslParams = [fromDate, toDate];
        } else {
            throw new CustomError('Provide a CSL id, or a From and To date (YYYY-MM-DD).', 400);
        }

        const [cslRows] = await connection.execute(cslQuery, cslParams);

        const workbook = new exceljs.Workbook();
        const worksheet = workbook.addWorksheet('CSL');

        const headerRow = worksheet.addRow([
            'Contract No',
            'Part No',
            'Qty',
            'Description',
            'Box No'
        ]);

        headerRow.eachCell({ includeEmpty: true }, function (cell) {
            cell.font = { bold: true, size: 13 };
            cell.alignment = { horizontal: "center", vertical: "middle" };
        });

        cslRows.forEach(cslRow => {
            const rowData = Object.values(cslRow);
            const newRow = worksheet.addRow(rowData);
            newRow.eachCell({ includeEmpty: true }, (cell, colNo) => {
                cell.alignment = { horizontal: 'center' };
            });
        });

        worksheet.columns.forEach((column, index) => {
            column.width = (index == 1 || index == 3) ? 30 : 22;
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=contract-details.xlsx');

        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        return handleErrorResponse(res, err);
    }
};