// ============================================================
// services/whatsappConfigHelper.js — Multi-Tenant WhatsApp Config
// JUCA GUARANA — GV AUTOMACOES
// ============================================================
// Helper centralizado que TODOS os servicos de envio WhatsApp devem usar.
// Fallback chain: banco -> env vars -> null (simulacao)
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sb = createClient(supabaseUrl, supabaseKey);

let configCache = {};
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getClinicWhatsAppConfig(clinicId) {
  if (!clinicId) {
    console.warn('[WhatsAppConfig] clinicId nao fornecido — tentando fallback env vars');
    return getEnvFallback();
  }

  const cached = configCache[clinicId];
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached.config;
  }

  try {
    const { data, error } = await sb
      .from('clinic_whatsapp_config')
      .select('phone_number_id, access_token, business_account_id, display_phone, display_name, messaging_tier, daily_limit, verification_status')
      .eq('clinic_id', clinicId)
      .eq('is_active', true)
      .maybeSingle();

    if (error) {
      console.error('[WhatsAppConfig] Erro ao buscar config da clinica ' + clinicId + ':', error.message);
      return getEnvFallback();
    }

    if (data) {
      const config = {
        phone_number_id: data.phone_number_id,
        access_token: data.access_token,
        business_account_id: data.business_account_id,
        display_phone: data.display_phone,
        display_name: data.display_name,
        messaging_tier: data.messaging_tier || 'tier_1',
        daily_limit: data.daily_limit || 250,
        verification_status: data.verification_status,
        source: 'database'
      };
      configCache[clinicId] = { config, timestamp: Date.now() };
      return config;
    }

    console.log('[WhatsAppConfig] Clinica ' + clinicId + ' sem config no banco — usando fallback env vars');
    const fallback = getEnvFallback();
    if (fallback) {
      configCache[clinicId] = { config: fallback, timestamp: Date.now() };
    }
    return fallback;

  } catch (err) {
    console.error('[WhatsAppConfig] Erro inesperado:', err.message);
    return getEnvFallback();
  }
}

function getEnvFallback() {
  // Support both naming conventions
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.META_WA_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  const businessAccountId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || null;

  if (!phoneNumberId || !accessToken) {
    return null;
  }

  return {
    phone_number_id: phoneNumberId,
    access_token: accessToken,
    business_account_id: businessAccountId,
    display_phone: null,
    display_name: 'Fallback (env vars)',
    messaging_tier: 'tier_1',
    daily_limit: 250,
    verification_status: 'pending',
    source: 'env_fallback'
  };
}

export function invalidateCache(clinicId) {
  if (clinicId) {
    delete configCache[clinicId];
  }
}

export function clearAllCache() {
  configCache = {};
}

export async function checkClinicWhatsAppStatus(clinicId) {
  const config = await getClinicWhatsAppConfig(clinicId);
  if (!config) {
    return { configured: false, source: null, message: 'Nenhuma credencial WhatsApp configurada' };
  }
  return {
    configured: true,
    source: config.source,
    display_name: config.display_name,
    display_phone: config.display_phone,
    messaging_tier: config.messaging_tier,
    daily_limit: config.daily_limit,
    verification_status: config.verification_status,
    has_business_account: !!config.business_account_id
  };
}

export function getThrottleConfig(messagingTier) {
  const configs = {
    tier_1: { batchSize: 5,  batchDelayMs: 1000, maxPerSecond: 10 },
    tier_2: { batchSize: 10, batchDelayMs: 600,  maxPerSecond: 20 },
    tier_3: { batchSize: 20, batchDelayMs: 400,  maxPerSecond: 40 },
    tier_4: { batchSize: 30, batchDelayMs: 300,  maxPerSecond: 60 }
  };
  return configs[messagingTier] || configs['tier_1'];
}
