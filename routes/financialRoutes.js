// ============================================================
// routes/financialRoutes.js — F10: API REST Financeira
// JUCA GUARANA — GV AUTOMACOES
// ============================================================
// Todos os endpoints requerem autenticacao (authMiddleware aplicado no server.js).
// req.clinicId e req.userId sao garantidos pelo middleware.
// ============================================================

import { Router } from 'express';
import * as financialService from '../services/financialService.js';

const router = Router();

const VALID_CATEGORIES = [
  'salarios', 'aluguel', 'energia', 'agua', 'telefone_internet',
  'material_descartavel', 'impostos', 'marketing', 'software',
  'equipamentos', 'manutencao', 'contabilidade', 'seguros', 'outros'
];

const VALID_RECURRENCES = ['monthly', 'one_time', 'weekly', 'annual'];

// ============================================================
// GET /overview
// ============================================================
router.get('/overview', async function(req, res) {
  try {
    var period = req.query.period || 'month';
    var result = await financialService.getFinancialOverview(req.clinicId, period);
    if (!result.success) return res.status(500).json({ error: result.error });
    res.json(result.data);
  } catch (err) {
    console.error('[FinancialRoutes] GET /overview erro:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ============================================================
// GET /revenue-by-doctor
// ============================================================
router.get('/revenue-by-doctor', async function(req, res) {
  try {
    var period = req.query.period || 'month';
    var result = await financialService.getRevenueByDoctor(req.clinicId, period);
    if (!result.success) return res.status(500).json({ error: result.error });
    res.json(result.data);
  } catch (err) {
    console.error('[FinancialRoutes] GET /revenue-by-doctor erro:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ============================================================
// GET /revenue-timeline
// ============================================================
router.get('/revenue-timeline', async function(req, res) {
  try {
    var months = req.query.months || 6;
    var result = await financialService.getRevenueTimeline(req.clinicId, months);
    if (!result.success) return res.status(500).json({ error: result.error });
    res.json(result.data);
  } catch (err) {
    console.error('[FinancialRoutes] GET /revenue-timeline erro:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ============================================================
// GET /expenses
// ============================================================
router.get('/expenses', async function(req, res) {
  try {
    var month = req.query.month;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'Parametro month obrigatorio no formato YYYY-MM' });
    }
    var result = await financialService.getExpenses(req.clinicId, month);
    if (!result.success) return res.status(500).json({ error: result.error });
    res.json(result.data);
  } catch (err) {
    console.error('[FinancialRoutes] GET /expenses erro:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ============================================================
// POST /expenses
// ============================================================
router.post('/expenses', async function(req, res) {
  try {
    var body = req.body;

    if (!body.category || VALID_CATEGORIES.indexOf(body.category) === -1) {
      return res.status(400).json({ error: 'Categoria invalida' });
    }
    if (!body.amount || parseFloat(body.amount) <= 0) {
      return res.status(400).json({ error: 'Valor deve ser maior que zero' });
    }
    if (!body.reference_month || !/^\d{4}-\d{2}$/.test(body.reference_month)) {
      return res.status(400).json({ error: 'reference_month obrigatorio no formato YYYY-MM' });
    }
    if (body.recurrence && VALID_RECURRENCES.indexOf(body.recurrence) === -1) {
      return res.status(400).json({ error: 'Recorrencia invalida' });
    }

    var result = await financialService.createExpense(req.clinicId, req.userId, body);
    if (!result.success) return res.status(500).json({ error: result.error });
    res.status(201).json(result.data);
  } catch (err) {
    console.error('[FinancialRoutes] POST /expenses erro:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ============================================================
// PUT /expenses/:id
// ============================================================
router.put('/expenses/:id', async function(req, res) {
  try {
    var body = req.body;

    if (body.category && VALID_CATEGORIES.indexOf(body.category) === -1) {
      return res.status(400).json({ error: 'Categoria invalida' });
    }
    if (body.amount !== undefined && parseFloat(body.amount) <= 0) {
      return res.status(400).json({ error: 'Valor deve ser maior que zero' });
    }
    if (body.reference_month && !/^\d{4}-\d{2}$/.test(body.reference_month)) {
      return res.status(400).json({ error: 'reference_month deve ter formato YYYY-MM' });
    }
    if (body.recurrence && VALID_RECURRENCES.indexOf(body.recurrence) === -1) {
      return res.status(400).json({ error: 'Recorrencia invalida' });
    }

    var result = await financialService.updateExpense(req.clinicId, req.params.id, body);
    if (!result.success) return res.status(500).json({ error: result.error });
    res.json(result.data);
  } catch (err) {
    console.error('[FinancialRoutes] PUT /expenses/:id erro:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ============================================================
// DELETE /expenses/:id
// ============================================================
router.delete('/expenses/:id', async function(req, res) {
  try {
    var result = await financialService.deleteExpense(req.clinicId, req.params.id);
    if (!result.success) return res.status(500).json({ error: result.error });
    res.json({ success: true });
  } catch (err) {
    console.error('[FinancialRoutes] DELETE /expenses/:id erro:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ============================================================
// GET /dre
// ============================================================
router.get('/dre', async function(req, res) {
  try {
    var month = req.query.month;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'Parametro month obrigatorio no formato YYYY-MM' });
    }
    var result = await financialService.getDRE(req.clinicId, month);
    if (!result.success) return res.status(500).json({ error: result.error });
    res.json(result.data);
  } catch (err) {
    console.error('[FinancialRoutes] GET /dre erro:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ============================================================
// GET /health-score
// ============================================================
router.get('/health-score', async function(req, res) {
  try {
    var result = await financialService.getHealthScore(req.clinicId);
    if (!result.success) return res.status(500).json({ error: result.error });
    res.json(result.data);
  } catch (err) {
    console.error('[FinancialRoutes] GET /health-score erro:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ============================================================
// GET /config
// ============================================================
router.get('/config', async function(req, res) {
  try {
    var result = await financialService.getFinancialConfig(req.clinicId);
    if (!result.success) return res.status(500).json({ error: result.error });
    res.json(result.data);
  } catch (err) {
    console.error('[FinancialRoutes] GET /config erro:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ============================================================
// PUT /config
// ============================================================
router.put('/config', async function(req, res) {
  try {
    var result = await financialService.updateFinancialConfig(req.clinicId, req.body);
    if (!result.success) return res.status(500).json({ error: result.error });
    res.json(result.data);
  } catch (err) {
    console.error('[FinancialRoutes] PUT /config erro:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

export default router;
