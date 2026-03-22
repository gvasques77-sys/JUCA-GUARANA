// ============================================================
// routes/campaignRoutes.js — F9D: API REST de Campanhas
// JUCA GUARANA — GV AUTOMACOES
// ============================================================
// Todos os endpoints requerem autenticacao (authMiddleware aplicado no server.js).
// req.clinicId e req.userId sao garantidos pelo middleware.
// ============================================================

import { Router } from 'express';
import * as campaignService from '../services/campaignService.js';
import { checkClinicWhatsAppStatus } from '../services/whatsappConfigHelper.js';

const router = Router();

// ============================================================
// GET /whatsapp-status
// ============================================================
router.get('/whatsapp-status', async function(req, res) {
  try {
    const status = await checkClinicWhatsAppStatus(req.clinicId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ configured: false, error: 'Erro ao verificar status' });
  }
});

// ============================================================
// GET /templates
// ============================================================
router.get('/templates', async function(req, res) {
  try {
    const result = await campaignService.fetchMetaTemplates(req.clinicId);
    if (!result.success) {
      return res.status(502).json({ error: result.error, templates: [] });
    }
    res.json({ templates: result.templates, total: result.raw_count });
  } catch (err) {
    console.error('[CampaignRoutes] GET /templates erro:', err);
    res.status(500).json({ error: 'Erro interno ao buscar templates' });
  }
});

// ============================================================
// GET / — Lista campanhas
// ============================================================
router.get('/', async function(req, res) {
  try {
    const options = {
      status: req.query.status || null,
      limit: parseInt(req.query.limit) || 20,
      offset: parseInt(req.query.offset) || 0
    };
    const result = await campaignService.listCampaigns(req.clinicId, options);
    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }
    res.json({ campaigns: result.campaigns });
  } catch (err) {
    console.error('[CampaignRoutes] GET / erro:', err);
    res.status(500).json({ error: 'Erro interno ao listar campanhas' });
  }
});

// ============================================================
// GET /audience-preview
// ============================================================
router.get('/audience-preview', async function(req, res) {
  try {
    const segmentId = req.query.segment_id || null;
    const result = await campaignService.previewAudience(req.clinicId, segmentId);
    res.json({ count: result.count, sample: result.sample, error: result.error || null });
  } catch (err) {
    console.error('[CampaignRoutes] GET /audience-preview erro:', err);
    res.status(500).json({ error: 'Erro ao calcular audiencia' });
  }
});

// ============================================================
// GET /:id — Detalhes de uma campanha
// ============================================================
router.get('/:id', async function(req, res) {
  try {
    const result = await campaignService.getCampaignDetail(req.params.id, req.clinicId);
    if (!result.success) {
      return res.status(404).json({ error: result.error });
    }
    res.json({ campaign: result.campaign, messages: result.messages, metrics: result.metrics });
  } catch (err) {
    console.error('[CampaignRoutes] GET /:id erro:', err);
    res.status(500).json({ error: 'Erro ao buscar campanha' });
  }
});

// ============================================================
// POST / — Criar campanha
// ============================================================
router.post('/', async function(req, res) {
  try {
    const body = req.body;

    if (!body.name || !body.template_name) {
      return res.status(400).json({ error: 'Campos obrigatorios: name, template_name' });
    }
    if (body.name.length > 100) {
      return res.status(400).json({ error: 'Nome da campanha muito longo (max 100 caracteres)' });
    }
    if (body.scheduled_at) {
      const scheduledDate = new Date(body.scheduled_at);
      if (isNaN(scheduledDate.getTime())) {
        return res.status(400).json({ error: 'Data de agendamento invalida' });
      }
      if (scheduledDate <= new Date()) {
        return res.status(400).json({ error: 'Data de agendamento deve ser no futuro' });
      }
    }

    const data = {
      clinic_id: req.clinicId,
      created_by: req.userId,
      name: body.name.trim(),
      description: body.description ? body.description.trim() : null,
      template_name: body.template_name,
      template_language: body.template_language || 'pt_BR',
      template_category: body.template_category || null,
      template_components: body.template_components || [],
      segment_id: body.segment_id || null,
      scheduled_at: body.scheduled_at || null
    };

    const result = await campaignService.createCampaign(data);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.status(201).json({
      campaign: result.campaign,
      recipient_count: result.recipient_count,
      message: 'Campanha criada com ' + result.recipient_count + ' destinatarios'
    });
  } catch (err) {
    console.error('[CampaignRoutes] POST / erro:', err);
    res.status(500).json({ error: 'Erro interno ao criar campanha' });
  }
});

// ============================================================
// POST /:id/send — Disparar envio
// ============================================================
router.post('/:id/send', async function(req, res) {
  try {
    const campaignId = req.params.id;
    const detail = await campaignService.getCampaignDetail(campaignId, req.clinicId);
    if (!detail.success) {
      return res.status(404).json({ error: 'Campanha nao encontrada' });
    }

    const allowed = ['draft', 'scheduled', 'paused'];
    if (allowed.indexOf(detail.campaign.status) === -1) {
      return res.status(400).json({ error: 'Campanha com status "' + detail.campaign.status + '" nao pode ser disparada' });
    }

    res.json({
      message: 'Envio iniciado para ' + detail.campaign.total_recipients + ' destinatarios',
      campaign_id: campaignId,
      status: 'sending'
    });

    campaignService.executeCampaign(campaignId).catch(function(err) {
      console.error('[CampaignRoutes] Erro background executeCampaign:', err);
    });
  } catch (err) {
    console.error('[CampaignRoutes] POST /:id/send erro:', err);
    res.status(500).json({ error: 'Erro ao disparar campanha' });
  }
});

// ============================================================
// DELETE /:id — Cancelar campanha
// ============================================================
router.delete('/:id', async function(req, res) {
  try {
    const result = await campaignService.cancelCampaign(req.params.id, req.clinicId);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ message: 'Campanha cancelada', campaign: result.campaign });
  } catch (err) {
    console.error('[CampaignRoutes] DELETE /:id erro:', err);
    res.status(500).json({ error: 'Erro ao cancelar campanha' });
  }
});

export default router;
