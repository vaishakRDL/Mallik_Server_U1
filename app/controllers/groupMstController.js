const { connection, handleErrorResponse, handleSuccessResponse } = require('../config/dbSql');

const RIGHT_FLAGS = ['addData', 'updateData', 'deleteData', 'viewData', 'print', 'auth', 'auth1', 'opt1', 'opt2', 'opt3', 'opt4', 'opt5'];

/*
 * Screens the UI checks by their own menu code but which older databases have no menu entry for.
 * Each is created once (type taken from `copyFrom`'s menu) and every group's rights for it start as a
 * copy of that group's rights on `copyFrom` — the code the screen was checked against before — so no
 * one gains or loses access. After that the rights are assigned in Group Master like any other menu.
 */
const REQUIRED_MENUS = [
    { code: 'RevisedPlan', name: 'Revised Plan', copyFrom: 'AssemblyUser' },
];

const ensureRequiredMenus = async (conn) => {
    for (const menu of REQUIRED_MENUS) {
        // Lock on the code so two runs cannot create it twice
        const [existing] = await conn.execute('SELECT id, type FROM mst_menu WHERE code = ? LIMIT 1 FOR UPDATE', [menu.code]);

        // All menu rows with the old code (older databases can have more than one)
        const [sources] = await conn.execute('SELECT id, type FROM mst_menu WHERE code = ?', [menu.copyFrom]);
        const sourceIds = sources.length ? sources.map((s) => s.id) : [0];

        let menuId = existing[0]?.id;
        let type = existing[0]?.type;

        if (!menuId) {
            type = sources[0]?.type || 'Transactions';
            // rights = 1: its group_rights rows are created right here, not by the generic sync
            const [inserted] = await conn.execute(
                'INSERT INTO mst_menu (type, code, name, description, rights) VALUES (?, ?, ?, ?, 1)',
                [type, menu.code, menu.name, menu.name]
            );
            menuId = inserted.insertId;
        }

        const flagCols = RIGHT_FLAGS.join(', ');
        const copiedFlags = RIGHT_FLAGS.map((f) => `COALESCE(src.${f}, 0)`).join(', ');
        const sourceFlags = RIGHT_FLAGS.map((f) => `MAX(${f}) AS ${f}`).join(', ');

        // Every active group that has no row for this menu yet gets one, copied from its old-code rights.
        // Groups that already have a row are left untouched (assigned rights are never overwritten).
        await conn.query(`
            INSERT INTO group_rights (groupCode, type, menuId, ${flagCols}, dflag)
            SELECT g.code, ?, ?, ${copiedFlags}, 0
            FROM group_mst g
            LEFT JOIN (
                SELECT groupCode, ${sourceFlags}
                FROM group_rights
                WHERE menuId IN (?)
                GROUP BY groupCode
            ) src ON src.groupCode = g.code
            WHERE g.dflag = 0
              AND NOT EXISTS (SELECT 1 FROM group_rights gr WHERE gr.groupCode = g.code AND gr.menuId = ?)`,
            [type, menuId, sourceIds, menuId]
        );

        // The Permissions grid lists only rows with dflag = 0
        await conn.execute('UPDATE group_rights SET dflag = 0 WHERE menuId = ? AND dflag IS NULL', [menuId]);
    }
};

// Run once at server start so menus and rights exist before anyone logs in. Never blocks startup.
exports.ensureRequiredMenusOnStartup = async () => {
    const conn = await connection.getConnection();
    try {
        await conn.beginTransaction();
        await ensureRequiredMenus(conn);
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        console.error('Could not create required menus:', err.message);
    } finally {
        conn.release();
    }
};

// Add a rights row (all permissions off) for every menu the group does not have yet.
// Only missing (group, menu) pairs are inserted, so this never creates duplicates.
const addMissingRights = async (conn, groupCode) => {
    const [result] = await conn.execute(`
        INSERT INTO group_rights (groupCode, type, menuId)
        SELECT ?, m.type, m.id
        FROM mst_menu m
        WHERE NOT EXISTS (
            SELECT 1 FROM group_rights gr WHERE gr.groupCode = ? AND gr.menuId = m.id
        )`,
        [groupCode, groupCode]
    );
    return result.affectedRows;
};

exports.store = async (req, res) => {
    const conn = await connection.getConnection();
    try {
        const group = req.body;

        await conn.beginTransaction();

        // Lock the code so two people cannot create the same group at once
        const [existing] = await conn.execute('SELECT id, dflag FROM group_mst WHERE code = ? FOR UPDATE', [group.code]);
        const active = existing.find((g) => Number(g.dflag) === 0);

        if (active) {
            await conn.rollback();
            return res.status(400).json({ success: false, message: "Duplicate entry can't be added!" });
        }

        if (existing.length > 0) {
            // Code belonged to a deleted group → reuse that row instead of inserting a second one
            await conn.execute(
                `UPDATE group_mst SET groupName = ?, description = ?, dflag = 0 WHERE id = ?`,
                [group.groupName, group.description, existing[0].id]
            );
        } else {
            await conn.execute(
                `INSERT INTO group_mst (groupName, code, description) VALUES (?, ?, ?)`,
                [group.groupName, group.code, group.description]
            );
        }

        // Start with a clean set of rights (a revived code may still have old rows)
        await conn.execute('DELETE FROM group_rights WHERE groupCode = ?', [group.code]);
        const added = await addMissingRights(conn, group.code);

        await conn.commit();

        if (added > 0) {
            return handleSuccessResponse(res, "data addded successfully");
        }
        return res.status(200).json({
            success: true,
            message: "Group added, but no menu data found for rights."
        });

    } catch (err) {
        if (conn) await conn.rollback();
        return handleErrorResponse(res, err);
    } finally {
        if (conn) conn.release();
    }
};

