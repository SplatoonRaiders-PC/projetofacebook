const express = require('express');
const feedSugeridoController = require('../controllers/feedSugeridoController');

const router = express.Router();

router.get('/config', feedSugeridoController.config);
router.get('/jobs', feedSugeridoController.listar);
router.post('/jobs', feedSugeridoController.criar);
router.get('/jobs/:id', feedSugeridoController.obter);
router.post('/jobs/:id/escolher', feedSugeridoController.escolher);
router.post('/jobs/:id/cancelar', feedSugeridoController.cancelar);

module.exports = router;
