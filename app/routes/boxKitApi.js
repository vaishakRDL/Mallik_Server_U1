const router = require("express").Router();
const boxkit = require("../controllers/boxKitController");

router.get('/getContract', boxkit.getContract);
router.get('/qcStatus', boxkit.getQcStatus);


router.post('/getPart', boxkit.getPart);
router.post('/upload', boxkit.upload);
router.post('/viewFile', boxkit.viewFile);
router.post('/view', boxkit.view);


// Barcode Kitting -> ERP integration (API 1 / API 3 in the integration spec)
router.post('/uploadeddata', boxkit.uploadedData);
router.post('/packingInfoTransfer', boxkit.packingInfoTransfer);


module.exports = router;