exports.update = async (req, res) => {
    try {
        const id = req.params.id;
        const group = req.body;

        const fetch = 'SELECT id FROM group_mst WHERE id = ?';
        const [results] = await connection.execute(fetch, [id]);

        if (results.length === 0) {
            return res.status(404).json({ success: false, message: 'Data not found' });
        }

        const update = `UPDATE group_mst SET groupName = ?, description = ? WHERE id = ?`;
        await connection.execute(update, [group.groupName, group.description, id]);

        return handleSuccessResponse(res, "Successfully updated");

    } catch (err) {
        return handleErrorResponse(res, err);
    }
};

exports.delete = async (req, res) => {
    const conn = await connection.getConnection();
    try {
        const id = req.params.id;

        const fetch = 'SELECT code FROM group_mst WHERE id = ?';
        const [results] = await conn.execute(fetch, [id]);

        if (results.length === 0) {
            return res.status(404).json({ success: false, message: 'Data not found' });
        }

        // Users of a deleted group could no longer log in, so they must be moved first
        const [[{ userCount }]] = await conn.execute('SELECT COUNT(*) AS userCount FROM users WHERE groupId = ?', [id]);
        if (userCount > 0) {
            return res.status(400).json({
                success: false,
                message: `This group has ${userCount} user(s) assigned. Remove or move them to another group before deleting it.`
            });
        }

        await conn.beginTransaction();

        const update = 'UPDATE group_mst SET dflag = 1 WHERE id = ?';
        await conn.execute(update, [id]);

        const deleteRight = 'DELETE FROM group_rights WHERE groupCode = ?';
        await conn.execute(deleteRight, [results[0].code]);

        await conn.commit();
        return handleSuccessResponse(res, "Successfully deleted");

    } catch (err) {
        if (conn) await conn.rollback();
        return handleErrorResponse(res, err);
    } finally {
        if (conn) conn.release();
    }
};

const handleRightsSync = async (conn) => {
    // Never let this block the Group Master list
    try {
        await ensureRequiredMenus(conn);
    } catch (err) {
        console.error('Could not create required menus:', err.message);
    }

    const fetchGroupMstData = 'SELECT id, code, groupName, description FROM group_mst WHERE dflag = 0';
    const [groupMstData] = await conn.execute(fetchGroupMstData);

    if (groupMstData.length > 0) {
        // Lock the not-yet-synced menus: a second sync running at the same time waits here,
        // then finds nothing left to do (prevents duplicate rights rows)
        const [menuData] = await conn.execute('SELECT id FROM mst_menu WHERE rights = 0 FOR UPDATE');

        if (menuData.length > 0) {
            const menuIds = menuData.map((m) => m.id);

            // Add only the (group, menu) pairs that are missing — a group created after the
            // menu was added already has its row
            await conn.query(`
                INSERT INTO group_rights (groupCode, type, menuId)
                SELECT g.code, m.type, m.id
                FROM group_mst g
                JOIN mst_menu m ON m.id IN (?)
                WHERE g.dflag = 0
                  AND NOT EXISTS (
                      SELECT 1 FROM group_rights gr WHERE gr.groupCode = g.code AND gr.menuId = m.id
                  )`,
                [menuIds]
            );

            await conn.query('UPDATE mst_menu SET rights = 1 WHERE id IN (?)', [menuIds]);
        }
    }
    return groupMstData;
};

exports.rights = async (req, res) => {
    const conn = await connection.getConnection();
    try {
        await conn.beginTransaction();
        await handleRightsSync(conn);
        await conn.commit();
        return handleSuccessResponse(res, "Rights synced successfully");
    } catch (err) {
        if (conn) await conn.rollback();
        return handleErrorResponse(res, err);
    } finally {
        if (conn) conn.release();
    }
};

exports.show = async (req, res) => {
    const conn = await connection.getConnection();
    try {
        await conn.beginTransaction();
        const groupMstData = await handleRightsSync(conn);
        await conn.commit();

        return res.status(200).json({
            success: true,
            message: "Group List",
            groupMstData: groupMstData
        });

    } catch (err) {
        if (conn) await conn.rollback();
        return handleErrorResponse(res, err);
    } finally {
        if (conn) conn.release();
    }
};

exports.userAssign = async (req, res) => {
    try {
        const id = req.params.id;
        const group = req.body;

        const updateUser = `UPDATE users SET groupId = ? WHERE id = ?`;
        await connection.execute(updateUser, [id, group.userId]);

        return handleSuccessResponse(res, "User Assigned Successfully");

    } catch (err) {
        return handleErrorResponse(res, err);
    }
};

exports.userShow = async (req, res) => {
    try {
        const id = req.params.id;

        const fetch = ` 
            SELECT u.*, 
                d.name as designation, d.id as designationId, dp.name as department, dp.id as departmentId, 
                r.name as userRole, r.id as userRoleId 
            FROM users u
                LEFT JOIN mst_designation d ON u.designation = d.id
                LEFT JOIN mst_department dp ON u.department = dp.id
                LEFT JOIN mst_role r ON u.userRole = r.id
            WHERE u.groupId = ?`;

        const [results] = await connection.execute(fetch, [id]);

        results.forEach((element, index) => {
            element.sNo = index + 1;
        });

        return handleSuccessResponse(res, "User list", results);

    } catch (err) {
        return handleErrorResponse(res, err);
    }
};

exports.dltUser = async (req, res) => {
    try {
        const id = req.params.id;

        const updateUser = `UPDATE users SET groupId = null WHERE id = ?`;
        await connection.execute(updateUser, [id]);

        return handleSuccessResponse(res, "User Removed Successfully");

    } catch (err) {
        return handleErrorResponse(res, err);
    }
};


