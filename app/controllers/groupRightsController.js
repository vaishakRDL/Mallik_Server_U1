const { connection, handleErrorResponse, handleSuccessResponse } = require('../config/dbSql');

// Read-only: a plain pooled query (no dedicated connection or transaction). The popup loads
// four sections at once, so this keeps each request light.
exports.getRights = async (req, res) => {
  try {
    const { type, code } = req.body;

    const fetchQuery = `
      SELECT
        gr.id, gr.type, gr.addData, gr.updateData, gr.deleteData, gr.viewData, gr.print,
        gr.auth, gr.auth1, gr.opt1, gr.opt2, gr.opt3, gr.opt4, gr.opt5,
        menu.name AS menuName, menu.id AS menuId, menu.code
      FROM group_rights gr
      INNER JOIN mst_menu AS menu ON gr.menuId = menu.id
      WHERE gr.groupCode = ? AND gr.type = ? AND gr.dflag = 0
    `;

    const [results] = await connection.execute(fetchQuery, [code, type]);

    const transformedData = results.map(item => ({
      id: item.id,
      menuName: item.menuName,
      type: item.type,
      code: item.code,
      menuId: item.menuId,

      addData: !!item.addData,
      updateData: !!item.updateData,
      deleteData: !!item.deleteData,
      viewData: !!item.viewData,
      print: !!item.print,
      auth: !!item.auth,
      auth1: !!item.auth1,
      opt1: !!item.opt1,
      opt2: !!item.opt2,
      opt3: !!item.opt3,
      opt4: !!item.opt4,
      opt5: !!item.opt5
    }));

    return handleSuccessResponse(res, "MenuType Master list", transformedData);

  } catch (err) {
    return handleErrorResponse(res, err);
  }
};

exports.submit = async (req, res) => {
  const conn = await connection.getConnection();
  try {
    const groups = req.body.data;

    if (!Array.isArray(groups)) {
      return res.status(400).json({
        success: false,
        message: "Invalid input. Expected an array of objects."
      });
    }

    await conn.beginTransaction();

    const updateQuery = `
      UPDATE group_rights
      SET
        addData = ?,
        updateData = ?,
        deleteData = ?,
        viewData = ?,
        print = ?,
        auth = ?,
        auth1 = ?,
        opt1 = ?,
        opt2 = ?,
        opt3 = ?,
        opt4 = ?,
        opt5 = ?
      WHERE id = ?
    `;

    /* ---- check existence of all rows in one query ---- */
    if (groups.length) {
      const [found] = await conn.query(`SELECT id FROM group_rights WHERE id IN (?)`, [groups.map((g) => g.id)]);
      const foundIds = new Set(found.map((r) => String(r.id)));
      const missing = groups.find((g) => !foundIds.has(String(g.id)));
      if (missing) {
        throw new Error(`Data not found for id ${missing.id}`);
      }
    }

    for (const g of groups) {
      /* ---- update ---- */
      await conn.execute(updateQuery, [
        g.addData,
        g.updateData,
        g.deleteData,
        g.viewData,
        g.print,
        g.auth,
        g.auth1,
        g.opt1,
        g.opt2,
        g.opt3,
        g.opt4,
        g.opt5,
        g.id
      ]);
    }

    await conn.commit();

    return handleSuccessResponse(res, "Successfully updated");

  } catch (err) {
    await conn.rollback();
    return handleErrorResponse(res, err);
  } finally {
    conn.release();
  }
};
